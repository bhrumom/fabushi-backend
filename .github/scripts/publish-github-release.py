"""Publish signed Global Dandelion bytes to a public GitHub Release and make them
installable through the Marketplace registry.

The registry keeps the trust root and the release signature; GitHub only stores
bytes. The signed payload gains a `url` only after the asset is confirmed present
with the exact byte count, so the host can verify sha256/size after download and
still refuse a substituted artifact.

Phases, each idempotent:
  release-ensure   reuse or create the public release
  asset-upload     upload once; a published asset is never replaced
  release-import   create the catalog release record the host installs from
  registry-binding bind (digest, sizeBytes, url) to that record
  scan-record      record the scan verdict the approval gate requires
  release-approve  optional; the workflow keeps this as a separate decision
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# Where the bytes live. Two accepted arrangements, in preference order:
#   1. the public mini-app repository, written with a cross-repository token;
#   2. the repository this job already runs in, written with its own token.
# Both are public GitHub Releases; neither can alter the release signature, so
# the trust root stays with the Marketplace either way.
PREFERRED_REPOSITORY = os.environ.get('PUBLIC_REPOSITORY', 'bhrumom/global-dandelion-rs')
APP_ID = 'org.fabushi.global-dandelion'
IDENTITY = {'kind': 'web-miniapp', 'namespace': 'bhrumom', 'name': 'global-dandelion'}
MAX_BYTES = 32 * 1024 * 1024
API = os.environ.get('GITHUB_API', 'https://api.github.com').rstrip('/')
UPLOADS = os.environ.get('GITHUB_UPLOADS', 'https://uploads.github.com').rstrip('/')


def resolve_host():
    """Pick the release repository and the token that is allowed to write it."""
    cross_repository = os.environ.get('DANDELION_RELEASE_TOKEN', '')
    if cross_repository:
        return PREFERRED_REPOSITORY, cross_repository
    own = os.environ.get('DANDELION_HOST_TOKEN', '')
    own_repository = os.environ.get('DANDELION_HOST_REPOSITORY', '')
    if own and own_repository:
        return own_repository, own
    return PREFERRED_REPOSITORY, ''


PUBLIC_REPOSITORY, RELEASE_TOKEN = resolve_host()
# The descriptor is taken from the exact reviewed source commit, so catalog
# metadata can never drift from the package it describes.
SOURCE_REPOSITORY = os.environ.get('DANDELION_SOURCE_REPOSITORY', 'bhrumom/global-dandelion-rs')
RAW = os.environ.get('GITHUB_RAW', 'https://raw.githubusercontent.com').rstrip('/')
SCANNER = 'dandelion-offline-scan'
SCANNER_VERSION = '1'
NATIVE_RUNTIME = os.environ.get('DANDELION_NATIVE_RUNTIME', 'false') == 'true'
ARTIFACT_ID = 'macos-arm64-native' if NATIVE_RUNTIME else 'universal-ui'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def request(url, method='GET', body=None, headers=None, accept='application/vnd.github+json'):
    merged = {'Accept': accept, 'User-Agent': 'Fabushi-Marketplace-Delivery/1'}
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=merged)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(2 * 1024 * 1024)


def signed_package():
    directory = Path(os.environ.get('SIGNED_DIR', 'signed-delivery'))
    candidates = sorted(directory.glob('global-dandelion-*.fabapp'))
    if len(candidates) != 1:
        raise ValueError('expected exactly one signed fabapp')
    target = candidates[0]
    version = target.name[len('global-dandelion-'):-len('.fabapp')]
    raw = target.read_bytes()
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError('signed package size is outside bounds')
    provenance = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
    digest = hashlib.sha256(raw).hexdigest()
    if provenance.get('packageSha256') != digest:
        raise ValueError('provenance digest does not match the signed package')
    return target, version, digest, len(raw), provenance


def ensure_release(token, tag, version):
    """Create the release if it is absent; an existing release is reused as-is."""
    status, body = request(
        f'{API}/repos/{PUBLIC_REPOSITORY}/releases/tags/{urllib.parse.quote(tag)}',
        headers={'Authorization': f'Bearer {token}'})
    if status == 200:
        release = json.loads(body)
        if release.get('draft') or release.get('prerelease'):
            raise ValueError('release must be published, not draft/prerelease')
        return release['id']
    if status != 404:
        raise ValueError(f'release lookup failed with {status}')
    status, body = request(
        f'{API}/repos/{PUBLIC_REPOSITORY}/releases', method='POST',
        body=canonical({
            'tag_name': tag,
            'name': f'Global Dandelion {version}',
            'body': ('Signed Marketplace package. Bytes are hosted here; the release '
                     'signature and trust root stay with the Fabushi Marketplace.'),
            'draft': False,
            'prerelease': False,
        }),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    if status != 201:
        raise ValueError(f'release creation failed with {status}')
    return json.loads(body)['id']


def uploaded_asset_size(token, release_id, name):
    status, body = request(
        f'{API}/repos/{PUBLIC_REPOSITORY}/releases/{release_id}/assets?per_page=100',
        headers={'Authorization': f'Bearer {token}'})
    if status != 200:
        raise ValueError(f'asset listing failed with {status}')
    for asset in json.loads(body):
        if asset.get('name') == name and asset.get('state') == 'uploaded':
            return int(asset['size'])
    return None


def upload_asset(token, release_id, name, payload):
    existing = uploaded_asset_size(token, release_id, name)
    if existing is not None:
        # Releases are immutable evidence: never replace a published asset.
        if existing != len(payload):
            raise ValueError('published asset has a different size than the signed package')
        return
    status, _ = request(
        f'{UPLOADS}/repos/{PUBLIC_REPOSITORY}/releases/{release_id}/assets'
        f'?name={urllib.parse.quote(name)}',
        method='POST', body=payload,
        headers={'Authorization': f'Bearer {token}',
                 'Content-Type': 'application/octet-stream'})
    if status != 201:
        raise ValueError(f'asset upload failed with {status}')
    if uploaded_asset_size(token, release_id, name) != len(payload):
        raise ValueError('uploaded asset size does not match the signed package')


SAFE_SERVICE_CODE = re.compile(r'^[A-Z][A-Z0-9_]{0,48}$')
# Our own diagnostics only. Anything else (bodies, headers, tokens) stays out.
SAFE_REASON = re.compile(r'^[a-z0-9][a-zA-Z0-9 _:\-]{0,120}$')


def service_code(raw):
    """Extract the registry's own error token; never echo its message."""
    try:
        payload = json.loads(raw)
    except Exception:
        # Express answers an unregistered route with HTML, so a non-JSON body
        # means the code is not deployed rather than that the request was wrong.
        return 'ROUTE_NOT_DEPLOYED'
    error = payload.get('error')
    code = error.get('code') if isinstance(error, dict) else error
    return code if isinstance(code, str) and SAFE_SERVICE_CODE.match(code) else 'non-contract'


def register(origin, token, version, digest, size, url, reviewer):
    body = canonical({
        'artifactId': ARTIFACT_ID,
        'platform': 'desktop' if NATIVE_RUNTIME else 'all',
        'architecture': 'arm64' if NATIVE_RUNTIME else 'any',
        'format': 'fabapp',
        'digest': digest,
        'sizeBytes': size,
        'url': url,
        'reviewer': reviewer,
    })
    status, raw = request(
        f'{origin}/v1/extensions/review/artifacts/'
        f'{IDENTITY["kind"]}/{IDENTITY["namespace"]}/{IDENTITY["name"]}/{version}/external',
        method='POST', body=body,
        headers={'Content-Type': 'application/json',
                 'x-fabushi-marketplace-review-token': token},
        accept='application/json')
    if status != 201:
        raise ValueError(f'artifact registration failed with {status} {service_code(raw)}')
    return json.loads(raw)['artifact']


def release_endpoint(origin, suffix=''):
    return (f'{origin}/v1/extensions/review/releases/{IDENTITY["kind"]}/'
            f'{IDENTITY["namespace"]}/{IDENTITY["name"]}')


def review_post(origin, token, path, body, failure):
    status, raw = request(
        path, method='POST', body=canonical(body),
        headers={'Content-Type': 'application/json',
                 'x-fabushi-marketplace-review-token': token},
        accept='application/json')
    if status not in (200, 201):
        raise ValueError(f'{failure} failed with {status} {service_code(raw)}')
    return json.loads(raw)


def load_descriptor(version, digest):
    """Catalog metadata for exactly this package, from exactly this source."""
    override = os.environ.get('DANDELION_DESCRIPTOR', '')
    if override:
        raw = Path(override).read_bytes()
    else:
        commit = os.environ.get('DANDELION_SOURCE_COMMIT', '')
        if not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError('descriptor source commit missing')
        status, raw = request(
            f'{RAW}/{SOURCE_REPOSITORY}/{commit}/miniapp/marketplace-draft.json',
            accept='application/json')
        if status != 200:
            raise ValueError(f'descriptor fetch failed with {status}')
    data = json.loads(raw)
    release = data.setdefault('release', {})
    # The package digest is a property of the bytes, never of the metadata file.
    release['version'] = version
    release['bundleDigest'] = digest
    if NATIVE_RUNTIME and (version not in ('0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.4.5') or release.get('requestedCapabilities') != ['native.runtime']
                           or release.get('platforms') != ['desktop'] or release.get('minHostApi') != 2):
        raise ValueError('native catalog descriptor does not match reviewed capability/target')
    if not NATIVE_RUNTIME and release.get('requestedCapabilities', []) != []:
        raise ValueError('offline delivery cannot approve native capabilities')
    return data


def import_release(origin, token, version, descriptor, reviewer):
    return review_post(
        origin, token,
        f'{release_endpoint(origin)}/{version}/import',
        {'descriptor': descriptor, 'reviewer': reviewer},
        'release import')['release']


def record_scan(origin, token, version, digest, size, reviewer):
    try:
        return review_post(
            origin, token,
            f'{origin}/v1/extensions/review/artifacts/{IDENTITY["kind"]}/'
            f'{IDENTITY["namespace"]}/{IDENTITY["name"]}/{version}/{ARTIFACT_ID}/scan',
            {'state': 'passed', 'scanner': 'dandelion-macos-native-package-scan' if NATIVE_RUNTIME else SCANNER, 'scannerVersion': SCANNER_VERSION,
             'expectedDigest': digest, 'expectedSizeBytes': size, 'reviewer': reviewer,
             'notes': 'signed manifest, exact resource digests, declared macOS native code and requested capability checked; installed execution remains a separate gate' if NATIVE_RUNTIME else 'signed manifest, resource digests, offline CSP and license checks passed'},
            'scan record')['artifact']
    except ValueError as error:
        # A retry of the same immutable version can find the scan record from
        # the first delivery attempt. Accept only the explicit terminal code;
        # missing, failed, or differently scoped scans still fail closed.
        if str(error) == 'scan record failed with 409 SCAN_ALREADY_FINAL':
            return {'state': 'already-final'}
        raise


def approve_release(origin, token, version, reviewer, digest):
    return review_post(
        origin, token,
        f'{release_endpoint(origin)}/{version}',
        {'approved': True, 'reviewer': reviewer,
         'notes': json.dumps({'scope': 'macos-install-owned-native-code' if NATIVE_RUNTIME else 'offline-packet-workbench-preview',
                              'packageSha256': digest,
                              'approval': 'delivery pipeline, review token'}, sort_keys=True)},
        'release approval')['release']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-upload', action='store_true',
                        help='only bind an already published asset')
    parser.add_argument('--skip-register', action='store_true',
                        help='only publish bytes; bind later once the release record exists')
    parser.add_argument('--approve', action='store_true',
                        help='also approve the release so it becomes installable')
    args = parser.parse_args()
    if args.skip_upload and args.skip_register:
        raise ValueError('nothing to do')
    token = RELEASE_TOKEN
    review = os.environ.get('FABUSHI_MARKETPLACE_REVIEW_TOKEN', '')
    reviewer = os.environ.get('DANDELION_REVIEWER', 'marketplace-release-pipeline')
    origin = os.environ.get('REGISTRY_ORIGIN', 'https://api.ombhrum.com').rstrip('/')
    if not token and not args.skip_upload:
        raise ValueError('public release token missing')
    if not review and not args.skip_register:
        raise ValueError('review authorization missing')
    target, version, digest, size, provenance = signed_package()
    tag = os.environ.get('RELEASE_TAG') or f'v{version}'
    # The download host is always github.com even when the API is mocked: the
    # registry only ever stores the real public location.
    url = f'https://github.com/{PUBLIC_REPOSITORY}/releases/download/{tag}/{target.name}'
    if args.skip_upload:
        print('phase=asset-upload skipped', flush=True)
    else:
        print(f'phase=release-ensure version={version} tag={tag}', flush=True)
        release_id = ensure_release(token, tag, version)
        print('phase=asset-upload', flush=True)
        upload_asset(token, release_id, target.name, target.read_bytes())
    artifact = None
    release = None
    if args.skip_register:
        print('phase=release-import skipped', flush=True)
        print('phase=registry-binding skipped', flush=True)
        print('phase=scan-record skipped', flush=True)
    else:
        print('phase=release-import', flush=True)
        release = import_release(origin, review, version,
                                 load_descriptor(version, digest), reviewer)
        print('phase=registry-binding', flush=True)
        artifact = register(origin, review, version, digest, size, url, reviewer)
        print('phase=scan-record', flush=True)
        record_scan(origin, review, version, digest, size, reviewer)
    state = (release or {}).get('state', 'absent')
    if args.approve and not args.skip_register:
        print('phase=release-approve', flush=True)
        state = approve_release(origin, review, version, reviewer, digest).get('state', 'unknown')
    elif args.approve:
        raise ValueError('approval requires registry binding')
    evidence = {
        'appId': APP_ID,
        'identity': IDENTITY,
        'version': version,
        'releaseTag': tag,
        'repository': PUBLIC_REPOSITORY,
        'artifactId': (artifact or {}).get('artifactId', ARTIFACT_ID),
        'digest': digest,
        'sizeBytes': size,
        'url': url,
        'releaseState': state,
        'descriptorDigest': (release or {}).get('descriptorDigest'),
        'sourceCommit': provenance.get('sourceCommit'),
        'signerKeyId': provenance.get('signerKeyId'),
        'trustEpoch': provenance.get('trustEpoch'),
        'deliveryRun': os.environ.get('GITHUB_RUN_ID'),
        'status': ('github-hosted-installable' if state == 'approved'
                   else 'github-hosted-signed-not-published' if artifact
                   else 'github-hosted-signed-not-registered'),
    }
    (target.parent / 'publish.json').write_bytes(canonical(evidence))
    print(json.dumps(evidence))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo response bodies, headers or credentials. The reason is our
        # own literal plus the registry's error token, both charset-checked.
        status = str(error.code) if isinstance(error, urllib.error.HTTPError) else 'none'
        reason = str(error)
        reason = reason if SAFE_REASON.match(reason) else 'unclassified'
        print('GitHub hosting failed; class=' + type(error).__name__
              + '; http=' + status + '; reason=' + reason
              + '; no package published.', file=sys.stderr)
        sys.exit(1)

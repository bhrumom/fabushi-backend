"""Validate reviewed preparation and use the existing production manifest signer."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import urllib.request
import urllib.error
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Per-release evidence pins. Defaults keep the 0.1.0 delivery reproducible; every
# later release supplies its own reviewed values instead of editing this file.
SOURCE = os.environ.get('DANDELION_SOURCE_COMMIT', 'fce746baecc6bbd9f4b12d5862d886cf7f72eda5')
ARTIFACT = int(os.environ.get('DANDELION_PREPARATION_ARTIFACT_ID', '11794806976'))
ARCHIVE_DIGEST = os.environ.get(
    'DANDELION_PREPARATION_DIGEST',
    '6089817d720da2697e4b3c3019c626a6978c3b11c4c2282865951066a53df018')
VERSION = os.environ.get('DANDELION_VERSION', '0.1.0')
NATIVE_RUNTIME = os.environ.get('DANDELION_NATIVE_RUNTIME', 'false') == 'true'
KEY_ID = 'fabushi-marketplace-managed-20261013-1'
PUBLIC_KEY = 'VbvgbVxNAeftFYB0l1-NzE2-Gx3d4NQ7hkKiQ0HMpu0'
DOMAIN = b'fabushi.fabapp.manifest.v1\0'
MAX_BYTES = 16 * 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON field')
        result[key] = value
    return result


def parse(data):
    return json.loads(data, object_pairs_hook=unique_object)


def members(data):
    if len(data) > MAX_BYTES:
        raise ValueError('archive too large')
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 256:
            raise ValueError('too many members')
        total = 0
        for item in archive.infolist():
            name = item.filename
            if (not name or not name.isascii() or '\\' in name or '\0' in name
                    or any(part in ('', '.', '..') for part in name.split('/'))
                    or name in result or item.flag_bits & 1
                    or stat.S_ISLNK(item.external_attr >> 16)):
                raise ValueError('unsafe archive member')
            total += item.file_size
            if total > MAX_BYTES:
                raise ValueError('expanded archive too large')
            result[name] = archive.read(item)
    return result


def preparation(data):
    files = members(data)
    manifest = parse(files.pop('manifest.json'))
    if ('signature' in manifest or manifest['appId'] != 'org.fabushi.global-dandelion'
            or manifest['publisherId'] != 'bhrumom' or manifest['version'] != VERSION
            or manifest['requestedCapabilities'] != (['native.runtime'] if NATIVE_RUNTIME else []) or not manifest['offlineCore']
            or manifest['networkPolicy'] != {'mode': 'deny', 'allowedOrigins': []}
            or set(files) != set(manifest['files'])):
        raise ValueError('unexpected package identity/policy/resources')
    for name, item in manifest['files'].items():
        payload = files[name]
        if len(payload) != item['bytes'] or hashlib.sha256(payload).hexdigest() != item['sha256']:
            raise ValueError('resource integrity mismatch')
    if files['BUILD-INFO.txt'].decode().splitlines()[0] != 'source=' + SOURCE:
        raise ValueError('source mismatch')
    if NATIVE_RUNTIME:
        if VERSION not in ('0.4.0', '0.4.1', '0.4.2', '0.4.3') or manifest.get('minHostApi') != 2:
            raise ValueError('unreviewed native version/Host API')
        native = parse(files['native-runtime.json'])
        if (set(native) != {'schema', 'platform', 'architecture', 'entrypoint', 'executables', 'hostCapabilities'}
                or native['schema'] != 'fabushi.native-runtime.v1' or native['platform'] != 'darwin'
                or native['architecture'] != 'arm64' or native['entrypoint'] != 'native/worker.cjs'
                or native['executables'] != ['native/dandelion.bin']
                or native['hostCapabilities'] != ['file-picker', 'confirmation', 'package-update']):
            raise ValueError('unreviewed native runtime declaration')
        binary = files['native/dandelion.bin']
        if binary[:8] != bytes.fromhex('cffaedfe0c000001') or len(binary) < 32:
            raise ValueError('not an arm64 Mach-O executable')
        expected_mime = {'native-runtime.json': 'application/json', 'native/worker.cjs': 'text/javascript',
                         'native/dandelion.bin': 'application/octet-stream', 'native/default.toml': 'text/plain'}
        if any(manifest['files'].get(name, {}).get('mime') != mime for name, mime in expected_mime.items()):
            raise ValueError('native resource MIME mismatch')
        if any((name.startswith('native/') and name not in expected_mime)
               or (record.get('mime') == 'application/octet-stream' and name != 'native/dandelion.bin')
               for name, record in manifest['files'].items()):
            raise ValueError('undeclared native executable/resource')
    elif any(name.startswith('native/') or name == 'native-runtime.json'
             or record.get('mime') == 'application/octet-stream' for name, record in manifest['files'].items()):
        raise ValueError('native code is not authorized for an offline release')
    return manifest, files


def verify_response(unsigned, response):
    trust = response['trust']
    if (trust['keyId'] != KEY_ID or trust['trustEpoch'] != 1
            or trust['algorithm'] != 'Ed25519' or trust['rawPublicKeyBase64URL'] != PUBLIC_KEY):
        raise ValueError('unreviewed signer identity')
    signed = dict(response['manifest'])
    signature = signed.pop('signature')
    if signed != unsigned or signature['algorithm'] != 'Ed25519' or signature['keyId'] != KEY_ID:
        raise ValueError('signed manifest changed')
    key = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(PUBLIC_KEY + '='))
    key.verify(base64.urlsafe_b64decode(signature['value'] + '=='), DOMAIN + canonical(unsigned))
    return response['manifest']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('signer redirect refused')


def main():
    print('phase=preparation-integrity', flush=True)
    if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_REPOSITORY') != 'bhrumom/fabushi-backend':
        raise ValueError('canonical main required')
    raw = Path('preparation.zip').read_bytes()
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_DIGEST:
        raise ValueError('Actions preparation digest mismatch')
    outer = members(raw)
    unsigned, files = preparation(outer['global-dandelion-UNSIGNED.zip'])
    token = os.environ.get('FABUSHI_MARKETPLACE_REVIEW_TOKEN', '')
    if not token:
        raise ValueError('review authorization missing')
    print('phase=production-signer-request', flush=True)
    request = urllib.request.Request(
        'https://api.ombhrum.com/v1/extensions/review/fabapp/sign',
        data=canonical({'manifest': unsigned}), method='POST',
        headers={'Content-Type': 'application/json', 'User-Agent': 'Fabushi-Marketplace-Delivery/1',
                 'x-fabushi-marketplace-review-token': token})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError('signer response too large')
    print('phase=pinned-signature-verification', flush=True)
    signed = verify_response(unsigned, parse(body))
    output = Path('signed-delivery')
    output.mkdir(exist_ok=False)
    target = output / f'global-dandelion-{VERSION}.fabapp'
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_STORED) as bundle:
        for name, payload in [('manifest.json', canonical(signed))] + sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            bundle.writestr(info, payload)
    provenance = {'sourceRepository': 'bhrumom/global-dandelion-rs', 'sourceCommit': SOURCE,
                  'preparationArtifactId': ARTIFACT, 'preparationArchiveSha256': ARCHIVE_DIGEST,
                  'backendCommit': os.environ['GITHUB_SHA'], 'deliveryRun': os.environ['GITHUB_RUN_ID'],
                  'packageSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                  'signerKeyId': KEY_ID, 'trustEpoch': 1, 'status': 'integrity-signed-not-published',
                  'license': 'MIT OR Apache-2.0', 'nativeFeaturesAvailable': False,
                  'nativeRuntimeRequested': NATIVE_RUNTIME}
    (output / 'provenance.json').write_bytes(canonical(provenance))
    print(json.dumps(provenance))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo HTTP error bodies, request headers, credentials or traceback.
        status = str(error.code) if isinstance(error, urllib.error.HTTPError) else 'none'
        service_code = 'unclassified'
        if isinstance(error, urllib.error.HTTPError):
            try:
                code = parse(error.read(4096)).get('error')
                if code in {'REVIEW_AUTH_REQUIRED', 'INVALID_FABAPP_MANIFEST', 'SIGNING_CONFIGURATION_REQUIRED',
                            'INVALID_SIGNING_KEY', 'SIGNATURE_SELF_CHECK_FAILED'}:
                    service_code = code
            except Exception:
                service_code = 'non-contract-http-response'
        print('Protected package delivery failed; class=' + type(error).__name__
              + '; http=' + status + '; service=' + service_code
              + '; no release published.', file=sys.stderr)
        sys.exit(1)

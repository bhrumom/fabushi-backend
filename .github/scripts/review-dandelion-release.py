"""Manually authorized review of one exact, genuinely submitted offline preview."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

DESKTOP_SHA = 'f3466860220f142813786b511b1ede55576fa7ac'
SCAN_SHA = '99438998520a782910c42cdbc04a2ccf16e46e17'
SCAN_RUN = 38453729078
PACKAGE_SHA = 'de10e02115415908f827723457817e51cb4f39aa5ca68798da824fecc483118a'
WASM_SHA = 'fce746baecc6bbd9f4b12d5862d886cf7f72eda5'
KEY = 'fabushi-marketplace-managed-20261013-1'
USER_AGENT = 'Fabushi-Marketplace-Delivery/1'
RUNS = {
    38449598363: 'Rust desktop runtime',
    38449598160: 'Desktop Chat Parity CI',
    38449598196: 'Host catalog Mini App verifier',
    38449598294: 'Isolated Mini App Electron window',
    38449598328: 'Native Mini App management contract',
    38449598178: 'First-party Mini App publisher',
    38449598809: 'Apple ticket validation contract',
    38449588429: 'Package macOS installer from exact source',
}

def gh(path):
    result = subprocess.run(['gh', 'api', path], check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60)
    if len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError('GitHub response too large')
    return result.stdout

def validate_run(run, sha, name):
    if (run.get('head_sha') != sha or run.get('name') != name
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise ValueError('exact-source acceptance missing')

def validate_scan(evidence):
    expected = {'packageSha256': PACKAGE_SHA, 'sizeBytes': 453093,
                'sourceCommit': WASM_SHA, 'keyId': KEY,
                'scope': 'exact-reviewed-offline-workbench',
                'nativeFeaturesAvailable': False, 'scannerCommit': SCAN_SHA,
                'scanRun': str(SCAN_RUN)}
    if any(evidence.get(key) != value for key, value in expected.items()):
        raise ValueError('scan binding mismatch')
    if not {'signature', 'resource-integrity', 'identity-policy', 'offline-csp',
            'wasm', 'license'}.issubset(evidence.get('checks', [])):
        raise ValueError('scan checks incomplete')

def scan_archive(raw, artifact):
    if (artifact.get('expired') is not False
            or artifact.get('name') != 'dandelion-scan-' + SCAN_SHA
            or type(artifact.get('id')) is not int or artifact['id'] <= 0
            or artifact.get('workflow_run', {}).get('id') != SCAN_RUN
            or artifact.get('workflow_run', {}).get('head_sha') != SCAN_SHA
            or artifact.get('size_in_bytes') != len(raw)):
        raise ValueError('unexpected scan artifact')
    if len(raw) > 1024 * 1024 or artifact.get('digest') != 'sha256:' + hashlib.sha256(raw).hexdigest():
        raise ValueError('scan transport digest mismatch')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if archive.namelist() != ['scan-evidence.json']:
            raise ValueError('unexpected scan members')
        info = archive.getinfo('scan-evidence.json')
        if info.file_size > 64 * 1024:
            raise ValueError('scan evidence too large')
        evidence = json.loads(archive.read(info))
    validate_scan(evidence)
    return evidence

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

PROOF_URL = 'https://api.ombhrum.com/v1/extensions/install/web-miniapp/bhrumom/global-dandelion/0.1.0'

def validate_proof(proof):
    descriptor = proof.get('descriptor', {})
    if (proof.get('protocol') != 'fabushi.extension-install-proof.v1'
            or descriptor.get('release', {}).get('bundleDigest') != PACKAGE_SHA
            or descriptor.get('release', {}).get('version') != '0.1.0'
            or descriptor.get('identity', {}) != {
                'kind': 'web-miniapp', 'namespace': 'bhrumom', 'name': 'global-dandelion'}):
        raise ValueError('public approval proof binding mismatch')

def main():
    if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_REPOSITORY') != 'bhrumom/fabushi-backend':
        raise ValueError('canonical protected main required')
    token = os.environ.get('FABUSHI_MARKETPLACE_REVIEW_TOKEN', '')
    if not token:
        raise ValueError('review authorization missing')
    for run_id, name in RUNS.items():
        validate_run(json.loads(gh(f'repos/bhrumom/fabushi-desktop/actions/runs/{run_id}')), DESKTOP_SHA, name)
    validate_run(json.loads(gh(f'repos/bhrumom/fabushi-backend/actions/runs/{SCAN_RUN}')),
                 SCAN_SHA, 'Scan reviewed Global Dandelion candidate')
    artifacts = json.loads(gh(f'repos/bhrumom/fabushi-backend/actions/runs/{SCAN_RUN}/artifacts'))['artifacts']
    if len(artifacts) != 1:
        raise ValueError('unexpected scan artifacts')
    artifact = artifacts[0]
    scan = scan_archive(gh(f"repos/bhrumom/fabushi-backend/actions/artifacts/{artifact['id']}/zip"), artifact)
    body = {'approved': True, 'reviewer': 'protected-offline-preview-release-operator',
            'notes': json.dumps({'scope': 'offline-packet-workbench-preview',
                                'desktopSource': DESKTOP_SHA, 'acceptanceRuns': list(RUNS),
                                'scan': scan, 'humanPeerHardwareAcceptanceClaimed': False,
                                'installedClientAcceptance': 'separate post-approval gate'}, sort_keys=True)}
    request = urllib.request.Request(
        'https://api.ombhrum.com/v1/extensions/review/releases/web-miniapp/bhrumom/global-dandelion/0.1.0',
        data=json.dumps(body, separators=(',', ':')).encode(), method='POST', headers={
            'content-type': 'application/json', 'user-agent': USER_AGENT,
            'x-fabushi-marketplace-review-token': token})
    # Exactly one write; a transport uncertainty requires read-only diagnosis.
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError('review response too large')
    release = json.loads(raw)['release']
    if release.get('state') != 'approved' or release.get('descriptor', {}).get('release', {}).get('bundleDigest') != PACKAGE_SHA:
        raise ValueError('approval binding mismatch')
    proof_request = urllib.request.Request(PROOF_URL, headers={'user-agent': USER_AGENT})
    with urllib.request.build_opener(NoRedirect).open(proof_request, timeout=30) as response:
        public_raw = response.read(1024 * 1024 + 1)
    if len(public_raw) > 1024 * 1024:
        raise ValueError('proof response too large')
    validate_proof(json.loads(public_raw))
    Path('release-review-evidence.json').write_text(json.dumps({
        'state': 'approved', 'packageSha256': PACKAGE_SHA, 'desktopSource': DESKTOP_SHA,
        'scanRun': SCAN_RUN, 'reviewRun': os.environ['GITHUB_RUN_ID'],
        'reviewer': body['reviewer'], 'installedClientAccepted': False,
    }, sort_keys=True), encoding='utf-8')
    print('Exact offline preview approved; installed-client acceptance still required.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        status = getattr(error, 'code', None)
        safe_status = str(status) if type(status) is int and 100 <= status <= 599 else 'unavailable'
        print('Review blocked; class=' + type(error).__name__ + '; HTTP=' + safe_status
              + '; no automatic write retry.', file=sys.stderr)
        sys.exit(1)

"""Narrow exact-candidate scan; never represents general malware certification."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.request
import zipfile
import io

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('deliver-dandelion-package.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)

ARTIFACT = 11797530939
ARCHIVE_SHA = 'b4fb72cfcdec50acd4c4a648f44699813c3b31cbbd0080445a6057fb4578c64e'
PACKAGE_SHA = 'de10e02115415908f827723457817e51cb4f39aa5ca68798da824fecc483118a'
NAME = 'global-dandelion-0.1.0.fabapp'


def validate_package(data):
    files = delivery.members(data)
    signed = delivery.parse(files.pop('manifest.json'))
    unsigned = dict(signed)
    unsigned.pop('signature')
    delivery.verify_response(unsigned, {'manifest': signed, 'trust': {
        'keyId': delivery.KEY_ID, 'trustEpoch': 1, 'algorithm': 'Ed25519',
        'rawPublicKeyBase64URL': delivery.PUBLIC_KEY}})
    temporary = io.BytesIO()
    with zipfile.ZipFile(temporary, 'w') as archive:
        archive.writestr('manifest.json', delivery.canonical(unsigned))
        for name, payload in files.items():
            archive.writestr(name, payload)
    delivery.preparation(temporary.getvalue())
    if unsigned['runtime'] != 'web' or unsigned['packageClass'] != 'catalog':
        raise ValueError('unexpected runtime')
    if any(record['mime'] not in {'text/plain', 'text/html', 'text/css', 'text/javascript', 'application/wasm'}
           for record in unsigned['files'].values()):
        raise ValueError('native or unknown resource')
    html = files['index.html'].decode('utf-8')
    # default-src none also denies omitted frame-src/worker-src.
    for directive in ["default-src 'none'", "connect-src 'none'", "object-src 'none'",
                      "base-uri 'none'", "form-action 'none'", "script-src 'self' 'wasm-unsafe-eval'"]:
        if directive not in html:
            raise ValueError('missing offline CSP')
    if not files['pkg/dandelion_web_adapter_bg.wasm'].startswith(b'\0asm\x01\0\0\0'):
        raise ValueError('missing actual Wasm')
    if b'LicenseRef-Proprietary' not in files['LICENSE.txt']:
        raise ValueError('proprietary license missing')
    return {'packageSha256': hashlib.sha256(data).hexdigest(), 'sizeBytes': len(data),
            'sourceCommit': delivery.SOURCE, 'keyId': delivery.KEY_ID, 'resourceCount': len(files),
            'checks': ['signature', 'resource-integrity', 'identity-policy', 'offline-csp', 'wasm', 'license'],
            'scope': 'exact-reviewed-offline-workbench', 'nativeFeaturesAvailable': False}


def candidate(raw):
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA:
        raise ValueError('signed delivery archive mismatch')
    outer = delivery.members(raw)
    data = outer[NAME]
    if hashlib.sha256(data).hexdigest() != PACKAGE_SHA:
        raise ValueError('signed package mismatch')
    provenance = delivery.parse(outer['provenance.json'])
    if provenance['sourceCommit'] != delivery.SOURCE or provenance['deliveryRun'] != '38366572165':
        raise ValueError('delivery provenance mismatch')
    return validate_package(data)


def main():
    evidence = candidate(Path('signed-delivery.zip').read_bytes())
    if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_REPOSITORY') != 'bhrumom/fabushi-backend':
        raise ValueError('canonical main required')
    token = os.environ.get('FABUSHI_MARKETPLACE_REVIEW_TOKEN', '')
    if not token:
        raise ValueError('review authorization missing')
    evidence['scanRun'] = os.environ['GITHUB_RUN_ID']
    evidence['scannerCommit'] = os.environ['GITHUB_SHA']
    body = {'state': 'passed', 'reviewer': 'protected-candidate-scanner',
            'scanner': 'fabushi-dandelion-pinned-scan', 'scannerVersion': '1.0.0',
            'expectedDigest': PACKAGE_SHA, 'expectedSizeBytes': evidence['sizeBytes'],
            'notes': json.dumps(evidence, sort_keys=True, separators=(',', ':'))}
    request = urllib.request.Request(
        'https://api.ombhrum.com/v1/extensions/review/artifacts/web-miniapp/bhrumom/global-dandelion/0.1.0/desktop-fabapp/scan',
        data=delivery.canonical(body), method='POST', headers={
            'Content-Type': 'application/json', 'User-Agent': 'Fabushi-Marketplace-Delivery/1',
            'x-fabushi-marketplace-review-token': token})
    with urllib.request.build_opener(delivery.NoRedirect).open(request, timeout=30) as response:
        result = response.read(1024 * 1024 + 1)
    if len(result) > 1024 * 1024:
        raise ValueError('response too large')
    artifact = delivery.parse(result)['artifact']
    if artifact['digest'] != PACKAGE_SHA or artifact['scan']['state'] != 'passed':
        raise ValueError('scan binding mismatch')
    Path('scan-evidence.json').write_bytes(delivery.canonical(evidence))
    print('Exact offline candidate scan recorded; no release approved.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Candidate scan failed; class=' + type(error).__name__ + '; no approval issued.', file=sys.stderr)
        sys.exit(1)

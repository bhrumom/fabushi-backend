#!/usr/bin/env python3
"""End-to-end test for publish-github-release.py against a local mock.

No network and no credentials: the GitHub API, its upload host and the registry
are served from one in-process HTTP server, and the script is executed exactly as
the delivery workflow executes it.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import urllib.parse

SCRIPT = Path(__file__).resolve().parent / 'publish-github-release.py'
TAG = 'v0.2.0'
NAME = 'global-dandelion-0.2.0.fabapp'
PAYLOAD = b'PK\x03\x04 signed fabapp bytes ' + b'x' * 4096


class State:
    def __init__(self):
        self.releases = {}
        self.assets = {}
        self.registrations = []
        self.uploaded = {}
        self.release_creations = 0
        # When set, the registry refuses registration with this contract code.
        self.reject_registration = None
        self.release_imports = []
        self.scans = []
        self.approvals = []
        self.release_state = None


def make_handler(state):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def _send(self, status, payload=b''):
            body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get('content-length') or 0)
            return self.rfile.read(length) if length else b''

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path.endswith(f'/releases/tags/{TAG}'):
                if TAG in state.releases:
                    return self._send(200, {'id': state.releases[TAG], 'draft': False, 'prerelease': False})
                return self._send(404, {'message': 'Not Found'})
            if '/releases/' in path and path.endswith('/assets'):
                release_id = int(path.split('/releases/')[1].split('/')[0])
                rows = [{'name': name, 'size': size, 'state': 'uploaded'}
                        for (rid, name), size in state.assets.items() if rid == release_id]
                return self._send(200, rows)
            return self._send(404, {'message': 'Not Found'})

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            body = self._body()
            if parsed.path.endswith('/releases'):
                state.release_creations += 1
                release_id = 100 + state.release_creations
                created = json.loads(body)
                state.releases[created['tag_name']] = release_id
                return self._send(201, {'id': release_id})
            if parsed.path.endswith('/assets'):
                release_id = int(parsed.path.split('/releases/')[1].split('/')[0])
                name = urllib.parse.parse_qs(parsed.query)['name'][0]
                state.assets[(release_id, name)] = len(body)
                state.uploaded[name] = body
                return self._send(201, {'name': name, 'size': len(body), 'state': 'uploaded'})
            if '/v1/extensions/review/' in parsed.path:
                if not self.headers.get('x-fabushi-marketplace-review-token'):
                    return self._send(403, {'error': {'code': 'REVIEW_AUTH_REQUIRED'}})
                if state.reject_registration and '/artifacts/' in parsed.path:
                    return self._send(409, {'success': False, 'error': {
                        'code': state.reject_registration,
                        'message': 'secret detail that must never be echoed'}})
                sent = json.loads(body)
                if parsed.path.endswith('/import'):
                    if state.release_imports and state.release_imports[-1]['descriptor'] != sent['descriptor']:
                        return self._send(409, {'success': False, 'error': {
                            'code': 'RELEASE_CONFLICT', 'message': 'different descriptor'}})
                    state.release_imports.append(sent)
                    state.release_state = 'pending_review'
                    return self._send(201, {'release': {
                        'state': state.release_state,
                        'descriptorDigest': 'f' * 64}})
                if parsed.path.endswith('/scan'):
                    state.scans.append(sent)
                    return self._send(200, {'artifact': {'artifactId': 'universal-ui', 'scan': {'state': 'passed'}}})
                if '/artifacts/' in parsed.path:
                    state.registrations.append(sent)
                    return self._send(201, {'artifact': sent})
                if '/releases/' in parsed.path:
                    state.approvals.append(sent)
                    state.release_state = 'approved' if sent.get('approved') else 'rejected'
                    return self._send(200, {'release': {
                        'state': state.release_state,
                        'descriptorDigest': 'f' * 64}})
            return self._send(404, {'message': 'Not Found'})

    return Handler


def run(state, base, extra_env=None, mutate=None, args=None):
    with tempfile.TemporaryDirectory() as tmp:
        signed = Path(tmp) / 'signed-delivery'
        signed.mkdir()
        package = signed / NAME
        package.write_bytes(PAYLOAD)
        digest = hashlib.sha256(PAYLOAD).hexdigest()
        (signed / 'provenance.json').write_text(json.dumps({
            'packageSha256': digest,
            'sourceCommit': 'c' * 40,
            'signerKeyId': 'fabushi-marketplace-managed-20261013-1',
            'trustEpoch': 1,
        }), encoding='utf-8')
        if mutate:
            mutate(signed, package)
        descriptor = Path(tmp) / 'descriptor.json'
        descriptor.write_text(json.dumps({
            'identity': {'namespace': 'bhrumom', 'name': 'global-dandelion', 'kind': 'web-miniapp'},
            'displayName': 'Global Dandelion',
            'release': {'version': '0.2.0', 'channel': 'stable',
                        'platforms': ['desktop', 'ios', 'android'],
                        'requestedCapabilities': [], 'minHostApi': 1},
            'categories': ['utilities'], 'tags': ['offline'],
        }), encoding='utf-8')
        env = dict(os.environ)
        env.update({
            'SIGNED_DIR': str(signed),
            'DANDELION_RELEASE_TOKEN': 'release-token',
            'DANDELION_DESCRIPTOR': str(descriptor),
            'FABUSHI_MARKETPLACE_REVIEW_TOKEN': 'review-token',
            'GITHUB_API': base,
            'GITHUB_UPLOADS': base,
            'PUBLIC_REPOSITORY': 'acme/global-dandelion',
            'REGISTRY_ORIGIN': base,
            'RELEASE_TAG': TAG,
        })
        env.update(extra_env or {})
        result = subprocess.run([sys.executable, str(SCRIPT), *(args or [])], env=env,
                                capture_output=True, text=True)
        evidence = None
        published = signed / 'publish.json'
        if published.exists():
            evidence = json.loads(published.read_text(encoding='utf-8'))
        return result, evidence, digest


def main():
    state = State()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        # 1. First run: creates the release, uploads, imports the catalog record,
        #    binds the url and records the scan verdict.
        result, evidence, digest = run(state, base)
        assert result.returncode == 0, result.stderr
        assert state.release_creations == 1, state.release_creations
        assert state.uploaded[NAME] == PAYLOAD, 'uploaded bytes differ'
        assert len(state.release_imports) == 1
        imported = state.release_imports[0]['descriptor']
        assert imported['identity'] == {'namespace': 'bhrumom', 'name': 'global-dandelion',
                                        'kind': 'web-miniapp'}
        assert imported['release']['version'] == '0.2.0'
        assert imported['release']['bundleDigest'] == digest, 'descriptor digest must be the package'
        assert imported['release']['platforms'] == ['desktop', 'ios', 'android']
        assert len(state.registrations) == 1
        registration = state.registrations[0]
        assert registration['digest'] == digest
        assert registration['sizeBytes'] == len(PAYLOAD)
        assert registration['format'] == 'fabapp'
        assert registration['artifactId'] == 'universal-ui'
        assert registration['url'] == f'https://github.com/acme/global-dandelion/releases/download/{TAG}/{NAME}'
        assert len(state.scans) == 1
        assert state.scans[0]['expectedDigest'] == digest
        assert state.scans[0]['expectedSizeBytes'] == len(PAYLOAD)
        assert state.scans[0]['state'] == 'passed'
        assert state.approvals == [], 'approval must stay a separate decision'
        assert evidence['digest'] == digest
        assert evidence['url'] == registration['url']
        assert evidence['releaseState'] == 'pending_review'
        assert evidence['status'] == 'github-hosted-signed-not-published'

        # 2. Second run is idempotent: no new release, no second upload.
        result, evidence, _ = run(state, base)
        assert result.returncode == 0, result.stderr
        assert state.release_creations == 1, 'release was recreated'
        assert len(state.registrations) == 2, 'registration should still be attempted'
        assert len(state.release_imports) == 2, 'import should be re-attempted, not skipped'

        # 3. A published asset with a different size is never replaced.
        def shrink(signed, package):
            package.write_bytes(PAYLOAD[:-10])
            digest = hashlib.sha256(PAYLOAD[:-10]).hexdigest()
            (signed / 'provenance.json').write_text(json.dumps({
                'packageSha256': digest, 'sourceCommit': 'c' * 40,
                'signerKeyId': 'fabushi-marketplace-managed-20261013-1', 'trustEpoch': 1,
            }), encoding='utf-8')

        result, _, _ = run(state, base, mutate=shrink)
        assert result.returncode == 1, 'size mismatch must fail'
        assert 'no package published' in result.stderr
        assert state.assets[(state.releases[TAG], NAME)] == len(PAYLOAD), 'asset was replaced'

        # 4. Provenance tampering is refused before any API call.
        def tamper(signed, package):
            (signed / 'provenance.json').write_text(json.dumps({
                'packageSha256': 'd' * 64, 'sourceCommit': 'c' * 40,
                'signerKeyId': 'fabushi-marketplace-managed-20261013-1', 'trustEpoch': 1,
            }), encoding='utf-8')

        before = state.release_creations
        result, _, _ = run(state, base, mutate=tamper)
        assert result.returncode == 1
        assert state.release_creations == before, 'must not touch the API on tampering'

        # 5. Missing review authorization is refused.
        result, _, _ = run(state, base, extra_env={'FABUSHI_MARKETPLACE_REVIEW_TOKEN': ''})
        assert result.returncode == 1

        # 6. Bytes may be published before the registry has a release record.
        before = len(state.registrations)
        before_imports = len(state.release_imports)
        result, evidence, digest = run(state, base, args=['--skip-register'])
        assert result.returncode == 0, result.stderr
        assert len(state.registrations) == before, 'must not register'
        assert len(state.release_imports) == before_imports, 'must not import'
        assert evidence['status'] == 'github-hosted-signed-not-registered'
        assert evidence['releaseState'] == 'absent'
        assert evidence['digest'] == digest
        assert evidence['url'].startswith('https://github.com/acme/global-dandelion/releases/download/')

        # 7. Binding alone is possible once the bytes are already published.
        before_creations = state.release_creations
        result, evidence, digest = run(
            state, base, extra_env={'DANDELION_RELEASE_TOKEN': ''}, args=['--skip-upload'])
        assert result.returncode == 0, result.stderr
        assert state.release_creations == before_creations, 'must not touch the release'
        assert len(state.registrations) == before + 1
        assert state.registrations[-1]['url'] == evidence['url']
        assert evidence['status'] == 'github-hosted-signed-not-published'

        # 8. Both phases skipped is a configuration error, not a silent no-op.
        result, _, _ = run(state, base, args=['--skip-upload', '--skip-register'])
        assert result.returncode == 1

        # 9. With no cross-repository token the job's own public repository hosts
        #    the bytes, so delivery never depends on a stored personal token.
        result, evidence, digest = run(state, base, extra_env={
            'DANDELION_RELEASE_TOKEN': '',
            'DANDELION_HOST_TOKEN': 'job-token',
            'DANDELION_HOST_REPOSITORY': 'bhrumom/fabushi-backend',
        })
        assert result.returncode == 0, result.stderr
        assert evidence['repository'] == 'bhrumom/fabushi-backend'
        assert evidence['url'].startswith(
            'https://github.com/bhrumom/fabushi-backend/releases/download/')
        assert evidence['digest'] == digest
        assert state.registrations[-1]['url'] == evidence['url']

        # 10. No token of either kind is a hard failure, not a silent skip.
        result, _, _ = run(state, base, extra_env={'DANDELION_RELEASE_TOKEN': ''})
        assert result.returncode == 1

        # 11. A registry refusal names its own contract code but never its message.
        state.reject_registration = 'ARTIFACT_DIGEST_CONFLICT'
        try:
            result, _, _ = run(state, base)
        finally:
            state.reject_registration = None
        assert result.returncode == 1
        assert 'reason=artifact registration failed with 409 ARTIFACT_DIGEST_CONFLICT' in result.stderr, result.stderr
        assert 'secret detail' not in result.stderr, 'response body leaked'

        # 12. Approval is opt-in and makes the release installable.
        state.release_state = 'pending_review'
        result, evidence, digest = run(state, base, args=['--approve'])
        assert result.returncode == 0, result.stderr
        assert len(state.approvals) == 1
        assert state.approvals[0]['approved'] is True
        assert evidence['releaseState'] == 'approved'
        assert evidence['status'] == 'github-hosted-installable'

        # 13. Approval cannot be requested without the registry binding.
        result, _, _ = run(state, base, args=['--approve', '--skip-register'])
        assert result.returncode == 1
        assert 'reason=approval requires registry binding' in result.stderr, result.stderr
        print('publish pipeline ok: create, upload, import, register, scan, approve, '
              'idempotent, immutable, phase-split, host-fallback, safe-diagnostics, fail-closed')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()

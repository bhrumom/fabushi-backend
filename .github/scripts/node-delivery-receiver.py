"""Restricted existing-service receiver. Called only by main Actions SSH identity."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/dacheng-ai')
DROPIN = Path('/etc/systemd/system/dacheng-ai-backend.service.d/zz-fabushi-canonical-release.conf')
SIGNER = ROOT / 'marketplace-signing.env'
MAX_TRANSFER = 512 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024
NAMES = ('FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY', 'FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW',
         'FABUSHI_MARKETPLACE_SIGNING_KEY_ID', 'FABUSHI_MARKETPLACE_TRUST_EPOCH', 'FABUSHI_MARKETPLACE_REVIEW_TOKEN')


def command(value):
    match = re.fullmatch(r'deploy ([0-9a-f]{40}) ([0-9a-f]{64})', value)
    if not match:
        raise ValueError('invalid delivery command')
    return match.groups()


def validate_members(items):
    seen = set()
    expanded = 0
    if len(items) > 200000:
        raise ValueError('file count limit')
    for item in items:
        name = item.name
        parts = PurePosixPath(name).parts
        if (not parts or name.startswith('/') or '\\' in name or '\0' in name
                or any(p in ('..', '.') for p in parts) or name in seen
                or parts[0] not in ('src', 'node_modules', 'package.json', 'package-lock.json')
                or not (item.isdir() or item.isfile() or item.issym())):
            raise ValueError('unsafe deployment archive')
        if item.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname))
            if item.linkname.startswith('/') or target.startswith('../') or '\\' in item.linkname:
                raise ValueError('unsafe deployment link')
        seen.add(name)
        expanded += item.size
        if expanded > MAX_EXPANDED:
            raise ValueError('expanded limit')
    if 'src/secure-entry.js' not in seen or 'package.json' not in seen:
        raise ValueError('incomplete prepared runtime')
    return expanded


def configuration(values):
    if set(values) != set(NAMES) or any(not isinstance(v, str) or len(v) > 8192 or '\0' in v for v in values.values()):
        raise ValueError('invalid managed configuration')
    if (values[NAMES[1]] != 'VbvgbVxNAeftFYB0l1-NzE2-Gx3d4NQ7hkKiQ0HMpu0'
            or values[NAMES[2]] != 'fabushi-marketplace-managed-20261013-1' or values[NAMES[3]] != '1'
            or not re.fullmatch(r'[A-Za-z0-9_-]{43}', values[NAMES[4]])):
        raise ValueError('unreviewed managed identity')
    result = []
    for name in NAMES:
        escaped = values[name].replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')
        result.append(name + '="' + escaped + '"')
    return ('\n'.join(result) + '\n').encode()


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=60, **kwargs)
    if result.returncode:
        raise RuntimeError('service operation failed; raw output withheld')
    return result.stdout


def health():
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8788/health', timeout=3) as r:
                if r.status != 200:
                    raise ValueError('health failed')
            with urllib.request.urlopen('http://127.0.0.1:8788/v1/extensions?limit=1', timeout=3) as r:
                body = json.loads(r.read(1024 * 1024))
                if r.status == 200 and isinstance(body, dict):
                    return
        except Exception:
            time.sleep(1)
    raise RuntimeError('service/Registry health failed')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise ValueError('restricted root receiver required')
    sha, expected = command(sys.argv[1])
    request = urllib.request.Request('https://api.github.com/repos/bhrumom/fabushi-backend/commits/main',
                                     headers={'User-Agent': 'Fabushi-Node-Delivery/1'})
    with urllib.request.urlopen(request, timeout=15) as r:
        if json.loads(r.read(1024 * 1024))['sha'] != sha:
            raise ValueError('canonical main moved')
    raw_header = sys.stdin.buffer.readline(32769)
    if len(raw_header) > 32768 or not raw_header.endswith(b'\n'):
        raise ValueError('configuration frame limit')
    values = json.loads(raw_header)
    config = configuration(values)
    public = run(['/usr/bin/openssl', 'pkey', '-pubout', '-outform', 'DER'], input=values[NAMES[0]].encode())
    if public != bytes.fromhex('302a300506032b6570032100') + base64.urlsafe_b64decode(values[NAMES[1]] + '='):
        raise ValueError('managed key mismatch')
    if SIGNER.exists() and SIGNER.read_bytes() != config:
        raise ValueError('existing signer differs; refuse overwrite')
    # This fixed directory is only transfer staging, never active code or data.
    with tempfile.TemporaryDirectory(prefix='fabushi-node-delivery-', dir='/tmp') as staging:
        archive_path = Path(staging) / 'runtime.tar.gz'
        digest = hashlib.sha256()
        total = 0
        with archive_path.open('xb') as output:
            os.chmod(archive_path, 0o600)
            while data := sys.stdin.buffer.read(1024 * 1024):
                total += len(data)
                if total > MAX_TRANSFER:
                    raise ValueError('transfer limit')
                digest.update(data)
                output.write(data)
        if digest.hexdigest() != expected:
            raise ValueError('prepared archive digest mismatch')
        target = ROOT / 'releases' / sha
        if target.exists():
            raise ValueError('immutable release exists; do not overwrite')
        with tarfile.open(archive_path) as archive:
            expanded = validate_members(archive.getmembers())
            database = ROOT / 'data' / 'dacheng-ai.sqlite'
            db_bytes = database.stat().st_size if database.exists() else 0
            usage = shutil.disk_usage(ROOT)
            if usage.free - expanded - db_bytes < max(1024 * 1024 * 1024, usage.total // 20):
                raise ValueError('insufficient recovery space')
            backup = ROOT / 'backups' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + sha[:12])
            backup.mkdir(mode=0o700, parents=True, exist_ok=False)
            if database.exists():
                with sqlite3.connect(database) as source, sqlite3.connect(backup / 'dacheng-ai.sqlite') as destination:
                    source.backup(destination)
            # Preserve the JSON compatibility store independently of SQLite.
            compatibility = ROOT / 'data' / 'miniapps' / 'marketplace-v2.json'
            if compatibility.exists():
                shutil.copy2(compatibility, backup / 'marketplace-v2.json')
            target.mkdir(mode=0o755)
            archive.extractall(target, filter='data')
        if not SIGNER.exists():
            fd = os.open(SIGNER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                output.write(config)
        old = DROPIN.read_bytes() if DROPIN.exists() else None
        DROPIN.parent.mkdir(parents=True, exist_ok=True)
        DROPIN.write_text('[Service]\nWorkingDirectory=' + str(target)
                          + '\nEnvironmentFile=' + str(SIGNER)
                          + '\nExecStart=\nExecStart=/usr/bin/node src/secure-entry.js\n')
        try:
            run(['/usr/bin/systemctl', 'daemon-reload'])
            run(['/usr/bin/systemctl', 'restart', 'dacheng-ai-backend.service'])
            health()
        except Exception:
            if old is None:
                DROPIN.unlink()
            else:
                DROPIN.write_bytes(old)
            run(['/usr/bin/systemctl', 'daemon-reload'])
            run(['/usr/bin/systemctl', 'restart', 'dacheng-ai-backend.service'])
            raise RuntimeError('activation failed; prior service restored; backups retained')
        print(json.dumps({'sourceSha': sha, 'archiveSha256': expected, 'service': 'dacheng-ai-backend',
                          'result': 'deployed', 'backup': str(backup), 'dataPreserved': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Restricted deployment failed: ' + type(error).__name__ + '; no private diagnostic emitted.', file=sys.stderr)
        sys.exit(1)

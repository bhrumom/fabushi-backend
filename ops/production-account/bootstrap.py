"""Ordinary production registration operator. Never prints account credentials or OTPs."""
import base64
import hashlib
import json
import os
import pathlib
import pwd
import re
import secrets
import stat
import sys
import tempfile
import time
import urllib.parse
import urllib.request

BASE = 'https://mahayana-platform.bhrumom.workers.dev'
USERNAME = 'fdn_acceptance_20261015'
EMAIL = 'bhrumom+fabushi-fdn-acceptance-20261015@gmail.com'
DEVICE = 'fdn-production-acceptance-20261015'
ROOT = pathlib.Path('/etc/fabushi/production-acceptance-account')
OTP = pathlib.Path('/home/ubuntu/.fabushi-production-registration/otp')

def save(path, value):
    if path.is_symlink():
        raise ValueError('unsafe state path')
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.account-')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def api(path, data=None, form=False, bearer=None, html=False):
    body = None if data is None else (urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode())
    headers = {'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json'}
    if bearer:
        headers['Authorization'] = 'Bearer ' + bearer
    req = urllib.request.Request(BASE + path, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read(262144)
            return raw.decode() if html else json.loads(raw)
    except Exception:
        raise RuntimeError('canonical Core request failed; private state retained') from None

def read_otp(path, owner):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != owner or st.st_mode & 0o777 != 0o600 or st.st_size > 16:
            raise ValueError('unsafe private OTP file')
        code = os.read(fd, 17).decode('ascii').strip()
        if not re.fullmatch(r'[0-9]{6}', code):
            raise ValueError('invalid private OTP shape')
    finally:
        os.close(fd)
    path.unlink()
    return code

class Operator:
    def __init__(self, root=ROOT, request=api, source='unknown', otp=OTP, owner=None):
        self.root, self.request, self.source, self.otp = root, request, source, otp
        self.owner = os.getuid() if owner is None else owner
        self.pending = root / 'pending.json'
        self.credentials = root / 'credentials.json'

    def metadata(self, data):
        return {k: data[k] for k in ('status', 'username', 'accountId', 'cellId', 'backendSha', 'expiresAt') if k in data}

    def prepare(self):
        if self.credentials.exists():
            return self.metadata(json.loads(self.credentials.read_text()))
        old = json.loads(self.pending.read_text()) if self.pending.exists() else {}
        if old.get('phase') == 'outcome_unknown':
            raise RuntimeError('registration outcome unknown; use reconcile, never re-register')
        if old.get('expiresAt', 0) > time.time() + 30:
            return self.metadata(dict(old, status='awaiting_private_otp'))
        attempt = self.request('/api/auth/browser/start', {'platform': 'web', 'deviceId': DEVICE})
        query = urllib.parse.parse_qs(urllib.parse.urlparse(attempt['loginUrl']).query)
        state = {'username': USERNAME, 'email': EMAIL,
                 'password': old.get('password') or secrets.token_urlsafe(40),
                 'attemptId': attempt['attemptId'], 'ticket': query['ticket'][0],
                 'expiresAt': attempt['expiresAt'], 'phase': 'prepared', 'backendSha': self.source}
        save(self.pending, state)
        result = self.request('/api/auth/browser/register/code',
                              {k: state[k] for k in ('attemptId', 'ticket', 'email')}, form=True)
        if result.get('ok') is not True:
            raise RuntimeError('email submission not accepted')
        state['phase'] = 'awaiting_private_otp'
        save(self.pending, state)
        return self.metadata(dict(state, status='awaiting_private_otp'))

    def finish(self, state):
        session = self.request('/api/auth/login', {'username': USERNAME, 'password': state['password'], 'deviceId': DEVICE})
        user = self.request('/api/auth/user-info', bearer=session['accessToken'])
        account_id = str(user['id'])
        if (not account_id.isdecimal() or account_id in ('22', '197915874789377')
                or str(session['userId']) != account_id or user.get('username') != USERNAME
                or user.get('email', '').lower() != EMAIL or user.get('emailVerified') is not True
                or user.get('role') != 'user' or user.get('isAdmin') is not False
                or user.get('unlimitedUsage') is not False):
            raise RuntimeError('ordinary immutable production subject mismatch')
        digest = hashlib.sha256(b'fabushi-fdn-cell-v1\0' + account_id.encode()).digest()
        cell = 'cell-' + base64.urlsafe_b64encode(digest).decode().rstrip('=')[:32]
        value = {'status': 'created', 'username': USERNAME, 'email': EMAIL, 'password': state['password'],
                 'accountId': account_id, 'cellId': cell, 'backendSha': self.source}
        save(self.root / 'session.json', session)
        save(self.credentials, value)
        self.pending.unlink(missing_ok=True)
        return self.metadata(value)

    def complete(self):
        if self.credentials.exists():
            return self.metadata(json.loads(self.credentials.read_text()))
        state = json.loads(self.pending.read_text())
        if state.get('phase') == 'outcome_unknown':
            return self.finish(state)
        if state['expiresAt'] <= time.time():
            raise RuntimeError('challenge expired; explicitly prepare a fresh challenge')
        code = read_otp(self.otp, self.owner)
        state['phase'] = 'outcome_unknown'
        save(self.pending, state)
        data = {k: state[k] for k in ('attemptId', 'ticket', 'username', 'email', 'password')}
        data.update(verificationCode=code, confirmPassword=state['password'])
        page = self.request('/api/auth/browser/register', data, form=True, html=True)
        if '注册完成，正在返回 Fabushi' not in page:
            # Preserve unknown state; login reconciliation is safe, a new register is not.
            raise RuntimeError('registration not confirmed; private state retained for reconciliation')
        return self.finish(state)

if __name__ == '__main__':
    if os.geteuid() != 0:
        raise SystemExit('root administration required')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o777 != 0o700:
        raise SystemExit('unsafe private operator root')
    source = pathlib.Path(__file__).with_name('BACKEND_SHA').read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{40}', source):
        raise SystemExit('exact source revision required')
    try:
        op = Operator(source=source, owner=pwd.getpwnam('ubuntu').pw_uid)
        mode = sys.argv[1]
        if mode == 'prepare':
            result = op.prepare()
        elif mode in ('complete', 'reconcile'):
            if mode == 'reconcile':
                result = op.finish(json.loads(op.pending.read_text()))
            else:
                result = op.complete()
        else:
            raise ValueError('invalid bootstrap mode')
        print(json.dumps(result))
    except Exception as e:
        # No request/response/OTP/password values in tracebacks or logs.
        raise SystemExit('production bootstrap stopped: ' + type(e).__name__) from None

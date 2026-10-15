import importlib.util
import json
import os
import pathlib
import tempfile
import time
import unittest
spec = importlib.util.spec_from_file_location('bootstrap', pathlib.Path(__file__).with_name('bootstrap.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

class Core:
    def __init__(self):
        self.paths = []
        self.unknown = False
        self.admin = False
    def __call__(self, path, data=None, **kwargs):
        self.paths.append(path)
        if path.endswith('/start'):
            return {'attemptId': 'fixture-attempt', 'loginUrl': 'https://api.ombhrum.com/api/auth/browser/portal?ticket=fixture-ticket', 'expiresAt': time.time()+300}
        if path.endswith('/code'):
            return {'ok': True}
        if path.endswith('/register'):
            if self.unknown:
                raise RuntimeError('synthetic response loss')
            return '注册完成，正在返回 Fabushi'
        if path.endswith('/login'):
            return {'accessToken': 'synthetic-only', 'userId': 10001}
        if path.endswith('/user-info'):
            return {'id': 10001, 'username': b.USERNAME, 'email': b.EMAIL, 'emailVerified': True,
                    'role': 'super_admin' if self.admin else 'user', 'isAdmin': self.admin, 'unlimitedUsage': False}
        raise AssertionError('unexpected canonical route')

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.core = Core()
        self.op = b.Operator(self.root, self.core, 'a'*40, self.root/'otp')
    def tearDown(self):
        self.tmp.cleanup()
    def otp(self, value='012345'):
        self.op.otp.write_text(value)
        self.op.otp.chmod(0o600)
    def test_prepare_reuses_challenge_without_resending(self):
        self.op.prepare(); self.op.prepare()
        self.assertEqual(self.core.paths.count('/api/auth/browser/start'), 1)
        self.assertEqual(self.core.paths.count('/api/auth/browser/register/code'), 1)
        self.assertEqual(self.op.pending.stat().st_mode & 0o777, 0o600)
    def test_complete_persists_private_ordinary_identity_and_removes_otp(self):
        self.op.prepare(); self.otp()
        value = self.op.complete()
        self.assertEqual(value['accountId'], '10001')
        self.assertTrue(value['cellId'].startswith('cell-'))
        self.assertNotIn('password', value)
        self.assertFalse(self.op.otp.exists())
        self.assertFalse(self.op.pending.exists())
        self.assertEqual(self.op.credentials.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root/'session.json').stat().st_mode & 0o777, 0o600)
    def test_response_loss_reconciles_login_without_duplicate_register(self):
        self.op.prepare(); self.otp(); self.core.unknown=True
        with self.assertRaises(RuntimeError): self.op.complete()
        with self.assertRaises(RuntimeError): self.op.prepare()
        self.op.complete()
        self.assertEqual(self.core.paths.count('/api/auth/browser/register'), 1)
    def test_invalid_otp_makes_no_registration_request(self):
        self.op.prepare(); self.otp('012345\nextra')
        with self.assertRaises(ValueError): self.op.complete()
        self.assertNotIn('/api/auth/browser/register', self.core.paths)
    def test_symlink_and_public_otp_file_rejected(self):
        target=self.root/'target'; target.write_text('012345'); target.chmod(0o600)
        self.op.otp.symlink_to(target)
        with self.assertRaises(OSError): b.read_otp(self.op.otp, os.getuid())
        self.op.otp.unlink(); self.otp(); self.op.otp.chmod(0o644)
        with self.assertRaises(ValueError): b.read_otp(self.op.otp, os.getuid())
    def test_privileged_profile_is_not_accepted(self):
        self.op.prepare(); self.otp(); self.core.admin=True
        with self.assertRaises(RuntimeError): self.op.complete()
        self.assertFalse(self.op.credentials.exists())
    def test_expired_challenge_never_registers(self):
        self.op.prepare(); value=json.loads(self.op.pending.read_text()); value['expiresAt']=0; b.save(self.op.pending,value)
        self.otp()
        with self.assertRaises(RuntimeError): self.op.complete()
        self.assertNotIn('/api/auth/browser/register', self.core.paths)

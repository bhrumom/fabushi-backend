import importlib.util
import pathlib
import unittest
spec = importlib.util.spec_from_file_location('relay', pathlib.Path(__file__).with_name('install-relay.py'))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

class RelayPolicyTests(unittest.TestCase):
    def test_only_exact_sender_and_verified_tls_endpoint(self):
        m = relay.render_maps({'username': 'ocid1.user.fixture@ocid1.tenancy.fixture', 'password': 'SyntheticOnlyPassword123'})
        self.assertEqual(m['/etc/postfix/fabushi-relayhosts'], relay.SENDER + ' [' + relay.HOST + ']:587\n')
        self.assertEqual(m['/etc/postfix/fabushi-tls-policy'], relay.ENDPOINT + ' secure match=' + relay.HOST + '\n')
        self.assertNotIn('relayhost', relay.SETTINGS)
        self.assertTrue(all(x.startswith(relay.SENDER + ' ') for p,x in m.items() if 'tls-policy' not in p))

    def test_unknown_existing_maps_rejected(self):
        for key in relay.MAPS:
            with self.subTest(key=key), self.assertRaises(ValueError):
                relay.validate_existing({key: 'hash:/etc/postfix/unrelated'})
        relay.validate_existing({})
        relay.validate_existing(relay.MAPS)

    def test_credential_line_injection_and_extra_fields_rejected(self):
        good = {'username': 'ocid1.user.fixture@ocid1.tenancy.fixture', 'password': 'SyntheticOnlyPassword123'}
        for key, value in [('username', 'user\nsecond@fixture.test'), ('password', 'password\nnew-map'), ('password', 'short')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                relay.render_maps(dict(good, **{key: value}))
        with self.assertRaises(ValueError):
            relay.render_maps(dict(good, extra='forbidden'))

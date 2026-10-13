import base64
import hashlib
import importlib.util
import io
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('deliver-dandelion-package.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


def bundle(items):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for name, data in items:
            archive.writestr(name, data)
    return output.getvalue()


class DeliveryTests(unittest.TestCase):
    def fixture(self):
        files = {'index.html': b'offline', 'BUILD-INFO.txt': ('source=' + delivery.SOURCE + '\n').encode()}
        manifest = {'appId': 'org.fabushi.global-dandelion', 'publisherId': 'bhrumom', 'version': '0.1.0',
                    'requestedCapabilities': [], 'offlineCore': True,
                    'networkPolicy': {'mode': 'deny', 'allowedOrigins': []},
                    'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                              for name, data in files.items()}}
        return manifest, files

    def test_valid_preparation(self):
        manifest, files = self.fixture()
        self.assertEqual(delivery.preparation(bundle([('manifest.json', delivery.canonical(manifest)), *files.items()])), (manifest, files))

    def test_corrupt_extra_source(self):
        for mutation in ['corrupt', 'extra', 'source']:
            manifest, files = self.fixture()
            if mutation == 'corrupt':
                files['index.html'] = b'changed'
            elif mutation == 'extra':
                files['extra.js'] = b'rogue'
            else:
                files['BUILD-INFO.txt'] = b'source=wrong\n'
                manifest['files']['BUILD-INFO.txt'] = {'bytes': 13, 'sha256': hashlib.sha256(files['BUILD-INFO.txt']).hexdigest()}
            with self.assertRaises(ValueError):
                delivery.preparation(bundle([('manifest.json', delivery.canonical(manifest)), *files.items()]))

    def test_unsafe_paths_duplicates(self):
        for name in ['../evil', '/evil', 'x/../evil', 'x\\evil']:
            with self.assertRaises(ValueError):
                delivery.members(bundle([(name, b'x')]))
        with self.assertRaises(ValueError):
            delivery.members(bundle([('x', b'1'), ('x', b'2')]))

    def test_symlink_and_limits(self):
        link = zipfile.ZipInfo('link')
        link.external_attr = 0o120777 << 16
        with self.assertRaises(ValueError):
            delivery.members(bundle([(link, b'target')]))
        with patch.object(delivery, 'MAX_BYTES', 1024):
            with self.assertRaises(ValueError):
                delivery.members(bundle([('x', b'x' * 2048)]))

    def test_duplicate_json(self):
        with self.assertRaises(ValueError):
            delivery.parse('{"a":1,"a":2}')

    def test_signature_and_trust_binding(self):
        key = Ed25519PrivateKey.generate()  # Ephemeral CI-only fixture, never a production identity.
        public = base64.urlsafe_b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode().rstrip('=')
        unsigned, _ = self.fixture()
        signature = base64.urlsafe_b64encode(key.sign(delivery.DOMAIN + delivery.canonical(unsigned))).decode().rstrip('=')
        response = {'manifest': {**unsigned, 'signature': {'algorithm': 'Ed25519', 'keyId': delivery.KEY_ID, 'value': signature}},
                    'trust': {'algorithm': 'Ed25519', 'keyId': delivery.KEY_ID, 'trustEpoch': 1, 'rawPublicKeyBase64URL': public}}
        with patch.object(delivery, 'PUBLIC_KEY', public):
            self.assertEqual(delivery.verify_response(unsigned, response), response['manifest'])
            response['trust']['trustEpoch'] = 2
            with self.assertRaises(ValueError):
                delivery.verify_response(unsigned, response)
            response['trust']['trustEpoch'] = 1
            response['manifest']['version'] = '9.0.0'
            with self.assertRaises(ValueError):
                delivery.verify_response(unsigned, response)


if __name__ == '__main__':
    unittest.main()

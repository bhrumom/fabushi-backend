"""Native permission is explicit; old offline delivery cannot sign hidden code."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('delivery', Path(__file__).with_name('deliver-dandelion-package.py'))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class NativeDeliveryTests(unittest.TestCase):
    def fixture(self, mutate=lambda native, files: None, version="0.4.0"):
        native = {'schema': 'fabushi.native-runtime.v1', 'platform': 'darwin', 'architecture': 'arm64',
                  'entrypoint': 'native/worker.cjs', 'executables': ['native/dandelion.bin'],
                  'hostCapabilities': ['file-picker', 'confirmation', 'package-update']}
        files = {'index.html': b'offline', 'BUILD-INFO.txt': ('source=' + delivery.SOURCE + '\n').encode(),
                 'native/worker.cjs': b'// fixture; not executed', 'native/default.toml': b'[state]\nenabled=false\n',
                 'native/dandelion.bin': bytes.fromhex('cffaedfe0c000001') + b'\0' * 24}
        mutate(native, files)
        files['native-runtime.json'] = delivery.canonical(native)
        mime = {'index.html': 'text/html', 'BUILD-INFO.txt': 'text/plain', 'native/worker.cjs': 'text/javascript',
                'native/default.toml': 'text/plain', 'native/dandelion.bin': 'application/octet-stream',
                'native-runtime.json': 'application/json'}
        manifest = {'appId': 'org.fabushi.global-dandelion', 'publisherId': 'bhrumom', 'version': version,
                    'minHostApi': 2, 'requestedCapabilities': ['native.runtime'], 'offlineCore': True,
                    'networkPolicy': {'mode': 'deny', 'allowedOrigins': []},
                    'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mime': mime.get(name, 'application/octet-stream')}
                              for name, data in files.items()}}
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('manifest.json', delivery.canonical(manifest))
            for name, data in files.items():
                archive.writestr(name, data)
        return output.getvalue()

    def test_explicit_native_mode_accepts_reviewed_target(self):
        with patch.object(delivery, 'NATIVE_RUNTIME', True), patch.object(delivery, 'VERSION', '0.4.0'):
            manifest, files = delivery.preparation(self.fixture())
            self.assertEqual(manifest['requestedCapabilities'], ['native.runtime'])
            self.assertIn('native/dandelion.bin', files)

    def test_globe_update_and_future_version_fence(self):
        for version in ['0.4.1', '0.4.2', '1.0.0']:
            with self.subTest(version=version), patch.object(delivery, 'NATIVE_RUNTIME', True), patch.object(delivery, 'VERSION', version):
                if version == '0.4.1':
                    manifest, _ = delivery.preparation(self.fixture(version=version))
                    self.assertEqual(manifest['version'], version)
                else:
                    with self.assertRaises(ValueError):
                        delivery.preparation(self.fixture(version=version))

    def test_offline_mode_cannot_sign_native_code(self):
        with patch.object(delivery, 'NATIVE_RUNTIME', False), patch.object(delivery, 'VERSION', '0.4.0'):
            with self.assertRaises(ValueError):
                delivery.preparation(self.fixture())

    def test_target_permissions_binary_and_extra_resource_rejected(self):
        for mutation in [lambda n, f: n.update(platform='linux'),
                         lambda n, f: n.update(hostCapabilities=['shell']),
                         lambda n, f: n.update(entrypoint='../worker.cjs'),
                         lambda n, f: f.update({'native/dandelion.bin': b'ELF' + b'\0' * 32}),
                         lambda n, f: f.update({'native/hidden.bin': b'x'})]:
            with self.subTest(mutation=mutation), patch.object(delivery, 'NATIVE_RUNTIME', True), patch.object(delivery, 'VERSION', '0.4.0'):
                with self.assertRaises(ValueError):
                    delivery.preparation(self.fixture(mutation))


if __name__ == '__main__':
    unittest.main()

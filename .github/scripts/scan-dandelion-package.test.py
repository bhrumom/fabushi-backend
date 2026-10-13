import importlib.util
import io
import os
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('scanner', Path(__file__).with_name('scan-dandelion-package.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class CandidateScan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = Path(os.environ['FABUSHI_SIGNED_SCAN_FIXTURE']).read_bytes()
        cls.package = scanner.delivery.members(cls.raw)[scanner.NAME]

    def test_actual_production_signed_candidate(self):
        evidence = scanner.candidate(self.raw)
        self.assertEqual(evidence['packageSha256'], scanner.PACKAGE_SHA)
        self.assertEqual(evidence['resourceCount'], 10)
        self.assertFalse(evidence['nativeFeaturesAvailable'])

    def test_outer_tampering(self):
        with self.assertRaises(ValueError):
            scanner.candidate(self.raw + b'changed')

    def changed(self, update):
        files = scanner.delivery.members(self.package)
        update(files)
        target = io.BytesIO()
        with zipfile.ZipFile(target, 'w') as archive:
            for name, payload in files.items():
                archive.writestr(name, payload)
        return target.getvalue()

    def test_resource_tampering(self):
        with self.assertRaises(ValueError):
            scanner.validate_package(self.changed(lambda files: files.update({'app.js': b'changed'})))

    def test_missing_resource(self):
        with self.assertRaises(ValueError):
            scanner.validate_package(self.changed(lambda files: files.pop('app.js')))

    def test_undeclared_native_resource(self):
        with self.assertRaises(ValueError):
            scanner.validate_package(self.changed(lambda files: files.update({'native.exe': b'MZ'})))

    def test_changed_identity_policy_source_signature(self):
        for field, value in [('publisherId', 'other'), ('networkPolicy', {'mode': 'allow'}),
                             ('version', '0.2.0'), ('appId', 'other')]:
            def update(files):
                manifest = scanner.delivery.parse(files['manifest.json'])
                manifest[field] = value
                files['manifest.json'] = scanner.delivery.canonical(manifest)
            with self.assertRaises(Exception):
                scanner.validate_package(self.changed(update))
        with self.assertRaises(ValueError):
            scanner.validate_package(self.changed(lambda files: files.update({'BUILD-INFO.txt': b'source=other'})))


if __name__ == '__main__':
    unittest.main()

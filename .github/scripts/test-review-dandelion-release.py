import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('review', Path(__file__).with_name('review-dandelion-release.py'))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ReviewGates(unittest.TestCase):
    def evidence(self):
        return {'packageSha256': review.PACKAGE_SHA, 'sizeBytes': 453093,
                'sourceCommit': review.WASM_SHA, 'keyId': review.KEY,
                'scope': 'exact-reviewed-offline-workbench', 'nativeFeaturesAvailable': False,
                'scannerCommit': review.SCAN_SHA, 'scanRun': str(review.SCAN_RUN),
                'checks': ['signature', 'resource-integrity', 'identity-policy', 'offline-csp', 'wasm', 'license']}

    def archive(self, evidence=None, name='scan-evidence.json'):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr(name, json.dumps(evidence or self.evidence()))
        raw = output.getvalue()
        return raw, {'id': 11841258206, 'expired': False,
                     'name': 'dandelion-scan-' + review.SCAN_SHA,
                     'workflow_run': {'id': review.SCAN_RUN, 'head_sha': review.SCAN_SHA},
                     'size_in_bytes': len(raw), 'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()}

    def test_exact_successful_run(self):
        review.validate_run({'head_sha': review.DESKTOP_SHA, 'name': 'fixed',
                             'status': 'completed', 'conclusion': 'success'}, review.DESKTOP_SHA, 'fixed')

    def test_source_name_or_success_cannot_be_substituted(self):
        run = {'head_sha': review.DESKTOP_SHA, 'name': 'fixed', 'status': 'completed', 'conclusion': 'success'}
        for key, value in [('head_sha', '0' * 40), ('name', 'different'),
                           ('status', 'in_progress'), ('conclusion', 'failure')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                review.validate_run({**run, key: value}, review.DESKTOP_SHA, 'fixed')

    def test_exact_scan_archive(self):
        raw, artifact = self.archive()
        self.assertEqual(review.scan_archive(raw, artifact), self.evidence())

    def test_every_provenance_field_required(self):
        for key in self.evidence():
            altered = self.evidence()
            del altered[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                review.validate_scan(altered)

    def test_swapped_source_scope_package_and_native_claim_rejected(self):
        for key, value in [('sourceCommit', '0' * 40), ('packageSha256', '0' * 64),
                           ('scope', 'full-native'), ('nativeFeaturesAvailable', True),
                           ('scannerCommit', '0' * 40), ('keyId', 'other'),
                           ('scanRun', 'other'), ('sizeBytes', 1)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                review.validate_scan({**self.evidence(), key: value})

    def test_all_checks_required(self):
        for check in self.evidence()['checks']:
            altered = self.evidence()
            altered['checks'].remove(check)
            with self.subTest(check=check), self.assertRaises(ValueError):
                review.validate_scan(altered)

    def test_artifact_metadata_cannot_be_swapped(self):
        raw, artifact = self.archive()
        for key, value in [('expired', True), ('name', 'other'), ('id', '../1'),
                           ('size_in_bytes', len(raw) + 1), ('digest', 'sha256:' + '0' * 64),
                           ('workflow_run', {'id': 1, 'head_sha': review.SCAN_SHA})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                review.scan_archive(raw, {**artifact, key: value})

    def test_unexpected_zip_member_rejected(self):
        with self.assertRaises(ValueError):
            review.scan_archive(*self.archive(name='../scan-evidence.json'))

    def test_oversized_evidence_rejected(self):
        with self.assertRaises(ValueError):
            review.scan_archive(*self.archive({**self.evidence(), 'padding': 'x' * 65536}))

    def test_oversized_transport_rejected(self):
        raw, artifact = self.archive()
        raw += b'x' * (1024 * 1024)
        artifact.update(size_in_bytes=len(raw), digest='sha256:' + hashlib.sha256(raw).hexdigest())
        with self.assertRaises(ValueError):
            review.scan_archive(raw, artifact)

    def test_redirect_refused(self):
        self.assertIsNone(review.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.invalid'))

    def test_public_proof_binding(self):
        proof = {'protocol': 'fabushi.extension-install-proof.v1', 'descriptor': {
            'identity': {'kind': 'web-miniapp', 'namespace': 'bhrumom', 'name': 'global-dandelion'},
            'release': {'version': '0.1.0', 'bundleDigest': review.PACKAGE_SHA}}}
        review.validate_proof(proof)
        for key, value in [('version', '0.2.0'), ('bundleDigest', '0' * 64)]:
            altered = copy.deepcopy(proof)
            altered['descriptor']['release'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                review.validate_proof(altered)


if __name__ == '__main__':
    unittest.main()

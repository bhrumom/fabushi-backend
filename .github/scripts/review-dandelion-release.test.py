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


def make_scan_archive(evidence_overrides=None, member_name='scan-evidence.json', raw_payload=None):
    evidence = {
        'packageSha256': review.PACKAGE_SHA,
        'sizeBytes': 453093,
        'sourceCommit': review.WASM_SHA,
        'keyId': review.KEY,
        'scope': 'exact-reviewed-offline-workbench',
        'nativeFeaturesAvailable': False,
        'scannerCommit': review.SCAN_SHA,
        'scanRun': str(review.SCAN_RUN),
        'checks': ['signature', 'resource-integrity', 'identity-policy', 'offline-csp', 'wasm', 'license'],
    }
    if evidence_overrides:
        evidence.update(evidence_overrides)
    payload = raw_payload if raw_payload is not None else json.dumps(evidence).encode('utf-8')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr(member_name, payload)
    raw = buf.getvalue()
    artifact = {
        'id': 1,
        'name': 'dandelion-scan-' + review.SCAN_SHA,
        'expired': False,
        'digest': 'sha256:' + hashlib.sha256(raw).hexdigest(),
    }
    return raw, artifact


class ReleaseReviewContract(unittest.TestCase):
    def test_valid_run_and_scan_archive(self):
        review.validate_run(
            {'head_sha': review.DESKTOP_SHA, 'name': 'Rust desktop runtime', 'status': 'completed', 'conclusion': 'success'},
            review.DESKTOP_SHA,
            'Rust desktop runtime',
        )
        raw, artifact = make_scan_archive()
        parsed = review.scan_archive(raw, artifact)
        self.assertEqual(parsed['packageSha256'], review.PACKAGE_SHA)

    def test_source_or_ci_failure_rejected(self):
        for bad_run in [
            {'head_sha': '0' * 40, 'name': 'Rust desktop runtime', 'status': 'completed', 'conclusion': 'success'},
            {'head_sha': review.DESKTOP_SHA, 'name': 'Other workflow', 'status': 'completed', 'conclusion': 'success'},
            {'head_sha': review.DESKTOP_SHA, 'name': 'Rust desktop runtime', 'status': 'in_progress', 'conclusion': 'success'},
            {'head_sha': review.DESKTOP_SHA, 'name': 'Rust desktop runtime', 'status': 'completed', 'conclusion': 'failure'},
        ]:
            with self.assertRaises(ValueError):
                review.validate_run(bad_run, review.DESKTOP_SHA, 'Rust desktop runtime')

    def test_scan_digest_scope_and_source_swaps_rejected(self):
        for override in [
            {'packageSha256': 'a' * 64},
            {'scope': 'full-native-parity'},
            {'sourceCommit': 'b' * 40},
            {'scannerCommit': 'c' * 40},
            {'nativeFeaturesAvailable': True},
            {'checks': ['signature', 'wasm']},
        ]:
            raw, artifact = make_scan_archive(override)
            with self.assertRaises(ValueError):
                review.scan_archive(raw, artifact)

    def test_unexpected_or_oversized_artifacts_rejected(self):
        raw, artifact = make_scan_archive()
        with self.assertRaises(ValueError):
            review.scan_archive(raw, {**artifact, 'expired': True})
        with self.assertRaises(ValueError):
            review.scan_archive(raw, {**artifact, 'name': 'wrong-artifact'})
        with self.assertRaises(ValueError):
            review.scan_archive(raw + b'tampered', artifact)
        raw_bad_member, artifact_bad_member = make_scan_archive(member_name='extra.json')
        with self.assertRaises(ValueError):
            review.scan_archive(raw_bad_member, artifact_bad_member)
        raw_oversized, artifact_oversized = make_scan_archive(raw_payload=b'x' * (65 * 1024))
        with self.assertRaises(ValueError):
            review.scan_archive(raw_oversized, artifact_oversized)


if __name__ == '__main__':
    unittest.main()

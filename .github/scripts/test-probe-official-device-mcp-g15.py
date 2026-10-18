#!/usr/bin/env python3
"""Regression tests for the exact report-classification code embedded in the G15 probe."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "fdn-network-coordinator" / "probe-official-device-mcp-g15.sh"
MARKER = "python3 - " + chr(34) + "$output" + chr(34) + " <<'PY'\\n"


def load_report_program():
    source = PROBE.read_text(encoding="utf-8")
    if source.count(MARKER) != 1:
        raise AssertionError("expected exactly one inline G15 report classifier")
    tail = source.split(MARKER, 1)[1]
    try:
        program, _ = tail.split("\\nPY\\n", 1)
    except ValueError as error:
        raise AssertionError("G15 report classifier heredoc is not terminated") from error
    return program


REPORT_PROGRAM = load_report_program()
BASE_ENV = {
    "FDN_MCP_BACKEND_SHA": "a" * 40,
    "FDN_MCP_CORE_SHA": "b" * 40,
    "FDN_MCP_ELAPSED_NS": "300000000000",
    "FDN_MCP_DELTA_TICKS": "120",
    "FDN_MCP_CLOCK_TICKS": "100",
    "FDN_MCP_MAX_RSS": str(100 * 1024 * 1024),
    "FDN_MCP_RSS_LIMIT": str(150 * 1024 * 1024),
    "FDN_MCP_MAX_STATE": str(1024 * 1024),
    "FDN_MCP_STATE_LIMIT": str(20 * 1024 * 1024),
    "FDN_MCP_MAX_AUDIT": str(1024 * 1024),
    "FDN_MCP_JOURNAL_BYTES": str(1024 * 1024),
    "FDN_MCP_LOG_LIMIT": str(20 * 1024 * 1024),
    "FDN_MCP_FS_TOTAL": str(10 * 1024 * 1024 * 1024),
    "FDN_MCP_FS_AVAILABLE": str(5 * 1024 * 1024 * 1024),
    "FDN_MCP_FS_RESERVE": str(1024 * 1024 * 1024),
    "FDN_MCP_PRIVACY_SCAN": "pass",
    "FDN_MCP_EGRESS_START": "10",
    "FDN_MCP_EGRESS_END": "10",
    "FDN_MCP_EGRESS_REJECTED": "0",
}


class G15ReportClassification(unittest.TestCase):
    def classify(self, overrides=None):
        env = os.environ.copy()
        env.update(BASE_ENV)
        env.update(overrides or {})
        with tempfile.TemporaryDirectory(prefix="fdn-g15-report-") as directory:
            output = Path(directory) / "report.json"
            result = subprocess.run(
                [sys.executable, "-c", REPORT_PROGRAM, str(output)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertTrue(output.is_file(), result.stdout + result.stderr)
            report = json.loads(output.read_text(encoding="utf-8"))
        return result, report

    def assert_status(self, overrides, expected_status, expected_exit):
        result, report = self.classify(overrides)
        self.assertEqual(result.returncode, expected_exit, result.stdout + result.stderr)
        self.assertEqual(report["status"], expected_status)
        self.assertEqual(report["exitCode"], expected_exit)
        return report

    def test_missing_egress_counter_owner_is_blocked(self):
        report = self.assert_status({
            "FDN_MCP_EGRESS_START": "",
            "FDN_MCP_EGRESS_END": "",
            "FDN_MCP_EGRESS_REJECTED": "",
        }, "BLOCKED_EGRESS_REJECT_COUNTER", 78)
        self.assertIsNone(report["unexpectedWorkerOwnedPacketsRejected"])
        self.assertIsNone(report["egress"]["counterOwner"])
        self.assertFalse(report["egress"]["pass"])

    def test_nonzero_unexpected_worker_owned_packets_rejected_fails(self):
        report = self.assert_status({
            "FDN_MCP_EGRESS_START": "10",
            "FDN_MCP_EGRESS_END": "12",
            "FDN_MCP_EGRESS_REJECTED": "2",
        }, "FAIL", 1)
        self.assertEqual(report["unexpectedWorkerOwnedPacketsRejected"], 2)
        self.assertEqual(report["egress"]["rejectedCount"], 2)
        self.assertFalse(report["egress"]["pass"])

    def test_privacy_scan_failure_fails(self):
        report = self.assert_status({"FDN_MCP_PRIVACY_SCAN": "fail"}, "FAIL", 1)
        self.assertEqual(report["privacy"]["journalSecretScan"], "fail")

    def test_each_resource_budget_overrun_fails(self):
        cases = [
            ("rssBytes", {"FDN_MCP_MAX_RSS": str(150 * 1024 * 1024 + 1)}),
            ("cpuSingleCorePercent", {"FDN_MCP_DELTA_TICKS": "301"}),
            ("stateBytes", {"FDN_MCP_MAX_STATE": str(20 * 1024 * 1024 + 1)}),
            ("auditBytes", {"FDN_MCP_MAX_AUDIT": str(20 * 1024 * 1024 + 1)}),
            ("journalBytes", {"FDN_MCP_JOURNAL_BYTES": str(20 * 1024 * 1024 + 1)}),
            ("diskReserveBytes", {"FDN_MCP_FS_AVAILABLE": str(1024 * 1024 * 1024 - 1)}),
        ]
        for budget, overrides in cases:
            with self.subTest(budget=budget):
                report = self.assert_status(overrides, "FAIL", 1)
                self.assertFalse(report["budgets"][budget]["pass"])

    def test_known_privacy_or_budget_failure_overrides_missing_counter(self):
        no_counter = {
            "FDN_MCP_EGRESS_START": "",
            "FDN_MCP_EGRESS_END": "",
            "FDN_MCP_EGRESS_REJECTED": "",
        }
        cases = [
            {**no_counter, "FDN_MCP_PRIVACY_SCAN": "fail"},
            {**no_counter, "FDN_MCP_MAX_STATE": str(20 * 1024 * 1024 + 1)},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                self.assert_status(overrides, "FAIL", 1)

    def test_zero_rejections_and_all_other_gates_pass_is_pass(self):
        report = self.assert_status({}, "PASS", 0)
        self.assertEqual(report["unexpectedWorkerOwnedPacketsRejected"], 0)
        self.assertEqual(report["egress"]["rejectedCount"], 0)
        self.assertIsNotNone(report["egress"]["counterOwner"])
        self.assertTrue(report["egress"]["pass"])
        self.assertEqual(report["privacy"]["journalSecretScan"], "pass")
        for budget in report["budgets"].values():
            self.assertTrue(budget["pass"], budget)


if __name__ == "__main__":
    unittest.main()

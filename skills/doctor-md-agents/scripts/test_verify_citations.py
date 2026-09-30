#!/usr/bin/env python3
"""Tests for verify_citations.py."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import verify_citations as vc


def write_transcript(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_findings(path, findings):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"findings": findings}), encoding="utf-8")


def run_verify(findings_path, out_dir, **kwargs):
    argv = [str(findings_path), "--out", str(out_dir)]
    for key, value in kwargs.items():
        argv.extend([f"--{key.replace('_', '-')}", str(value)])
    vc.main(argv)
    return json.loads((Path(out_dir) / "findings.verified.json").read_text())


class WhitespaceFoldingTests(unittest.TestCase):
    def test_quote_matching_only_after_whitespace_folding_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(
                transcript,
                "[user] Please remember:   always   use pnpm\nfor  the  frontend  build.\n",
            )
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "violated",
                 "class": "non-compliance", "quote": "always use pnpm\n   for the   frontend build.",
                 "reason": "the rule was ignored", "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            self.assertTrue(report["findings"][0]["verified"])
            self.assertIsNone(report["findings"][0]["reason_code"])

    def test_paraphrase_does_not_verify(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[user] Reminder: always use pnpm for the frontend build.\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "violated",
                 "class": "non-compliance",
                 "quote": "the agent should always prefer pnpm instead of npm here",
                 "reason": "paraphrased, not quoted", "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            self.assertFalse(report["findings"][0]["verified"])
            self.assertEqual(report["findings"][0]["reason_code"], "not_found")

    def test_case_difference_does_not_verify(self):
        # Explicit assertion that the check is case-sensitive by design.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[user] reminder: always use pnpm here for the build.\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "violated",
                 "class": "non-compliance", "quote": "ALWAYS USE PNPM HERE",
                 "reason": "case differs from transcript", "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            finding = report["findings"][0]
            self.assertFalse(finding["verified"])
            self.assertEqual(finding["reason_code"], "not_found")
            # Prove the ONLY thing wrong is case: the lowercase form does verify.
            self.assertIn(
                vc.fold_whitespace("always use pnpm here"),
                vc.fold_whitespace(transcript.read_text(encoding="utf-8")),
            )


class ReasonCodeTests(unittest.TestCase):
    def test_too_short_quote_gets_its_own_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[user] Always use pnpm here.\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "followed",
                 "class": "none", "quote": "pnpm", "reason": "too short to prove anything",
                 "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            finding = report["findings"][0]
            self.assertFalse(finding["verified"])
            self.assertEqual(finding["reason_code"], "quote_too_short")

    def test_missing_quote_field_gets_quote_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[user] Always use pnpm here for the frontend.\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "followed",
                 "class": "none", "quote": "", "reason": "no citation given", "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            self.assertEqual(report["findings"][0]["reason_code"], "quote_missing")

    def test_missing_transcript_yields_transcript_unreadable_not_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            missing_transcript = tmp / "does-not-exist.md"
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(missing_transcript), "label": "violated",
                 "class": "non-compliance", "quote": "always use pnpm here for the build",
                 "reason": "transcript file is gone", "session_id": "s1"},
            ])
            report = run_verify(findings_path, tmp / "out")
            finding = report["findings"][0]
            self.assertFalse(finding["verified"])
            self.assertEqual(finding["reason_code"], "transcript_unreadable")
            self.assertEqual(report["stats"]["by_reason_code"]["transcript_unreadable"], 1)
            self.assertEqual(report["stats"]["by_reason_code"]["not_found"], 0)


class CachingTests(unittest.TestCase):
    def test_shared_transcript_is_read_from_disk_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "shared.md"
            write_transcript(transcript, "[user] Always use pnpm for the frontend build, please.\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "followed",
                 "class": "none", "quote": "Always use pnpm for the frontend build",
                 "reason": "first citation", "session_id": "s1"},
                {"rule_id": "r2", "transcript_path": str(transcript), "label": "violated",
                 "class": "non-compliance", "quote": "for the frontend build, please",
                 "reason": "second citation, same transcript", "session_id": "s1"},
            ])
            with mock.patch.object(vc, "load_transcript_text", wraps=vc.load_transcript_text) as spy:
                report = run_verify(findings_path, tmp / "out")
            self.assertEqual(spy.call_count, 1)
            self.assertTrue(all(f["verified"] for f in report["findings"]))
            self.assertEqual(report["stats"]["by_transcript"][str(transcript)]["total"], 2)


class OptionalTriggerFieldTests(unittest.TestCase):
    """scorers/adherence.md gains an optional `trigger` field per finding
    (what the session was doing when the rule applied -- structure.md's raw
    material for writing a condition). verify_citations.py does not verify
    it like `quote`; it must pass it through untouched."""

    def test_trigger_field_passes_through_unverified_and_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[assistant] edited backend/analysis/parser_4g.py\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "followed",
                 "class": "none", "quote": "edited backend/analysis/parser_4g.py",
                 "reason": "followed the rule while touching that file",
                 "trigger": "editing backend/analysis/parser_4g.py"},
            ])
            report = run_verify(findings_path, tmp / "out")
            self.assertEqual(len(report["findings"]), 1)
            finding = report["findings"][0]
            self.assertTrue(finding["verified"])
            self.assertEqual(finding["trigger"], "editing backend/analysis/parser_4g.py")

    def test_finding_without_trigger_field_still_verifies(self):
        # trigger is optional -- its absence must not change anything.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            transcript = tmp / "t1.md"
            write_transcript(transcript, "[assistant] ran pnpm install\n")
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(transcript), "label": "followed",
                 "class": "none", "quote": "ran pnpm install", "reason": "used pnpm"},
            ])
            report = run_verify(findings_path, tmp / "out")
            self.assertTrue(report["findings"][0]["verified"])
            self.assertNotIn("trigger", report["findings"][0])


class MalformedInputTests(unittest.TestCase):
    def test_invalid_json_exits_non_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            findings_path = tmp / "findings.json"
            findings_path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(SystemExit) as ctx:
                vc.main([str(findings_path), "--out", str(tmp / "out")])
            self.assertNotEqual(ctx.exception.code, 0)

    def test_missing_findings_key_exits_non_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            findings_path = tmp / "findings.json"
            findings_path.write_text(json.dumps({"nope": []}), encoding="utf-8")
            with self.assertRaises(SystemExit) as ctx:
                vc.main([str(findings_path), "--out", str(tmp / "out")])
            self.assertNotEqual(ctx.exception.code, 0)

    def test_verification_failures_still_exit_zero(self):
        # Failing verification is data, not a script error -- main() must
        # not raise SystemExit at all on a structurally valid input file.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            findings_path = tmp / "findings.json"
            write_findings(findings_path, [
                {"rule_id": "r1", "transcript_path": str(tmp / "missing.md"), "label": "violated",
                 "class": "non-compliance", "quote": "this quote will not verify at all",
                 "reason": "bad citation", "session_id": "s1"},
            ])
            try:
                vc.main([str(findings_path), "--out", str(tmp / "out")])
            except SystemExit as exc:
                self.fail(f"main() exited with {exc.code} on a merely-unverified finding")


if __name__ == "__main__":
    unittest.main()

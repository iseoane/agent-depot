#!/usr/bin/env python3
"""Tests for render_report.py."""

import json
import re
import tempfile
import unittest
from pathlib import Path

import render_report as rr


def minimal_report(**overrides):
    report = {
        "title": "Agent Instructions Report",
        "generated_at": "2026-09-22T00:00:00Z",
        "harness": "claude",
        "scope": "reports_savesearch",
        "windows": {"corrections_days": 90, "adherence_days": 45},
        "stats": {
            "files": 1, "rules": 1, "est_tokens": 100,
            "sessions_scanned": 10, "sessions_judged": 5,
            "corrections_found": 2, "corrections_dropped_as_machine": 0,
            "rules_without_evidence": 1,
            "findings_total": 0, "findings_unverified": 0,
        },
        "files": [
            {"label": "project:CLAUDE.md", "path": "/repo/CLAUDE.md", "scope": "project",
             "rules": 1, "est_tokens": 100,
             "verdicts": {"keep": 0, "improve": 1, "drop": 0, "unknown": 0}},
        ],
        "top_findings": ["Something notable."],
        "rules": [
            {"id": "project:CLAUDE.md#7", "file_label": "project:CLAUDE.md", "section": "Rules",
             "title": "Use pnpm", "line": 7, "est_tokens": 100,
             "applicable_sessions": 3, "judged_sessions": 5, "adherence": "mixed",
             "classes": {"harm": 0, "non-compliance": 2, "irrelevant": 0},
             "corrections": 2, "verdict": "improve",
             "rationale": "Corrections on its subject despite the rule existing.",
             "evidence": [{"session_id": "session-1", "class": "non-compliance",
                           "quote": "used npm install here", "reason": "ignored the rule"}],
             "proposed_path": None, "diff": None},
        ],
        "missing_rules": [],
        "notes": ["Corrections come from sessions_scanned; adherence from sessions_judged."],
    }
    report.update(overrides)
    return report


class RenderTests(unittest.TestCase):
    def test_renders_minimal_report_without_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(minimal_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("<html", out)
            self.assertIn("Use pnpm", out)

    def test_script_tag_in_rationale_and_title_is_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["rationale"] = "<script>alert(1)</script>"
            report["rules"][0]["title"] = "<script>alert(1)</script>"
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("<script>alert(1)</script>", out)
            self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)

    def test_missing_optional_fields_do_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["diff"] = None
            report["rules"][0]["proposed_path"] = None
            report["missing_rules"] = []
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out_path = Path(tmp) / "report.html"
            self.assertTrue(out_path.exists())
            self.assertIn("No missing-rule candidates", out_path.read_text(encoding="utf-8"))

    def test_out_flag_writes_to_custom_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(minimal_report()), encoding="utf-8")
            custom_out = Path(tmp) / "nested" / "custom.html"
            rr.main([str(report_path), "--out", str(custom_out)])
            self.assertTrue(custom_out.exists())

    def test_proposed_diff_is_rendered_with_line_classes(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["diff"] = "--- a\n+++ b\n@@ -1 +1 @@\n-old line\n+new line\n"
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("diff-add", out)
            self.assertIn("diff-del", out)

    def test_no_evidence_block_reports_token_share(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["adherence"] = "insufficient_evidence"
            report["rules"][0]["corrections"] = 0
            report["rules"][0]["applicable_sessions"] = 0
            report["rules"][0]["evidence"] = []
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("No evidence", out)


class NewFieldsTests(unittest.TestCase):
    def test_new_stats_fields_render(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["stats"]["corrections_dropped_as_machine"] = 686
            report["stats"]["findings_total"] = 40
            report["stats"]["findings_unverified"] = 3
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("686", out)
            self.assertIn("37", out)  # findings_verified = 40 - 3
            self.assertIn("40", out)

    def test_harm_rule_marked_differently_than_noncompliance_only_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            harm_rule = dict(report["rules"][0])
            harm_rule["id"] = "project:CLAUDE.md#20"
            harm_rule["title"] = "Always run the slow linter"
            harm_rule["classes"] = {"harm": 2, "non-compliance": 0, "irrelevant": 0}
            harm_rule["evidence"] = [
                {"session_id": "session-9", "class": "harm",
                 "quote": "following this rule sent the fix down the wrong path",
                 "reason": "contradicted the repo's own tooling"},
            ]
            noncompliance_rule = dict(report["rules"][0])
            noncompliance_rule["id"] = "project:CLAUDE.md#7"
            report["rules"] = [harm_rule, noncompliance_rule]
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("has-harm", out)
            self.assertIn('badge drop" title="harm', out)
            self.assertIn('badge improve" title="non-compliance', out)
            # The non-compliance-only row must NOT be marked has-harm.
            harm_row_start = out.index("Always run the slow linter")
            noncompliance_row_start = out.index("Use pnpm")
            self.assertIn("has-harm", out[max(0, harm_row_start - 400):harm_row_start])
            self.assertNotIn("has-harm", out[max(0, noncompliance_row_start - 400):noncompliance_row_start])

    def test_legacy_string_array_evidence_still_renders(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["evidence"] = ["session-1", "session-2"]
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("session-1", out)
            self.assertIn("session-2", out)

    def test_findings_unverified_surfaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["stats"]["findings_total"] = 10
            report["stats"]["findings_unverified"] = 4
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("failed quote verification", out)

    def test_evidence_quote_is_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["evidence"] = [
                {"session_id": "session-1", "class": "non-compliance",
                 "quote": "<script>alert('evidence')</script>", "reason": "an injected quote"},
            ]
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("<script>alert('evidence')</script>", out)
            self.assertIn("&lt;script&gt;alert(&#x27;evidence&#x27;)&lt;/script&gt;", out)

    def test_unjudged_rule_with_no_evidence_is_not_marked_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["adherence"] = "insufficient_evidence"
            report["rules"][0]["applicable_sessions"] = 0
            report["rules"][0]["evidence"] = []
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("evidence unverified", out)


class CardLayoutTests(unittest.TestCase):
    """The rules table (9 columns, prose crammed into a numeric grid) was
    replaced with a card-per-rule layout. These tests guard the specific
    failure mode that forced the rewrite: a long unbroken token widening
    its container, and the table markup / per-column sort UI actually
    being gone rather than just unused."""

    def test_long_unbroken_token_in_title_has_a_wrapping_css_rule_applied(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            long_token = "a" * 200  # one unbroken token -- no spaces to wrap on
            report["rules"][0]["title"] = long_token
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")

            # The CSS rule must exist and be scoped to .rule-title specifically
            # (not just present somewhere on the page).
            css_rule = re.search(r"\.rule-title\s*\{[^}]*overflow-wrap:\s*anywhere", out)
            self.assertIsNotNone(
                css_rule, ".rule-title must have an overflow-wrap: anywhere rule"
            )
            # And the rendered title element for this rule actually carries
            # that class, so the rule is applied, not just declared.
            self.assertIn(f'<div class="rule-title">{long_token}', out)

    def test_sort_toolbar_renders_one_button_per_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(minimal_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertEqual(out.count('data-key="tokens"'), 1)
            self.assertEqual(out.count('data-key="sessions"'), 1)
            self.assertEqual(out.count('data-key="verdict"'), 1)
            self.assertIn(">coste<", out)
            self.assertIn(">sesiones<", out)
            self.assertIn(">veredicto<", out)

    def test_no_table_markup_remains(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(minimal_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("<table", out)
            self.assertNotIn("<tr", out)
            self.assertNotIn("<td", out)
            self.assertIn("rule-card", out)

    def test_rule_cards_stack_in_a_single_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(minimal_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            container_rule = re.search(r"\.rule-cards\s*\{([^}]*)\}", out)
            self.assertIsNotNone(container_rule)
            self.assertNotIn("grid-template-columns", container_rule.group(1))

    def test_metrics_and_rationale_render_outside_any_table_cell(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            report["rules"][0]["rationale"] = "A full sentence that must read as prose, not a ribbon."
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn(
                '<p class="rule-rationale">A full sentence that must read as prose, not a ribbon.</p>',
                out,
            )
            self.assertIn("rule-metrics", out)


class StructureSectionTests(unittest.TestCase):
    """report.json's optional `structure` section (Step 5b's restructure
    proposal): one entry per file, each with its blocks (condition -> rule
    ids -> basis) and a per-file estimated-condition count."""

    def structured_report(self):
        report = minimal_report()
        report["structure"] = [
            {
                "file_label": "project:CLAUDE.md",
                "proposed_path": "proposed/project:CLAUDE.md/RESTRUCTURED.md",
                "diff_path": "proposed/project:CLAUDE.md/RESTRUCTURED.diff",
                "bare": 5,
                "wrapped": 12,
                "estimated_conditions": 3,
                "blocks": [
                    {
                        "condition": "editing backend Celery workers",
                        "rule_ids": ["project:CLAUDE.md#40", "project:CLAUDE.md#41"],
                        "basis": "measured",
                        "sessions": ["session-1", "session-2"],
                    },
                    {
                        "condition": "changing the xlsx dependency",
                        "rule_ids": ["project:CLAUDE.md#88"],
                        "basis": "estimated",
                        "sessions": [],
                    },
                ],
            }
        ]
        return report

    def test_structure_section_renders_condition_and_rule_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(self.structured_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertIn("editing backend Celery workers", out)
            self.assertIn("project:CLAUDE.md#40", out)
            self.assertIn("estimated", out)
            self.assertIn("measured", out)

    def test_structure_section_appears_after_rules_and_before_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(self.structured_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            rules_idx = out.index("Rules by file")
            structure_idx = out.index("editing backend Celery workers")
            missing_idx = out.index("Missing-rule candidates")
            self.assertLess(rules_idx, structure_idx)
            self.assertLess(structure_idx, missing_idx)

    def test_structure_condition_is_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = self.structured_report()
            report["structure"][0]["blocks"][0]["condition"] = "<script>alert(1)</script>"
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("<script>alert(1)</script>", out)
            self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", out)

    def test_no_table_markup_remains_with_structure_present(self):
        # The card-layout guard (test_no_table_markup_remains) must still
        # hold once a real structure section is rendered alongside it.
        with tempfile.TemporaryDirectory() as tmp:
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(self.structured_report()), encoding="utf-8")
            rr.main([str(report_path)])
            out = (Path(tmp) / "report.html").read_text(encoding="utf-8")
            self.assertNotIn("<table", out)
            self.assertNotIn("<tr", out)
            self.assertNotIn("<td", out)

    def test_missing_structure_key_still_renders_backward_compat(self):
        # A report.json produced before T4 has no "structure" key at all.
        # render_report.py must not crash and must not show the section.
        with tempfile.TemporaryDirectory() as tmp:
            report = minimal_report()
            self.assertNotIn("structure", report)
            report_path = Path(tmp) / "report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            rr.main([str(report_path)])
            out_path = Path(tmp) / "report.html"
            self.assertTrue(out_path.exists())
            out = out_path.read_text(encoding="utf-8")
            self.assertIn("<html", out)
            self.assertNotIn("Proposed restructure", out)


if __name__ == "__main__":
    unittest.main()

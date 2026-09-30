#!/usr/bin/env python3
"""Tests for detect_machine_sessions.py."""

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import detect_machine_sessions as dms


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_claude_session(claude_home, project, session_id, user_texts, extra_record=None):
    """Write a minimal Claude Code JSONL session with one user turn per
    entry in `user_texts`, each followed by a matching assistant reply so
    the session looks like a normal back-and-forth."""
    project_dir = Path(claude_home) / "projects" / project
    project_dir.mkdir(parents=True, exist_ok=True)
    path = project_dir / f"{session_id}.jsonl"
    lines = []
    for text in user_texts:
        lines.append({
            "type": "user", "sessionId": session_id, "cwd": "/repo", "timestamp": now_iso(),
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        })
        lines.append({
            "type": "assistant", "sessionId": session_id, "cwd": "/repo", "timestamp": now_iso(),
            "message": {"role": "assistant", "id": f"{session_id}-{len(lines)}",
                        "content": [{"type": "text", "text": "ok, working on it"}]},
        })
    if extra_record:
        lines.append(extra_record)
    path.write_text("\n".join(json.dumps(line) for line in lines), encoding="utf-8")
    return path


class LongFirstTurnTests(unittest.TestCase):
    def test_long_first_turn_is_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            write_claude_session(claude_home, "proj", "s-long", ["x" * 5000])

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, _templates, stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(stats["flagged_long_first_turn"], 1)
            keys = [f["session_key"] for f in flagged]
            self.assertIn("claude:s-long", keys)
            entry = next(f for f in flagged if f["session_key"] == "claude:s-long")
            self.assertIn("long_first_turn", entry["reasons"])

    def test_short_first_turn_is_not_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            write_claude_session(claude_home, "proj", "s-short", ["please fix the login bug"])

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, _templates, _stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(flagged, [])


class TemplateDetectionTests(unittest.TestCase):
    def test_same_prefix_in_three_distinct_sessions_is_flagged_as_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            template_text = "Score this transcript against the efficiency rubric and report a label."
            for i in range(3):
                write_claude_session(claude_home, "proj", f"s{i}", [template_text])
            write_claude_session(claude_home, "proj", "s-oneoff", ["completely unrelated one-off request"])

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, dropped_templates, stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(stats["flagged_templated"], 3)
            flagged_keys = {f["session_key"] for f in flagged}
            self.assertEqual(flagged_keys, {"claude:s0", "claude:s1", "claude:s2"})
            self.assertNotIn("claude:s-oneoff", flagged_keys)
            self.assertEqual(len(dropped_templates), 1)
            self.assertEqual(dropped_templates[0]["sessions"], 3)

    def test_same_text_repeated_in_one_session_is_not_a_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            repeated = "please continue with the next step"
            write_claude_session(claude_home, "proj", "s-repeat", [repeated, repeated, repeated])

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, dropped_templates, stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(stats["flagged_templated"], 0)
            self.assertEqual(dropped_templates, [])
            self.assertEqual(flagged, [])


class SentinelTests(unittest.TestCase):
    def test_session_carrying_sentinel_is_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            write_claude_session(
                claude_home, "proj", "s-self",
                [dms.MACHINE_SESSION_SENTINEL + "\nScore this transcript."],
            )

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, _templates, stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(stats["flagged_self_session_sentinel"], 1)
            entry = next(f for f in flagged if f["session_key"] == "claude:s-self")
            self.assertIn("self_session_sentinel", entry["reasons"])

    def test_session_without_sentinel_is_not_flagged_for_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            write_claude_session(claude_home, "proj", "s-normal", ["a perfectly normal human request"])

            records = dms.collect_candidates(
                {"claude_home": claude_home, "codex_home": Path(tmp) / "nope",
                 "pi_home": Path(tmp) / "nope", "grok_home": Path(tmp) / "nope",
                 "zcode_home": Path(tmp) / "nope"},
                datetime.now(timezone.utc).replace(year=2000),
            )
            flagged, _templates, stats = dms.flag_sessions(records, 1200, 3, 160)

            self.assertEqual(stats["flagged_self_session_sentinel"], 0)
            self.assertEqual(flagged, [])


class CliTests(unittest.TestCase):
    def test_main_writes_machine_sessions_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            write_claude_session(claude_home, "proj", "s-long", ["y" * 3000])
            out_dir = Path(tmp) / "out"

            dms.main([
                "--out", str(out_dir),
                "--claude-home", str(claude_home),
                "--codex-home", str(Path(tmp) / "nope"),
                "--pi-home", str(Path(tmp) / "nope"),
                "--grok-home", str(Path(tmp) / "nope"),
                "--zcode-home", str(Path(tmp) / "nope"),
            ])

            report = json.loads((out_dir / "machine_sessions.json").read_text())
            self.assertEqual(report["stats"]["sessions_scanned"], 1)
            self.assertEqual(report["stats"]["sessions_flagged"], 1)
            self.assertEqual(report["sentinel"], dms.MACHINE_SESSION_SENTINEL)


if __name__ == "__main__":
    unittest.main()

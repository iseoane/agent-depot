#!/usr/bin/env python3
"""Tests for scan_corrections.py."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import scan_corrections as sc


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")


def run_scan(claude_home, out_dir, **kwargs):
    argv = ["--out", str(out_dir), "--claude-home", str(claude_home),
            "--codex-home", str(Path(out_dir) / "no-codex-here")]
    for key, value in kwargs.items():
        flag = "--" + key.replace("_", "-")
        if value is True:
            argv.append(flag)
        elif value is False:
            continue
        else:
            argv.extend([flag, str(value)])
    sc.main(argv)
    return json.loads((Path(out_dir) / "corrections.json").read_text())


def now_iso(offset_days=0):
    return (datetime.now(timezone.utc) - timedelta(days=offset_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


class BreakingCaseTests(unittest.TestCase):
    def test_tool_result_only_user_record_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1",
                 "message": {"role": "user", "content": [
                     {"type": "tool_result", "content": "some tool output"}
                 ]}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["user_turns"], 0)

    def test_command_name_turn_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1",
                 "message": {"role": "user",
                             "content": "<command-name>/clear</command-name>\nno uses npm nunca"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["user_turns"], 0)
            self.assertEqual(report["stats"]["corrections_found"], 0)

    def test_sidechain_turn_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1", "isSidechain": True,
                 "message": {"role": "user", "content": "no uses npm, usa pnpm"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["user_turns"], 0)

    def test_same_session_id_across_two_files_counted_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            ts = now_iso()
            record = {
                "type": "user", "sessionId": "shared-session", "cwd": "/repo", "timestamp": ts,
                "uuid": "same-uuid",
                "message": {"role": "user", "content": "hello there, nothing special"},
            }
            write_jsonl(claude_home / "projects" / "p1" / "a.jsonl", [record])
            write_jsonl(claude_home / "projects" / "p1" / "b.jsonl", [record])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["sessions_scanned"], 1)
            self.assertEqual(report["stats"]["user_turns"], 1)

    def test_real_correction_is_found_with_pattern_and_preceding_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "assistant", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "a1",
                 "message": {"role": "assistant", "id": "m1",
                             "content": [{"type": "text", "text": "Installing with npm install."}]}},
                {"type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1",
                 "message": {"role": "user", "content": "no, usa pnpm no npm"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(len(report["corrections"]), 1)
            corr = report["corrections"][0]
            self.assertEqual(corr["pattern"], "no, usa")
            self.assertIn("pnpm", corr["text"])
            self.assertIn("npm install", corr["preceding"])


class WindowAndRepoTests(unittest.TestCase):
    def test_days_excludes_old_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "old.jsonl"
            old_ts = (datetime.now(timezone.utc) - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
            write_jsonl(path, [
                {"type": "user", "sessionId": "old-session", "cwd": "/repo", "timestamp": old_ts,
                 "uuid": "u1", "message": {"role": "user", "content": "no uses npm nunca mas"}},
            ])
            old_time = (datetime.now(timezone.utc) - timedelta(days=200)).timestamp()
            os.utime(path, (old_time, old_time))
            report = run_scan(claude_home, Path(tmp) / "out", days=90, all_conversations=True)
            self.assertEqual(report["stats"]["sessions_scanned"], 0)

    def test_repo_filters_by_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            in_repo = Path(tmp) / "repo-a"
            out_repo = Path(tmp) / "repo-b"
            write_jsonl(claude_home / "projects" / "p1" / "s1.jsonl", [
                {"type": "user", "sessionId": "s-in", "cwd": str(in_repo), "timestamp": now_iso(),
                 "uuid": "u1", "message": {"role": "user", "content": "hi there in repo a"}},
            ])
            write_jsonl(claude_home / "projects" / "p1" / "s2.jsonl", [
                {"type": "user", "sessionId": "s-out", "cwd": str(out_repo), "timestamp": now_iso(),
                 "uuid": "u2", "message": {"role": "user", "content": "hi there in repo b"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", repo=str(in_repo))
            self.assertEqual(report["stats"]["sessions_in_scope"], 1)
            self.assertEqual(report["stats"]["sessions_scanned"], 2)


class ClusteringTests(unittest.TestCase):
    def test_shared_salient_tokens_form_a_cluster(self):
        corrections = [
            {"session_id": "s1", "text": "no uses npm, usa siempre pnpm para el frontend"},
            {"session_id": "s2", "text": "otra vez con npm, usa pnpm en el frontend por favor"},
            {"session_id": "s3", "text": "cosa totalmente distinta sobre bandas LTE"},
        ]
        clusters = sc.build_clusters(corrections)
        big = next(c for c in clusters if c["count"] == 2)
        self.assertEqual(set(big["sessions"]), {"s1", "s2"})
        singleton = next(c for c in clusters if c["count"] == 1)
        self.assertEqual(singleton["sessions"], ["s3"])

    def test_clusters_sorted_by_count_descending(self):
        corrections = [
            {"session_id": "s1", "text": "pnpm frontend siempre pnpm"},
            {"session_id": "s2", "text": "pnpm frontend siempre pnpm otra vez"},
            {"session_id": "s3", "text": "algo distinto"},
        ]
        clusters = sc.build_clusters(corrections)
        counts = [c["count"] for c in clusters]
        self.assertEqual(counts, sorted(counts, reverse=True))


class MachineTurnFilterTests(unittest.TestCase):
    def test_long_turn_matching_pattern_is_dropped_as_too_long(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            long_text = "no, usa pnpm en vez de npm. " + ("relleno de plantilla " * 100)
            self.assertGreater(len(long_text), 1200)
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "user", "sessionId": "s1", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1", "message": {"role": "user", "content": long_text}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["corrections_found"], 0)
            self.assertEqual(report["stats"]["turns_dropped_too_long"], 1)
            # Still counted as a real, in-scope user turn -- the arithmetic
            # user_turns - turns_dropped_too_long stays auditable.
            self.assertEqual(report["stats"]["user_turns"], 1)

    def test_short_text_in_three_distinct_sessions_is_dropped_as_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            template_text = "no uses npm, usa siempre pnpm en el frontend"
            for i in range(3):
                path = claude_home / "projects" / "p1" / f"s{i}.jsonl"
                write_jsonl(path, [
                    {"type": "user", "sessionId": f"tmpl-{i}", "cwd": "/repo", "timestamp": now_iso(),
                     "uuid": "u1", "message": {"role": "user", "content": template_text}},
                ])
            genuine_path = claude_home / "projects" / "p1" / "genuine.jsonl"
            write_jsonl(genuine_path, [
                {"type": "user", "sessionId": "genuine-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1",
                 "message": {"role": "user", "content": "no, usa argon2 en vez de bcrypt para el hashing"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["turns_dropped_templated"], 3)
            self.assertEqual(report["stats"]["corrections_found"], 1)
            self.assertIn("argon2", report["corrections"][0]["text"])
            self.assertEqual(len(report["dropped_templates"]), 1)
            self.assertEqual(report["dropped_templates"][0]["sessions"], 3)
            self.assertEqual(report["dropped_templates"][0]["occurrences"], 3)
            self.assertIn("no uses npm", report["dropped_templates"][0]["prefix"])

    def test_same_text_repeated_in_one_session_is_not_templated(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            text = "no uses npm, usa siempre pnpm en el frontend"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            records = [
                {"type": "user", "sessionId": "one-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": f"u{i}", "message": {"role": "user", "content": text}}
                for i in range(3)
            ]
            write_jsonl(path, records)
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["turns_dropped_templated"], 0)
            self.assertEqual(report["stats"]["corrections_found"], 3)
            self.assertEqual(report["dropped_templates"], [])

    def test_short_prefix_key_catches_templates_with_diverging_payloads(self):
        # Pins the real-world failure: a machine template's grouping key
        # must be its opening, not a suffix that reaches into a variable
        # payload (an id, a JSON blob) -- otherwise every instance hashes
        # differently and the template filter never fires on exactly the
        # turns it exists to catch.
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            shared_opening = (
                "no, usa siempre el snapshot inmutable del commit para intentar refutar el "
                "hallazgo critico representado como JSON no confiable a continuacion, sin "
                "modificar el arbol de commits objetivo bajo ninguna circunstancia: "
            )
            self.assertGreaterEqual(len(shared_opening), 160)
            payloads = [
                '{"finding_id": "aaaa-1111", "severity": "critical", "path": "/repo/a.py"}',
                '{"finding_id": "bbbb-2222", "severity": "critical", "path": "/repo/b.py"}',
                '{"finding_id": "cccc-3333", "severity": "critical", "path": "/repo/c.py"}',
            ]
            for i, payload in enumerate(payloads):
                text = shared_opening + payload
                self.assertLess(len(text), 1200)
                path = claude_home / "projects" / "p1" / f"s{i}.jsonl"
                write_jsonl(path, [
                    {"type": "user", "sessionId": f"refuter-{i}", "cwd": "/repo", "timestamp": now_iso(),
                     "uuid": "u1", "message": {"role": "user", "content": text}},
                ])

            # Default --template-prefix-chars (160) keys on the shared
            # opening alone: all three collapse into one template and are
            # dropped, even though each turn's JSON payload is unique.
            report = run_scan(claude_home, Path(tmp) / "out-default", all_conversations=True)
            self.assertEqual(report["stats"]["turns_dropped_templated"], 3)
            self.assertEqual(report["stats"]["corrections_found"], 0)
            self.assertEqual(len(report["dropped_templates"]), 1)
            self.assertEqual(report["dropped_templates"][0]["sessions"], 3)
            self.assertEqual(report["dropped_templates"][0]["occurrences"], 3)

            # A key long enough to reach into the payload (the pre-fix
            # 300-char default) defeats the filter: each turn's key is
            # unique because the whole (287-char) turn -- payload included
            # -- becomes the key, so nothing repeats and nothing is dropped.
            report_wide = run_scan(claude_home, Path(tmp) / "out-wide", all_conversations=True,
                                    template_prefix_chars=300)
            self.assertEqual(report_wide["stats"]["turns_dropped_templated"], 0)
            self.assertEqual(report_wide["stats"]["corrections_found"], 3)

    def test_custom_thresholds_are_honored(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            text = "no uses npm, usa siempre pnpm en el frontend"
            for i in range(2):
                path = claude_home / "projects" / "p1" / f"s{i}.jsonl"
                write_jsonl(path, [
                    {"type": "user", "sessionId": f"pair-{i}", "cwd": "/repo", "timestamp": now_iso(),
                     "uuid": "u1", "message": {"role": "user", "content": text}},
                ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True,
                               template_threshold=2)
            self.assertEqual(report["stats"]["turns_dropped_templated"], 2)
            self.assertEqual(report["stats"]["corrections_found"], 0)


class SelfSessionSentinelTests(unittest.TestCase):
    def test_sentinel_turn_drops_the_whole_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            path = claude_home / "projects" / "p1" / "s1.jsonl"
            write_jsonl(path, [
                {"type": "user", "sessionId": "self-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1",
                 "message": {"role": "user",
                             "content": sc.SELF_SESSION_SENTINEL + "\njudge this transcript against rule X"}},
                {"type": "user", "sessionId": "self-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u2", "message": {"role": "user", "content": "no, usa pnpm no npm"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["sessions_skipped_self_session"], 1)
            self.assertEqual(report["stats"]["turns_dropped_self_session"], 2)
            self.assertEqual(report["stats"]["corrections_found"], 0)
            self.assertEqual(report["corrections"], [])

    def test_sentinel_does_not_affect_other_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            self_path = claude_home / "projects" / "p1" / "self.jsonl"
            write_jsonl(self_path, [
                {"type": "user", "sessionId": "self-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1", "message": {"role": "user", "content": sc.SELF_SESSION_SENTINEL}},
            ])
            real_path = claude_home / "projects" / "p1" / "real.jsonl"
            write_jsonl(real_path, [
                {"type": "user", "sessionId": "real-session", "cwd": "/repo", "timestamp": now_iso(),
                 "uuid": "u1", "message": {"role": "user", "content": "no, usa pnpm no npm"}},
            ])
            report = run_scan(claude_home, Path(tmp) / "out", all_conversations=True)
            self.assertEqual(report["stats"]["sessions_skipped_self_session"], 1)
            self.assertEqual(len(report["corrections"]), 1)
            self.assertEqual(report["corrections"][0]["session_id"], "real-session")


class PatternMatchingTests(unittest.TestCase):
    def test_curly_apostrophe_matches(self):
        text = "don’t use npm here"
        self.assertEqual(sc.first_match(sc.compile_patterns(None), text), "don't use")

    def test_codex_injected_agents_md_is_filtered(self):
        text = "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nnunca hagas esto\n</INSTRUCTIONS>"
        self.assertTrue(sc.looks_injected_codex(text))


if __name__ == "__main__":
    unittest.main()

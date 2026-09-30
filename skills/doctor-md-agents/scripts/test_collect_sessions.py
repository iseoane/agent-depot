#!/usr/bin/env python3
"""Tests for the session collector (collect_sessions.py)."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from collect_sessions import (
    detect_skills_from_entries,
    discover_skills,
    find_claude_session_files,
    find_grok_session_files,
    find_pi_session_files,
    parse_claude_session,
    parse_codex_session,
    parse_grok_session,
    parse_pi_session,
    parse_zcode_session,
    session_matches_repos,
)

# Additional imports for the CLI-level tests below, which drive main() and
# parse_args() through the module object itself.
import contextlib
import io
import sys
from unittest import mock

import collect_sessions as cs

PREVIOUS_FILE_LIMIT = 8 * 1024 * 1024


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def write_jsonl_past_previous_limit(path, first_record, last_records):
    path.parent.mkdir(parents=True, exist_ok=True)
    filler = json.dumps({"type": "ignored", "padding": "x" * 1024}) + "\n"
    with path.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(first_record) + "\n")
        while stream.tell() <= PREVIOUS_FILE_LIMIT:
            stream.write(filler)
        for record in last_records:
            stream.write(json.dumps(record) + "\n")


class ClaudeSessionTests(unittest.TestCase):
    def test_discovers_skills_and_matches_sessions_across_projects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first"
            second = root / "second"
            first_skill = first / ".agents" / "skills" / "alpha" / "SKILL.md"
            second_skill = second / ".claude" / "skills" / "beta" / "SKILL.md"
            first_skill.parent.mkdir(parents=True)
            second_skill.parent.mkdir(parents=True)
            first_skill.write_text("---\ndescription: Alpha\n---\n")
            second_skill.write_text("---\ndescription: Beta\n---\n")

            skills = discover_skills(
                [first, second],
                root / "codex-home",
                [],
                False,
            )

            self.assertEqual(set(skills), {"alpha", "beta"})
            self.assertTrue(
                session_matches_repos(second / "src", [first, second])
            )
            self.assertFalse(
                session_matches_repos(root / "elsewhere", [first, second])
            )

    def test_discovers_global_skills_without_repositories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            homes = {
                name: root / f"{name}-home"
                for name in ("codex", "pi", "grok", "zcode")
            }
            for name, home in homes.items():
                skill = home / "skills" / f"{name}-skill" / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(f"---\ndescription: {name.title()} skill\n---\n")

            skills = discover_skills(
                [],
                homes["codex"],
                [],
                True,
                pi_home=homes["pi"],
                grok_home=homes["grok"],
                zcode_home=homes["zcode"],
            )

            self.assertTrue(
                {
                    "codex-skill",
                    "pi-skill",
                    "grok-skill",
                    "zcode-skill",
                }.issubset(skills)
            )

    def test_detects_skills_from_deferred_tool_entries(self):
        entries = [
            ("tool:Skill", '{"skill": "alpha"}'),
            ("tool:read", '{"path": "/repo/.agents/skills/beta/SKILL.md"}'),
            ("assistant", "Mentioning gamma here does not count."),
        ]

        self.assertEqual(
            detect_skills_from_entries(entries, {"alpha", "beta", "gamma"}),
            {"alpha", "beta"},
        )

    def test_discovers_parent_sessions_and_optional_subagents(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp)
            parent = claude_home / "projects" / "-repo" / "parent.jsonl"
            subagent = (
                claude_home
                / "projects"
                / "-repo"
                / "parent"
                / "subagents"
                / "agent-child.jsonl"
            )
            old = claude_home / "projects" / "-repo" / "old.jsonl"
            for path in (parent, subagent, old):
                write_jsonl(path, [{"type": "user"}])
            old_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
            os.utime(old, (old_time, old_time))
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            parents = find_claude_session_files(claude_home, cutoff, False)
            with_subagents = find_claude_session_files(claude_home, cutoff, True)

            self.assertEqual([path for _, path in parents], [parent])
            self.assertEqual(
                {path for _, path in with_subagents},
                {parent, subagent},
            )

    def test_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            common = {
                "sessionId": "session-1",
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "version": "1.0.0",
            }
            write_jsonl(path, [
                {
                    **common,
                    "type": "user",
                    "uuid": "user-1",
                    "message": {"role": "user", "content": "Improve my skill"},
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-1",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "I will inspect it."},
                            {
                                "type": "tool_use",
                                "name": "Skill",
                                "input": {"skill": "update-skill"},
                            },
                        ],
                    },
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-2",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "Edit",
                                "input": {"file_path": "/tmp/repo/SKILL.md"},
                            }
                        ],
                    },
                },
                {
                    **common,
                    "type": "user",
                    "uuid": "result-1",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "is_error": True,
                                "content": "permission denied",
                            }
                        ],
                    },
                },
            ])

            meta, stats, entries, skills = parse_claude_session(
                path,
                {"update-skill"},
                False,
            )

            self.assertEqual(meta["id"], "session-1")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["update-skill"])
            self.assertIn(("user", "Improve my skill"), entries)
            self.assertIn(("assistant", "I will inspect it."), entries)

    def test_excludes_sidechains_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agent-child.jsonl"
            write_jsonl(path, [{
                "type": "user",
                "sessionId": "session-1",
                "agentId": "child-1",
                "isSidechain": True,
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "message": {"role": "user", "content": "Investigate"},
            }])

            self.assertIsNone(parse_claude_session(path, set(), False))
            parsed = parse_claude_session(path, set(), True)
            self.assertEqual(parsed[0]["id"], "session-1-child-1")
            self.assertEqual(parsed[0]["thread_source"], "subagent")


class PiSessionTests(unittest.TestCase):
    def test_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "2026-08-20T10-00-00-000Z_session-1.jsonl"
            write_jsonl(path, [
                {
                    "type": "session",
                    "id": "session-1",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-20T10:00:00.000Z",
                },
                {"type": "model_change", "provider": "zai", "modelId": "glm"},
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:01.000Z",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "Improve my skill"}],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:02.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "thinking", "thinking": "plan the edit"},
                            {"type": "text", "text": "I will inspect it."},
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {
                                    "path": "/repo/.agents/skills/update-skill/SKILL.md"
                                },
                            },
                        ],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:03.000Z",
                    "message": {
                        "role": "toolResult",
                        "toolName": "read",
                        "content": [{"type": "text", "text": "--- description: alpha"}],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:04.000Z",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "edit",
                                "arguments": {
                                    "path": "/tmp/repo/SKILL.md",
                                    "oldText": "a",
                                    "newText": "b",
                                },
                            },
                        ],
                    },
                },
                {
                    "type": "message",
                    "timestamp": "2026-08-20T10:00:05.000Z",
                    "message": {
                        "role": "toolResult",
                        "toolName": "edit",
                        "content": [
                            {"type": "text", "text": "oldText not found", "isError": True}
                        ],
                    },
                },
            ])

            meta, stats, entries, skills = parse_pi_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "session-1")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(meta["originator"], "pi")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 2)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["repeated_tool_calls"], 0)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(stats["first_ts"], "2026-08-20T10:00:00.000Z")
            self.assertEqual(stats["last_ts"], "2026-08-20T10:00:05.000Z")
            self.assertEqual(skills, ["update-skill"])
            self.assertIn(("user", "Improve my skill"), entries)
            self.assertIn(("assistant", "I will inspect it."), entries)
            self.assertIn(("output", "--- description: alpha"), entries)
            self.assertFalse(any(role == "thinking" for role, _ in entries))

    def test_accepts_include_subagents_without_changing_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session-2.jsonl"
            write_jsonl(path, [
                {"type": "session", "id": "session-2", "cwd": "/tmp/repo",
                 "timestamp": "2026-08-20T10:00:00.000Z"},
                {"type": "message", "timestamp": "2026-08-20T10:00:01.000Z",
                 "message": {"role": "user", "content": "Hello there"}},
            ])

            without_flag = parse_pi_session(path, set(), False)
            with_flag = parse_pi_session(path, set(), True)

            self.assertEqual(without_flag, with_flag)
            self.assertEqual(with_flag[0]["originator"], "pi")

    def test_finds_recent_session_files_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            pi_home = Path(tmp)
            recent = pi_home / "sessions" / "--tmp-repo" / "recent.jsonl"
            old = pi_home / "sessions" / "--tmp-repo" / "old.jsonl"
            for path in (recent, old):
                write_jsonl(path, [{"type": "session", "id": "x"}])
            old_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
            os.utime(old, (old_time, old_time))
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            files = find_pi_session_files(pi_home, cutoff)

            self.assertEqual([path for _, path in files], [recent])


class GrokSessionTests(unittest.TestCase):
    def test_parses_tool_calls_and_skips_synthetic_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            grok_home = Path(tmp)
            session_dir = grok_home / "sessions" / "%2Ftmp%2Frepo" / "abc-123"
            path = session_dir / "chat_history.jsonl"
            write_jsonl(path, [
                {"type": "system", "content": "You are Grok."},
                {
                    "type": "user",
                    "synthetic_reason": "system_reminder",
                    "content": [{"type": "text", "text": "<system-reminder>skills</system-reminder>"}],
                },
                {"type": "user", "content": "Fix the collector"},
                {
                    "type": "reasoning",
                    "id": "rs-1",
                    "summary": "[]",
                    "encrypted_content": "xx",
                    "status": "completed",
                },
                {
                    "type": "assistant",
                    "content": "I will read the skill.",
                    "tool_calls": [{
                        "id": "call-1",
                        "name": "read_file",
                        "arguments": "{\"path\": \"/repo/.grok/skills/update-skill/SKILL.md\"}",
                    }],
                },
                {"type": "tool_result", "tool_call_id": "call-1", "content": "file body"},
                {
                    "type": "assistant",
                    "content": "Now writing the file.",
                    "tool_calls": [{
                        "id": "call-2",
                        "name": "write",
                        "arguments": "{\"path\": \"/tmp/repo/out.txt\", \"content\": \"hi\"}",
                    }],
                },
            ])
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            files = find_grok_session_files(grok_home, cutoff)
            self.assertEqual([found for _, found in files], [path])

            meta, stats, entries, skills = parse_grok_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "abc-123")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(meta["originator"], "grok")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 2)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 0)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["update-skill"])
            self.assertEqual(entries[0], ("user", "Fix the collector"))
            self.assertNotIn("system-reminder", json.dumps(entries))


class ZcodeSessionTests(unittest.TestCase):
    def test_parses_last_request_messages_and_tool_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model-io-sess_1.jsonl"
            empty_request = {"request": {"body": {"messages": []}}}
            full_request = {
                "request": {
                    "body": {
                        "messages": [
                            {"role": "system", "content": "You are ZCode."},
                            {"role": "user", "content": "Update the skill"},
                            {
                                "role": "assistant",
                                "content": "Checking.",
                                "tool_calls": [{
                                    "id": "c1",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": "{\"path\": \"/r/.agents/skills/update-skill/SKILL.md\"}",
                                    },
                                }],
                            },
                            {"role": "tool", "content": "skill body"},
                        ]
                    }
                }
            }
            path.write_text(
                json.dumps(empty_request) + "\n" + json.dumps(full_request) + "\n"
            )

            meta, stats, entries, skills = parse_zcode_session(path, {"update-skill"}, False)

            self.assertEqual(meta["id"], "sess_1")
            self.assertEqual(meta["originator"], "zcode")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 1)
            self.assertEqual(skills, ["update-skill"])
            self.assertEqual(entries[0], ("user", "Update the skill"))

    def test_returns_none_without_request_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model-io-sess_2.jsonl"
            path.write_text("{\"unrelated\": true}\n")

            self.assertIsNone(parse_zcode_session(path, set(), False))


class StreamingSessionReadTests(unittest.TestCase):
    def test_claude_and_codex_parse_records_after_previous_file_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            claude_path = root / "claude.jsonl"
            codex_path = root / "codex.jsonl"
            write_jsonl_past_previous_limit(
                claude_path,
                {
                    "type": "user",
                    "sessionId": "claude-session",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-30T10:00:00Z",
                    "message": {"role": "user", "content": "hello"},
                },
                [{
                    "type": "assistant",
                    "sessionId": "claude-session",
                    "cwd": "/tmp/repo",
                    "timestamp": "2026-08-30T10:01:00Z",
                    "message": {
                        "id": "late-message",
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "late claude message"},
                            {
                                "type": "tool_use",
                                "name": "Read",
                                "input": {
                                    "file_path": "/tmp/.agents/skills/late-skill/SKILL.md"
                                },
                            },
                        ],
                    },
                }],
            )
            write_jsonl_past_previous_limit(
                codex_path,
                {
                    "type": "session_meta",
                    "payload": {"id": "codex-session", "cwd": "/tmp/repo"},
                },
                [{
                    "type": "response_item",
                    "timestamp": "2026-08-30T10:00:30Z",
                    "payload": {
                        "type": "function_call",
                        "name": "read_file",
                        "arguments": {
                            "path": "/tmp/.codex/skills/late-skill/SKILL.md",
                            "operation": "apply_patch",
                        },
                    },
                }, {
                    "type": "response_item",
                    "timestamp": "2026-08-30T10:01:00Z",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "late codex message"}],
                    },
                }],
            )

            parsed_claude = parse_claude_session(claude_path, {"late-skill"}, False)
            parsed_codex = parse_codex_session(codex_path, {"late-skill"}, False)

            self.assertEqual(parsed_claude[1]["assistant_turns"], 1)
            self.assertEqual(parsed_claude[1]["tool_calls"], 1)
            self.assertEqual(parsed_claude[3], ["late-skill"])
            self.assertIn(("assistant", "late claude message"), parsed_claude[2])
            self.assertEqual(parsed_codex[1]["tool_calls"], 1)
            self.assertTrue(parsed_codex[1]["has_code_edits"])
            self.assertEqual(parsed_codex[3], ["late-skill"])
            self.assertIn(("assistant", "late codex message"), parsed_codex[2])

    def test_codex_keeps_only_transcript_head_and_tail_while_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "codex.jsonl"
            records = [{
                "type": "session_meta",
                "payload": {"id": "codex-session", "cwd": "/tmp/repo"},
            }]
            for index in range(201):
                records.extend(({
                    "type": "event_msg",
                    "payload": {"type": "agent_message"},
                }, {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": f"message-{index}"}],
                    },
                }))
            write_jsonl(path, records)

            _, stats, entries, _ = parse_codex_session(path, set(), False)

            self.assertEqual(stats["assistant_turns"], 201)
            self.assertEqual(len(entries), 141)
            self.assertEqual(entries[0], ("assistant", "message-0"))
            self.assertEqual(entries[99], ("assistant", "message-99"))
            self.assertEqual(entries[100], ("note", "[... 61 entries omitted ...]"))
            self.assertEqual(entries[101], ("assistant", "message-161"))
            self.assertEqual(entries[-1], ("assistant", "message-200"))


# ---------------------------------------------------------------------------
# CLI-level tests: --sample modes and --harness validation.
# ---------------------------------------------------------------------------


def write_claude_session_file(path, session_id, cwd="/nonexistent/repo", skill=None,
                               timestamp="2026-08-20T10:00:00Z"):
    """A minimal Claude Code session with exactly one user turn and one
    assistant turn carrying a tool_use call -- main() drops any session with
    zero assistant_turns or zero tool_calls before sampling even sees it, so
    every sampling fixture needs at least this much to be considered at all.
    `cwd` deliberately does not exist on disk: --all-conversations re-infers
    repos via `git -C <cwd> rev-parse ...`, and a non-existent cwd short-
    circuits that (Path.is_dir() is False) before any subprocess runs.
    """
    common = {"sessionId": session_id, "cwd": cwd, "timestamp": timestamp}
    if skill:
        tool_block = {"type": "tool_use", "name": "Skill", "input": {"skill": skill}}
    else:
        tool_block = {"type": "tool_use", "name": "Edit", "input": {"file_path": f"{cwd}/file.py"}}
    write_jsonl(path, [
        {**common, "type": "user", "uuid": f"{session_id}-user-1",
         "message": {"role": "user", "content": "hello"}},
        {**common, "type": "assistant", "uuid": f"{session_id}-assistant-1",
         "message": {"id": f"{session_id}-m1", "role": "assistant",
                     "content": [{"type": "text", "text": "working on it"}, tool_block]}},
    ])


def set_mtime(path, seconds_ago):
    """Give a fixture file a precise, distinct mtime so sampling order
    (which sorts by file mtime, newest first) is deterministic in a test."""
    t = (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).timestamp()
    os.utime(path, (t, t))


def write_skill_fixture(skills_dir, name):
    skill_md = skills_dir / name / "SKILL.md"
    skill_md.parent.mkdir(parents=True, exist_ok=True)
    skill_md.write_text(f"---\ndescription: {name.title()}\n---\n")


def run_collect(claude_home, out_dir, extra_args=None, **kwargs):
    """Drive collect_sessions.main() through its real CLI. main() has no
    argv parameter of its own (unlike this skill's other scripts) -- it
    always reads sys.argv, so the only faithful way to exercise the actual
    argument-parsing and sampling pipeline is to patch sys.argv, exactly as
    a real invocation would populate it, and let main() run for real."""
    argv = [
        "collect_sessions.py", "--out", str(out_dir), "--claude-home", str(claude_home),
        "--all-conversations", "--harness", "claude", "--days", "3650",
    ]
    argv.extend(extra_args or [])
    for key, value in kwargs.items():
        flag = "--" + key.replace("_", "-")
        argv.extend([flag, str(value)])
    with mock.patch.object(sys, "argv", argv):
        cs.main()
    return json.loads((Path(out_dir) / "inventory.json").read_text())


class SamplingTests(unittest.TestCase):
    """--sample {newest,skill-stratified} selects how sessions are sampled."""

    def test_newest_sample_selects_n_distinct_sessions_despite_resumed_duplicate(self):
        # The trap the newest-sample comment in collect_sessions.py warns
        # about: the same session id can appear via more than one file (a
        # resumed session). The sampled set is keyed by `_key`
        # (harness:id), so distinctness must be measured by that key set's
        # size, not by counting list entries or slicing the first N -- a
        # naive `sessions[:max_sessions]` here would count the resumed
        # session's two file-entries as two sessions and under-sample by one
        # distinct session.
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            proj = claude_home / "projects" / "p1"
            resumed_a = proj / "resumed-a.jsonl"
            resumed_b = proj / "resumed-b.jsonl"
            session_b = proj / "session-b.jsonl"
            session_c = proj / "session-c.jsonl"
            write_claude_session_file(resumed_a, "resumed-session")
            write_claude_session_file(resumed_b, "resumed-session")  # same id, second file
            write_claude_session_file(session_b, "session-b")
            write_claude_session_file(session_c, "session-c")
            set_mtime(resumed_a, 10)   # newest
            set_mtime(resumed_b, 20)   # 2nd newest, SAME session id as resumed_a
            set_mtime(session_b, 30)   # 3rd newest, distinct
            set_mtime(session_c, 40)   # oldest, distinct -- must be excluded at max_sessions=2

            inventory = run_collect(claude_home, Path(tmp) / "out",
                                     sample="newest", max_sessions=2)

            self.assertEqual(inventory["stats"]["sessions_sampled"], 2)
            sampled_ids = {s["meta"]["id"] for s in inventory["sessions"] if s["sampled"]}
            self.assertEqual(len(sampled_ids), 2)
            self.assertEqual(sampled_ids, {"resumed-session", "session-b"})
            self.assertNotIn("session-c", sampled_ids)

    def test_newest_sample_ignores_skill_usage(self):
        # The skill-stratified mode draws skill-using sessions first,
        # regardless of recency. --sample newest must NOT do that -- the
        # newest sessions win even when an older session is the only one
        # that used the sole installed skill.
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            proj = claude_home / "projects" / "p1"
            skills_dir = Path(tmp) / "skills-fixture"
            write_skill_fixture(skills_dir, "alpha")

            newest1 = proj / "newest1.jsonl"
            newest2 = proj / "newest2.jsonl"
            older_with_skill = proj / "older-skill.jsonl"
            oldest = proj / "oldest.jsonl"
            write_claude_session_file(newest1, "newest-1")
            write_claude_session_file(newest2, "newest-2")
            write_claude_session_file(older_with_skill, "older-skill-session", skill="alpha")
            write_claude_session_file(oldest, "oldest-session")
            set_mtime(newest1, 10)
            set_mtime(newest2, 20)
            set_mtime(older_with_skill, 30)
            set_mtime(oldest, 40)

            inventory = run_collect(claude_home, Path(tmp) / "out",
                                     extra_args=["--skills-dir", str(skills_dir)],
                                     sample="newest", max_sessions=2)

            sampled_ids = {s["meta"]["id"] for s in inventory["sessions"] if s["sampled"]}
            self.assertEqual(sampled_ids, {"newest-1", "newest-2"})
            self.assertNotIn("older-skill-session", sampled_ids)

    def test_skill_stratified_applies_per_skill_and_no_skill_caps(self):
        # Pins the skill-stratified branch: skill-using sessions are drawn first (capped
        # by --per-skill), then no-skill sessions fill the rest (capped by
        # --no-skill), both newest-first within their own pool.
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp) / "claude"
            proj = claude_home / "projects" / "p1"
            skills_dir = Path(tmp) / "skills-fixture"
            write_skill_fixture(skills_dir, "alpha")

            a1, a2 = proj / "a1.jsonl", proj / "a2.jsonl"
            n1, n2, n3 = proj / "n1.jsonl", proj / "n2.jsonl", proj / "n3.jsonl"
            write_claude_session_file(a1, "alpha-1", skill="alpha")
            write_claude_session_file(a2, "alpha-2", skill="alpha")
            write_claude_session_file(n1, "no-skill-1")
            write_claude_session_file(n2, "no-skill-2")
            write_claude_session_file(n3, "no-skill-3")
            set_mtime(a1, 10)
            set_mtime(a2, 20)
            set_mtime(n1, 30)
            set_mtime(n2, 40)
            set_mtime(n3, 50)

            inventory = run_collect(claude_home, Path(tmp) / "out",
                                     extra_args=["--skills-dir", str(skills_dir)],
                                     sample="skill-stratified", max_sessions=10,
                                     per_skill=1, no_skill=2)

            sampled_ids = {s["meta"]["id"] for s in inventory["sessions"] if s["sampled"]}
            # per_skill=1 caps "alpha" at its newest instance only;
            # no_skill=2 caps the no-skill pool at its two newest.
            self.assertEqual(sampled_ids, {"alpha-1", "no-skill-1", "no-skill-2"})
            self.assertNotIn("alpha-2", sampled_ids)
            self.assertNotIn("no-skill-3", sampled_ids)


class HarnessValidationTests(unittest.TestCase):
    def test_unknown_harness_is_rejected_by_argparse_cleanly(self):
        captured_stderr = io.StringIO()
        with mock.patch.object(sys, "argv", ["collect_sessions.py", "--harness", "bogus"]):
            with contextlib.redirect_stderr(captured_stderr):
                with self.assertRaises(SystemExit) as ctx:
                    cs.parse_args()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertNotIn("Traceback (most recent call last)", captured_stderr.getvalue())
        self.assertIn("bogus", captured_stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

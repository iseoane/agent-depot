#!/usr/bin/env python3
"""Collect local Claude Code, Codex, Pi, Grok Build, and ZCode sessions and skills for scoring.

Scans Claude Code project history, Codex rollout files, Pi agent session
JSONL, Grok Build chat history, and/or ZCode model-io rollouts, discovers
installed skills, detects which sessions used which skills, and emits:

  <out>/inventory.json        - skills, per-session stats, sampling decisions
  <out>/transcripts/<id>.md   - condensed transcripts for sampled sessions

Everything runs locally; nothing is uploaded. Python 3.9+, stdlib only.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote

MAX_MSG_CHARS = 1500
MAX_TOOL_CHARS = 500
MAX_TRANSCRIPT_ENTRIES = 160
TRANSCRIPT_HEAD = 100
TRANSCRIPT_TAIL = 40

CODE_EDIT_HINTS = ("apply_patch", "*** Begin Patch", "edit_file", "create_file", "str_replace", "write_file")
CLAUDE_CODE_EDIT_TOOLS = {"Edit", "MultiEdit", "NotebookEdit", "Write"}
GENERIC_EDIT_TOOLS = {"edit", "write", "apply_patch", "edit_file", "write_file", "str_replace", "search_replace"}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--harness",
        choices=("auto", "all", "claude", "codex", "pi", "grok", "zcode"),
        default="auto",
        help="session source (default: auto; scans every locally available source)",
    )
    p.add_argument(
        "--claude-home",
        default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"),
        help="Claude Code config directory (default: CLAUDE_CONFIG_DIR or ~/.claude)",
    )
    p.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    p.add_argument(
        "--pi-home",
        default="~/.pi/agent",
        help="Pi agent home (default: ~/.pi/agent)",
    )
    p.add_argument(
        "--grok-home",
        default="~/.grok",
        help="Grok Build home (default: ~/.grok)",
    )
    p.add_argument(
        "--zcode-home",
        default="~/.zcode",
        help="ZCode home (default: ~/.zcode)",
    )
    p.add_argument(
        "--repo",
        action="append",
        default=[],
        help="project to include (repeatable; default: git root of cwd, else cwd)",
    )
    p.add_argument(
        "--all-conversations",
        action="store_true",
        help="score conversations from every project represented in local history",
    )
    p.add_argument("--include-global-skills", action="store_true",
                   help="also discover skills outside the repo (~/.codex/skills, ~/.agents/skills, ~/.claude/skills, ~/.pi/agent/skills, ~/.grok/skills, ~/.zcode/skills)")
    p.add_argument("--days", type=int, default=45, help="only consider sessions modified in the last N days")
    p.add_argument("--max-sessions", type=int, default=12, help="max sessions to sample for scoring")
    p.add_argument("--per-skill", type=int, default=3, help="max sampled sessions per skill")
    p.add_argument("--no-skill", type=int, default=4, help="max sampled sessions that used no skill")
    p.add_argument("--skills-dir", action="append", default=[], help="extra skills directory to scan (repeatable)")
    p.add_argument("--include-subagents", action="store_true", help="include subagent/child sessions")
    p.add_argument("--out", default="./doctor-md-skill-report")
    return p.parse_args()


def resolve_repo(repo_arg) -> Path:
    if repo_arg:
        return Path(repo_arg).expanduser().resolve()
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=10
        )
        if res.returncode == 0 and res.stdout.strip():
            return Path(res.stdout.strip()).resolve()
    except (subprocess.TimeoutExpired, OSError):
        pass
    return Path.cwd().resolve()


def resolve_repos(repo_args):
    if not repo_args:
        return [resolve_repo(None)]
    repos = []
    seen = set()
    for value in repo_args:
        repo = resolve_repo(value)
        if repo in seen:
            continue
        seen.add(repo)
        repos.append(repo)
    return repos


def discover_skills(repos, codex_home: Path, extra_dirs, include_global: bool,
                    pi_home: Path = None, grok_home: Path = None, zcode_home: Path = None):
    if isinstance(repos, Path):
        repos = [repos]
    roots = []
    for repo in repos:
        roots.extend((
            repo / ".agents" / "skills",
            repo / ".claude" / "skills",
            repo / ".codex" / "skills",
        ))
    if include_global:
        roots += [
            codex_home / "skills",
            Path.home() / ".agents" / "skills",
            Path.home() / ".claude" / "skills",
        ]
        for home in (pi_home, grok_home, zcode_home):
            if home is not None:
                roots.append(Path(home) / "skills")
    roots += [Path(d).expanduser() for d in extra_dirs]

    skills = {}
    for root in roots:
        if not root.is_dir():
            continue
        for skill_md in sorted(root.glob("*/SKILL.md")):
            name = skill_md.parent.name
            if name in skills:
                continue
            try:
                text = skill_md.read_text(errors="replace")
            except OSError:
                continue
            desc = ""
            m = re.search(r"^description:\s*(.+)$", text, re.MULTILINE)
            if m:
                desc = m.group(1).strip().strip("\"'")[:300]
            skills[name] = {
                "name": name,
                "path": str(skill_md),
                "description": desc,
                "bytes": skill_md.stat().st_size,
                "modified_at": datetime.fromtimestamp(skill_md.stat().st_mtime, tz=timezone.utc).isoformat(),
            }
    return skills


def find_codex_session_files(codex_home: Path, cutoff: datetime):
    files = []
    for sub in ("sessions", "archived_sessions"):
        root = codex_home / sub
        if not root.is_dir():
            continue
        for f in root.rglob("rollout-*.jsonl"):
            try:
                mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
            if mtime >= cutoff:
                files.append((mtime, f))
    files.sort(key=lambda t: t[0], reverse=True)
    return files


def find_claude_session_files(claude_home: Path, cutoff: datetime, include_subagents: bool):
    """Find recent Claude Code parent sessions and, optionally, sidechains."""
    projects = claude_home / "projects"
    if not projects.is_dir():
        return []

    candidates = list(projects.glob("*/*.jsonl"))
    if include_subagents:
        candidates.extend(projects.glob("*/*/subagents/*.jsonl"))

    files = []
    for path in candidates:
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            files.append((mtime, path))
    files.sort(key=lambda item: item[0], reverse=True)
    return files


def truncate(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f" …[truncated {len(text) - limit} chars]"


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content") or ""
                if isinstance(t, str) and t:
                    parts.append(t)
            elif isinstance(block, str):
                parts.append(block)
    return "\n".join(parts)


def iter_jsonl_records(path: Path):
    """Yield every valid JSON object without loading the whole file."""
    stream = path.open("r", encoding="utf-8", errors="replace")

    def records():
        with stream:
            for line in stream:
                try:
                    yield json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue

    return records()


class TranscriptBuffer:
    """Keep complete short transcripts and a bounded head/tail for long ones."""

    def __init__(self):
        self._entries = []
        self._tail = None
        self._total = 0

    def append(self, entry):
        self._total += 1
        if self._tail is None:
            self._entries.append(entry)
            if len(self._entries) > MAX_TRANSCRIPT_ENTRIES:
                self._tail = deque(self._entries[-TRANSCRIPT_TAIL:], maxlen=TRANSCRIPT_TAIL)
                self._entries = self._entries[:TRANSCRIPT_HEAD]
        else:
            self._tail.append(entry)

    def finish(self):
        if self._tail is None:
            return self._entries
        omitted = self._total - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL
        return self._entries + [
            ("note", f"[... {omitted} entries omitted ...]")
        ] + list(self._tail)


def detect_skill_candidates(text: str):
    """Extract possible installed-skill names from one tool argument payload."""
    normalized = text.replace("\\", "/")
    candidates = set(re.findall(r"(?:^|/)skills/+([^/]+)/+", normalized))
    candidates.update(re.findall(
        r'"(?:skill|name|bundled_skill_id)"\s*:\s*"([^"]+)"',
        normalized,
    ))
    return candidates


def parse_claude_session(path: Path, skill_names, include_subagents: bool):
    """Normalize one Claude Code JSONL session to the shared transcript shape."""
    try:
        records = iter_jsonl_records(path)
    except OSError:
        return None

    meta = {}
    stats = {
        "user_turns": 0,
        "assistant_turns": 0,
        "tool_calls": 0,
        "repeated_tool_calls": 0,
        "error_outputs": 0,
    }
    entries = TranscriptBuffer()
    seen_calls = {}
    seen_assistant_messages = set()
    used_tool_names = set()
    skills_used = set()
    has_code_edit_hint = False
    first_ts = last_ts = None
    is_sidechain = False

    for obj in records:
        ts = obj.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts

        if obj.get("isSidechain"):
            is_sidechain = True
            if not include_subagents:
                return None

        if not meta and obj.get("sessionId"):
            session_id = obj.get("sessionId")
            agent_id = obj.get("agentId")
            meta = {
                "id": f"{session_id}-{agent_id}" if agent_id else session_id,
                "cwd": obj.get("cwd"),
                "started_at": ts,
                "originator": "claude-code",
                "thread_source": "subagent" if obj.get("isSidechain") else None,
                "cli_version": obj.get("version"),
                "entrypoint": obj.get("entrypoint"),
            }
        elif meta:
            meta["cwd"] = meta.get("cwd") or obj.get("cwd")
            meta["started_at"] = meta.get("started_at") or ts
            meta["cli_version"] = meta.get("cli_version") or obj.get("version")
            meta["entrypoint"] = meta.get("entrypoint") or obj.get("entrypoint")
            agent_id = obj.get("agentId")
            if agent_id and not meta["id"].endswith(f"-{agent_id}"):
                meta["id"] = f"{obj.get('sessionId') or meta['id']}-{agent_id}"

        record_type = obj.get("type")
        message = obj.get("message")
        if record_type not in ("user", "assistant") or not isinstance(message, dict):
            continue

        role = message.get("role") or record_type
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        has_user_text = False

        if role == "assistant":
            message_id = message.get("id") or obj.get("uuid")
            if message_id and message_id not in seen_assistant_messages:
                seen_assistant_messages.add(message_id)
                stats["assistant_turns"] += 1

        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if not isinstance(text, str) or not text or looks_injected(text):
                    continue
                if role == "user":
                    has_user_text = True
                    entries.append(("user", truncate(text, MAX_MSG_CHARS)))
                elif role == "assistant":
                    entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            elif block_type == "tool_use":
                stats["tool_calls"] += 1
                name = str(block.get("name") or "unknown")
                args = block.get("input") or {}
                args_text = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                key = hashlib.sha1((name + args_text).encode()).hexdigest()
                seen_calls[key] = seen_calls.get(key, 0) + 1
                if seen_calls[key] > 1:
                    stats["repeated_tool_calls"] += 1
                used_tool_names.add(name)
                skills_used.update(detect_skill_candidates(args_text))
                has_code_edit_hint = has_code_edit_hint or any(
                    hint in args_text for hint in CODE_EDIT_HINTS
                )
                if name == "Skill" and isinstance(args, dict):
                    skill_name = args.get("skill")
                    if skill_name:
                        skills_used.add(skill_name)
                entries.append((f"tool:{name}", truncate(args_text, MAX_TOOL_CHARS)))
            elif block_type == "tool_result":
                result = extract_text(block.get("content"))
                low = result[:2000].lower()
                if block.get("is_error") or "error" in low or "failed" in low or "traceback" in low:
                    stats["error_outputs"] += 1
                entries.append(("output", truncate(result, MAX_TOOL_CHARS)))

        if role == "user" and has_user_text:
            stats["user_turns"] += 1

    if not meta:
        meta = {
            "id": path.stem,
            "cwd": None,
            "started_at": first_ts,
            "originator": "claude-code",
            "thread_source": "subagent" if is_sidechain else None,
        }
    elif is_sidechain:
        meta["thread_source"] = "subagent"

    stats["first_ts"] = first_ts
    stats["last_ts"] = last_ts
    stats["has_code_edits"] = (
        bool(used_tool_names & CLAUDE_CODE_EDIT_TOOLS)
        or has_code_edit_hint
    )
    return meta, stats, entries.finish(), sorted(skills_used)


def looks_injected(text: str) -> bool:
    head = text.lstrip()[:80]
    return head.startswith("<") and any(
        tag in head
        for tag in (
            "environment_context", "user_instructions", "ENVIRONMENT", "system-reminder",
            "permissions", "collaboration_mode", "recommended_plugins", "turn_context",
            "user_info",
        )
    )


def parse_codex_session(path: Path, skill_names, include_subagents: bool):
    """Returns (meta, stats, entries) or None if the session should be skipped."""
    try:
        records = iter_jsonl_records(path)
    except OSError:
        return None

    meta = {}
    stats = {"user_turns": 0, "assistant_turns": 0, "tool_calls": 0, "repeated_tool_calls": 0, "error_outputs": 0}
    entries = TranscriptBuffer()
    seen_calls = {}
    skills_used = set()
    has_code_edits = False
    first_ts = last_ts = None

    for obj in records:
        ltype = obj.get("type")
        payload = obj.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        ts = obj.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts

        if ltype == "session_meta":
            meta = {
                "id": payload.get("id") or payload.get("session_id") or path.stem,
                "cwd": payload.get("cwd"),
                "started_at": payload.get("timestamp"),
                "originator": payload.get("originator"),
                "thread_source": payload.get("thread_source"),
                "cli_version": payload.get("cli_version"),
            }
            source = payload.get("source")
            is_subagent = payload.get("thread_source") == "subagent" or (
                isinstance(source, dict) and "subagent" in source
            )
            if is_subagent and not include_subagents:
                return None

        elif ltype == "event_msg":
            ptype = payload.get("type")
            if ptype == "user_message":
                stats["user_turns"] += 1
            elif ptype == "agent_message":
                stats["assistant_turns"] += 1

        elif ltype == "response_item":
            ptype = payload.get("type")
            if ptype == "message":
                role = payload.get("role")
                text = extract_text(payload.get("content"))
                if not text:
                    continue
                if role == "user":
                    if looks_injected(text):
                        continue
                    entries.append(("user", truncate(text, MAX_MSG_CHARS)))
                elif role == "assistant":
                    entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            elif ptype in ("function_call", "custom_tool_call", "local_shell_call"):
                stats["tool_calls"] += 1
                name = payload.get("name") or ptype
                args = payload.get("arguments") or payload.get("input") or ""
                if not isinstance(args, str):
                    args = json.dumps(args)
                key = hashlib.sha1((name + args).encode()).hexdigest()
                seen_calls[key] = seen_calls.get(key, 0) + 1
                if seen_calls[key] > 1:
                    stats["repeated_tool_calls"] += 1
                skills_used.update(detect_skill_candidates(args))
                has_code_edits = has_code_edits or any(
                    hint in args for hint in CODE_EDIT_HINTS
                )
                entries.append((f"tool:{name}", truncate(args, MAX_TOOL_CHARS)))
            elif ptype in ("function_call_output", "custom_tool_call_output"):
                out = payload.get("output") or ""
                if not isinstance(out, str):
                    out = json.dumps(out)
                low = out[:2000].lower()
                if "error" in low or "failed" in low or "traceback" in low:
                    stats["error_outputs"] += 1
                entries.append(("output", truncate(out, MAX_TOOL_CHARS)))

    if not meta:
        meta = {"id": path.stem, "cwd": None, "started_at": first_ts}

    stats["first_ts"] = first_ts
    stats["last_ts"] = last_ts
    stats["has_code_edits"] = has_code_edits
    return meta, stats, entries.finish(), sorted(skills_used)



def find_pi_session_files(pi_home: Path, cutoff: datetime):
    root = pi_home / "sessions"
    if not root.is_dir():
        return []
    files = []
    for path in root.glob("*/*.jsonl"):
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            files.append((mtime, path))
    files.sort(key=lambda item: item[0], reverse=True)
    return files


def parse_pi_session(path: Path, skill_names, include_subagents: bool):
    """Normalize one Pi agent JSONL session to the shared transcript shape.

    Pi has no subagent sessions; include_subagents is accepted for signature
    compatibility with the Claude parser and ignored.
    """
    try:
        records = iter_jsonl_records(path)
    except OSError:
        return None

    meta = {}
    stats = {"user_turns": 0, "assistant_turns": 0, "tool_calls": 0, "repeated_tool_calls": 0, "error_outputs": 0}
    entries = TranscriptBuffer()
    seen_calls = {}
    used_tool_names = set()
    skills_used = set()
    has_code_edit_hint = False
    first_ts = last_ts = None

    for obj in records:
        record_type = obj.get("type")
        ts = obj.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts

        if record_type == "session":
            if not meta:
                meta = {
                    "id": obj.get("id") or path.stem,
                    "cwd": obj.get("cwd"),
                    "started_at": ts,
                    "originator": "pi",
                    "thread_source": None,
                }
            else:
                meta["cwd"] = meta.get("cwd") or obj.get("cwd")
                meta["started_at"] = meta.get("started_at") or ts
            continue

        if record_type != "message":
            continue
        message = obj.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]

        if role == "toolResult":
            message_error = bool(message.get("isError"))
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                result = block.get("text") or ""
                if not isinstance(result, str) or not result:
                    continue
                low = result[:2000].lower()
                if (
                    message_error
                    or block.get("isError")
                    or "error" in low
                    or "failed" in low
                    or "traceback" in low
                ):
                    stats["error_outputs"] += 1
                entries.append(("output", truncate(result, MAX_TOOL_CHARS)))
            continue

        has_user_text = False
        if role == "assistant":
            stats["assistant_turns"] += 1

        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if not isinstance(text, str) or not text or looks_injected(text):
                    continue
                if role == "user":
                    has_user_text = True
                    entries.append(("user", truncate(text, MAX_MSG_CHARS)))
                elif role == "assistant":
                    entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            elif block_type == "toolCall":
                stats["tool_calls"] += 1
                name = str(block.get("name") or "unknown")
                args = block.get("arguments") or {}
                args_text = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                key = hashlib.sha1((name + args_text).encode()).hexdigest()
                seen_calls[key] = seen_calls.get(key, 0) + 1
                if seen_calls[key] > 1:
                    stats["repeated_tool_calls"] += 1
                used_tool_names.add(name)
                skills_used.update(detect_skill_candidates(args_text))
                has_code_edit_hint = has_code_edit_hint or any(
                    hint in args_text for hint in CODE_EDIT_HINTS
                )
                entries.append((f"tool:{name}", truncate(args_text, MAX_TOOL_CHARS)))

        if role == "user" and has_user_text:
            stats["user_turns"] += 1

    if not meta:
        meta = {
            "id": path.stem,
            "cwd": None,
            "started_at": first_ts,
            "originator": "pi",
            "thread_source": None,
        }

    stats["first_ts"] = first_ts
    stats["last_ts"] = last_ts
    stats["has_code_edits"] = (
        bool(used_tool_names & GENERIC_EDIT_TOOLS)
        or has_code_edit_hint
    )
    return meta, stats, entries.finish(), sorted(skills_used & set(skill_names))


def find_grok_session_files(grok_home: Path, cutoff: datetime):
    root = grok_home / "sessions"
    if not root.is_dir():
        return []
    files = []
    for path in root.glob("*/*/chat_history.jsonl"):
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            files.append((mtime, path))
    files.sort(key=lambda item: item[0], reverse=True)
    return files


def assistant_tool_calls(message):
    """Extract (name, args_text) pairs from OpenAI-style tool_calls entries."""
    calls = []
    for call in message.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        fn = call.get("function") or {}
        name = call.get("name") or fn.get("name") or "unknown"
        args = call.get("arguments")
        if args is None:
            args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args, ensure_ascii=False)
        calls.append((str(name), args))
    return calls


def parse_grok_session(path: Path, skill_names, include_subagents: bool):
    """Normalize one Grok Build chat_history.jsonl to the shared transcript shape.

    Grok stores a session as one flat file; subagent activity appears as
    synthetic_reason injections which are skipped, so include_subagents is
    accepted for signature compatibility and ignored.
    """
    try:
        records = iter_jsonl_records(path)
    except OSError:
        return None

    stats = {"user_turns": 0, "assistant_turns": 0, "tool_calls": 0, "repeated_tool_calls": 0, "error_outputs": 0}
    entries = TranscriptBuffer()
    seen_calls = {}
    used_tool_names = set()
    skills_used = set()
    has_code_edit_hint = False

    for obj in records:
        record_type = obj.get("type")
        if record_type in ("system", "reasoning", "backend_tool_call"):
            continue
        if obj.get("synthetic_reason"):
            continue

        if record_type == "user":
            text = extract_text(obj.get("content"))
            if not text or looks_injected(text):
                continue
            stats["user_turns"] += 1
            entries.append(("user", truncate(text, MAX_MSG_CHARS)))
        elif record_type == "assistant":
            text = extract_text(obj.get("content"))
            if text:
                stats["assistant_turns"] += 1
                entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            for name, args_text in assistant_tool_calls(obj):
                stats["tool_calls"] += 1
                key = hashlib.sha1((name + args_text).encode()).hexdigest()
                seen_calls[key] = seen_calls.get(key, 0) + 1
                if seen_calls[key] > 1:
                    stats["repeated_tool_calls"] += 1
                used_tool_names.add(name)
                skills_used.update(detect_skill_candidates(args_text))
                has_code_edit_hint = has_code_edit_hint or any(
                    hint in args_text for hint in CODE_EDIT_HINTS
                )
                entries.append((f"tool:{name}", truncate(args_text, MAX_TOOL_CHARS)))
        elif record_type == "tool_result":
            result = extract_text(obj.get("content"))
            if not result:
                continue
            low = result[:2000].lower()
            if "error" in low or "failed" in low or "traceback" in low:
                stats["error_outputs"] += 1
            entries.append(("output", truncate(result, MAX_TOOL_CHARS)))

    meta = {
        "id": path.parent.name,
        "cwd": unquote(path.parent.parent.name),
        "started_at": None,
        "originator": "grok",
        "thread_source": None,
    }
    stats["first_ts"] = None
    stats["last_ts"] = None
    stats["has_code_edits"] = (
        bool(used_tool_names & GENERIC_EDIT_TOOLS)
        or has_code_edit_hint
    )
    return meta, stats, entries.finish(), sorted(skills_used & set(skill_names))


def find_zcode_session_files(zcode_home: Path, cutoff: datetime):
    root = zcode_home / "cli" / "rollout"
    if not root.is_dir():
        return []
    files = []
    for path in root.glob("model-io-*.jsonl"):
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            files.append((mtime, path))
    files.sort(key=lambda item: item[0], reverse=True)
    return files


def parse_zcode_session(path: Path, skill_names, include_subagents: bool):
    """Normalize one ZCode model-io rollout to the shared transcript shape.

    Model-io logs are request dumps: only the last request's message list is
    reconstructed, so stats describe the final context window rather than the
    full session.
    """
    try:
        records = iter_jsonl_records(path)
    except OSError:
        return None

    messages = None
    for obj in records:
        if not isinstance(obj, dict):
            continue
        body = (obj.get("request") or {}).get("body") or {}
        candidate = body.get("messages")
        if isinstance(candidate, list) and candidate:
            messages = candidate
    if not messages:
        return None

    stats = {"user_turns": 0, "assistant_turns": 0, "tool_calls": 0, "repeated_tool_calls": 0, "error_outputs": 0}
    entries = TranscriptBuffer()
    seen_calls = {}
    used_tool_names = set()
    skills_used = set()
    has_code_edit_hint = False

    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "user":
            text = extract_text(message.get("content"))
            if not text or looks_injected(text):
                continue
            stats["user_turns"] += 1
            entries.append(("user", truncate(text, MAX_MSG_CHARS)))
        elif role == "assistant":
            text = extract_text(message.get("content"))
            if text:
                stats["assistant_turns"] += 1
                entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            for name, args_text in assistant_tool_calls(message):
                stats["tool_calls"] += 1
                key = hashlib.sha1((name + args_text).encode()).hexdigest()
                seen_calls[key] = seen_calls.get(key, 0) + 1
                if seen_calls[key] > 1:
                    stats["repeated_tool_calls"] += 1
                used_tool_names.add(name)
                skills_used.update(detect_skill_candidates(args_text))
                has_code_edit_hint = has_code_edit_hint or any(
                    hint in args_text for hint in CODE_EDIT_HINTS
                )
                entries.append((f"tool:{name}", truncate(args_text, MAX_TOOL_CHARS)))
        elif role == "tool":
            result = extract_text(message.get("content"))
            if not result:
                continue
            low = result[:2000].lower()
            if "error" in low or "failed" in low or "traceback" in low:
                stats["error_outputs"] += 1
            entries.append(("output", truncate(result, MAX_TOOL_CHARS)))

    entries = entries.finish()
    if not entries:
        return None

    meta = {
        "id": path.stem.removeprefix("model-io-"),
        "cwd": None,
        "started_at": None,
        "originator": "zcode",
        "thread_source": None,
    }
    stats["first_ts"] = None
    stats["last_ts"] = None
    stats["has_code_edits"] = (
        bool(used_tool_names & GENERIC_EDIT_TOOLS)
        or has_code_edit_hint
    )
    return meta, stats, entries, sorted(skills_used & set(skill_names))


def render_transcript(meta, stats, skills_used, entries) -> str:
    lines = [
        f"# Session {meta.get('id')}",
        f"- cwd: {meta.get('cwd')}",
        f"- started: {meta.get('started_at') or stats.get('first_ts')}",
        f"- skills detected: {', '.join(skills_used) or '(none)'}",
        f"- stats: {stats['user_turns']} user turns, {stats['assistant_turns']} assistant turns, "
        f"{stats['tool_calls']} tool calls ({stats['repeated_tool_calls']} repeated), "
        f"{stats['error_outputs']} error-ish outputs, code edits: {stats['has_code_edits']}",
        "",
        "## Condensed transcript",
        "",
    ]
    shown = entries
    if len(entries) > MAX_TRANSCRIPT_ENTRIES:
        omitted = len(entries) - TRANSCRIPT_HEAD - TRANSCRIPT_TAIL
        shown = entries[:TRANSCRIPT_HEAD] + [("note", f"[... {omitted} entries omitted ...]")] + entries[-TRANSCRIPT_TAIL:]
    for role, text in shown:
        lines.append(f"[{role}] {text}")
        lines.append("")
    return "\n".join(lines)


def session_matches_repo(cwd, repo: Path) -> bool:
    """True when a session's recorded cwd belongs to this repo.

    Two ways to match:
    1. cwd is inside the repo root (same-machine sessions).
    2. cwd's trailing directory name equals the repo's name (git/Codex
       worktrees like ~/.codex/worktrees/<id>/<repo-name>, and sessions
       imported from another machine where the checkout path differs).
    Basename matching can over-match if two different projects share a
    directory name; acceptable for a report, and prefix matching alone
    misses every worktree session.
    """
    if not cwd:
        return False
    p = Path(cwd)
    try:
        if p.resolve().is_relative_to(repo):
            return True
    except OSError:
        pass  # cwd from another machine may not exist locally
    return p.name == repo.name or repo.name in p.parts


def session_matches_repos(cwd, repos) -> bool:
    return any(session_matches_repo(cwd, repo) for repo in repos)


def infer_session_repos(sessions):
    repos = []
    seen = set()
    for session in sessions:
        cwd = session["meta"].get("cwd")
        if not cwd:
            continue
        path = Path(cwd).expanduser()
        if not path.is_dir():
            continue
        try:
            result = subprocess.run(
                ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (subprocess.TimeoutExpired, OSError):
            continue
        if result.returncode != 0 or not result.stdout.strip():
            continue
        repo = Path(result.stdout.strip()).resolve()
        if repo in seen:
            continue
        seen.add(repo)
        repos.append(repo)
    return repos


def detect_skills_from_entries(entries, skill_names):
    tool_text = "\n".join(
        text
        for role, text in entries
        if role == "skill" or role.startswith("tool:")
    ).replace("\\", "/")
    detected = set()
    for name in skill_names:
        markers = (
            f"skills/{name}/",
            f"{name}/SKILL.md",
            f'"skill": "{name}"',
            f'"name": "{name}"',
            f'"bundled_skill_id": "{name}"',
        )
        if any(marker in tool_text for marker in markers):
            detected.add(name)
    return detected


def main():
    args = parse_args()
    if args.all_conversations and args.repo:
        print(
            "error: --all-conversations cannot be combined with --repo",
            file=sys.stderr,
        )
        sys.exit(2)
    claude_home = Path(args.claude_home).expanduser()
    codex_home = Path(args.codex_home).expanduser()
    pi_home = Path(args.pi_home).expanduser()
    grok_home = Path(args.grok_home).expanduser()
    zcode_home = Path(args.zcode_home).expanduser()
    out_dir = Path(args.out).expanduser()
    transcripts_dir = out_dir / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)

    repos = [] if args.all_conversations else resolve_repos(args.repo)
    skills = discover_skills(
        repos,
        codex_home,
        args.skills_dir,
        args.include_global_skills,
        pi_home=pi_home,
        grok_home=grok_home,
        zcode_home=zcode_home,
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    sessions = []
    in_scope_count = 0
    scanned_count = 0
    sources = {}

    requested_claude = args.harness in ("auto", "all", "claude")
    if requested_claude and (claude_home / "projects").is_dir():
        claude_files = find_claude_session_files(
            claude_home,
            cutoff,
            args.include_subagents,
        )
        sources["claude"] = {
            "home": str(claude_home),
            "records_in_window": len(claude_files),
        }
        scanned_count += len(claude_files)
        for mtime, path in claude_files:
            parsed = parse_claude_session(path, skills.keys(), args.include_subagents)
            if parsed is None:
                continue
            meta, stats, entries, skills_used = parsed
            if not args.all_conversations and not session_matches_repos(
                meta.get("cwd"),
                repos,
            ):
                continue
            in_scope_count += 1
            if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
                continue
            sessions.append({
                "harness": "claude",
                "meta": meta,
                "stats": stats,
                "skills_used": skills_used,
                "file": str(path),
                "modified_at": mtime.isoformat(),
                "_entries": entries,
            })
    elif args.harness == "claude":
        print(
            f"error: Claude Code project history not found at {claude_home / 'projects'}",
            file=sys.stderr,
        )
        sys.exit(1)

    requested_codex = args.harness in ("auto", "all", "codex")
    if requested_codex and codex_home.is_dir():
        codex_files = find_codex_session_files(codex_home, cutoff)
        sources["codex"] = {"home": str(codex_home), "records_in_window": len(codex_files)}
        scanned_count += len(codex_files)
        for mtime, path in codex_files:
            parsed = parse_codex_session(path, skills.keys(), args.include_subagents)
            if parsed is None:
                continue
            meta, stats, entries, skills_used = parsed
            if not args.all_conversations and not session_matches_repos(
                meta.get("cwd"),
                repos,
            ):
                continue
            in_scope_count += 1
            if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
                continue
            sessions.append({
                "harness": "codex",
                "meta": meta,
                "stats": stats,
                "skills_used": skills_used,
                "file": str(path),
                "modified_at": mtime.isoformat(),
                "_entries": entries,
            })
    elif args.harness == "codex":
        print(f"error: Codex home not found at {codex_home}", file=sys.stderr)
        sys.exit(1)

    requested_pi = args.harness in ("auto", "all", "pi")
    if requested_pi and (pi_home / "sessions").is_dir():
        pi_files = find_pi_session_files(pi_home, cutoff)
        sources["pi"] = {"home": str(pi_home), "records_in_window": len(pi_files)}
        scanned_count += len(pi_files)
        for mtime, path in pi_files:
            parsed = parse_pi_session(path, skills.keys(), args.include_subagents)
            if parsed is None:
                continue
            meta, stats, entries, skills_used = parsed
            if not args.all_conversations and not session_matches_repos(
                meta.get("cwd"),
                repos,
            ):
                continue
            in_scope_count += 1
            if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
                continue
            sessions.append({
                "harness": "pi",
                "meta": meta,
                "stats": stats,
                "skills_used": skills_used,
                "file": str(path),
                "modified_at": mtime.isoformat(),
                "_entries": entries,
            })
    elif args.harness == "pi":
        print(f"error: Pi session home not found at {pi_home / 'sessions'}", file=sys.stderr)
        sys.exit(1)

    requested_grok = args.harness in ("auto", "all", "grok")
    if requested_grok and (grok_home / "sessions").is_dir():
        grok_files = find_grok_session_files(grok_home, cutoff)
        sources["grok"] = {"home": str(grok_home), "records_in_window": len(grok_files)}
        scanned_count += len(grok_files)
        for mtime, path in grok_files:
            parsed = parse_grok_session(path, skills.keys(), args.include_subagents)
            if parsed is None:
                continue
            meta, stats, entries, skills_used = parsed
            if not args.all_conversations and not session_matches_repos(
                meta.get("cwd"),
                repos,
            ):
                continue
            in_scope_count += 1
            if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
                continue
            sessions.append({
                "harness": "grok",
                "meta": meta,
                "stats": stats,
                "skills_used": skills_used,
                "file": str(path),
                "modified_at": mtime.isoformat(),
                "_entries": entries,
            })
    elif args.harness == "grok":
        print(f"error: Grok Build session home not found at {grok_home / 'sessions'}", file=sys.stderr)
        sys.exit(1)

    requested_zcode = args.harness in ("auto", "all", "zcode")
    if requested_zcode and (zcode_home / "cli" / "rollout").is_dir():
        zcode_files = find_zcode_session_files(zcode_home, cutoff)
        sources["zcode"] = {"home": str(zcode_home), "records_in_window": len(zcode_files)}
        scanned_count += len(zcode_files)
        for mtime, path in zcode_files:
            parsed = parse_zcode_session(path, skills.keys(), args.include_subagents)
            if parsed is None:
                continue
            meta, stats, entries, skills_used = parsed
            if not args.all_conversations and not session_matches_repos(
                meta.get("cwd"),
                repos,
            ):
                continue
            in_scope_count += 1
            if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
                continue
            sessions.append({
                "harness": "zcode",
                "meta": meta,
                "stats": stats,
                "skills_used": skills_used,
                "file": str(path),
                "modified_at": mtime.isoformat(),
                "_entries": entries,
            })
    elif args.harness == "zcode":
        print(
            f"error: ZCode model-io rollouts not found at {zcode_home / 'cli' / 'rollout'}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not sources:
        print(
            "error: no supported session source found (Claude Code, Codex, Pi, Grok, or ZCode)",
            file=sys.stderr,
        )
        sys.exit(1)
    if args.all_conversations:
        repos = infer_session_repos(sessions)
        skills = discover_skills(
            repos,
            codex_home,
            args.skills_dir,
            args.include_global_skills,
            pi_home=pi_home,
            grok_home=grok_home,
            zcode_home=zcode_home,
        )
    installed_skill_names = set(skills)
    for session in sessions:
        detected = detect_skills_from_entries(
            session["_entries"],
            installed_skill_names,
        )
        session["skills_used"] = sorted(
            (set(session["skills_used"]) | detected) & installed_skill_names
        )

    sessions.sort(key=lambda session: session["modified_at"], reverse=True)
    for session in sessions:
        session["_key"] = f"{session['harness']}:{session['meta']['id']}"

    # Sample: newest-first, up to per-skill sessions per skill, then no-skill sessions.
    sampled_keys = set()
    per_skill_count = {name: 0 for name in skills}
    for s in sessions:
        if len(sampled_keys) >= args.max_sessions:
            break
        for name in s["skills_used"]:
            if per_skill_count.get(name, 0) < args.per_skill:
                per_skill_count[name] = per_skill_count.get(name, 0) + 1
                sampled_keys.add(s["_key"])
                break
    no_skill_taken = 0
    for s in sessions:
        if len(sampled_keys) >= args.max_sessions or no_skill_taken >= args.no_skill:
            break
        if not s["skills_used"] and s["_key"] not in sampled_keys:
            sampled_keys.add(s["_key"])
            no_skill_taken += 1

    for s in sessions:
        sid = s["meta"]["id"]
        s["sampled"] = s["_key"] in sampled_keys
        if s["sampled"]:
            tpath = transcripts_dir / f"{s['harness']}-{sid}.md"
            tpath.write_text(render_transcript(s["meta"], s["stats"], s["skills_used"], s["_entries"]))
            s["transcript_path"] = str(tpath)
        del s["_entries"]
        del s["_key"]

    skill_usage = {name: 0 for name in skills}
    for s in sessions:
        for name in s["skills_used"]:
            skill_usage[name] += 1

    if args.all_conversations:
        conversation_scope = "all"
        scope_name = "all-conversations"
    elif len(repos) == 1:
        conversation_scope = "projects"
        scope_name = repos[0].name
    else:
        conversation_scope = "projects"
        scope_name = "multiple-projects"

    inventory = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "harness": next(iter(sources)) if len(sources) == 1 else "mixed",
        "sources": sources,
        "claude_home": str(claude_home) if "claude" in sources else None,
        "codex_home": str(codex_home) if "codex" in sources else None,
        "pi_home": str(pi_home) if "pi" in sources else None,
        "grok_home": str(grok_home) if "grok" in sources else None,
        "zcode_home": str(zcode_home) if "zcode" in sources else None,
        "conversation_scope": conversation_scope,
        "repo": str(repos[0]) if len(repos) == 1 else None,
        "repos": [str(repo) for repo in repos],
        "repo_name": scope_name,
        "repo_names": [repo.name for repo in repos],
        "window_days": args.days,
        "skills": sorted(skills.values(), key=lambda x: x["name"]),
        "skill_usage": skill_usage,
        "stats": {
            "session_files_in_window": scanned_count,
            "session_records_in_window": scanned_count,
            "sessions_in_repo": in_scope_count,
            "sessions_in_scope": in_scope_count,
            "sessions_considered": len(sessions),
            "sessions_sampled": len(sampled_keys),
            "skills_found": len(skills),
            "skills_used": sum(1 for v in skill_usage.values() if v > 0),
        },
        "sessions": sessions,
    }
    (out_dir / "inventory.json").write_text(json.dumps(inventory, indent=2))

    st = inventory["stats"]
    print(
        "scope:             "
        + (
            "all conversations"
            if args.all_conversations
            else ", ".join(str(repo) for repo in repos)
        )
    )
    print(f"sources:           {', '.join(sources)}")
    print(f"skills found:      {st['skills_found']} ({st['skills_used']} used in window)")
    print(f"sessions in window: {st['session_records_in_window']} records, {st['sessions_in_scope']} in scope, {st['sessions_considered']} scoreable")
    print(f"sessions sampled:  {st['sessions_sampled']} -> {transcripts_dir}")
    print(f"inventory:         {out_dir / 'inventory.json'}")


if __name__ == "__main__":
    main()

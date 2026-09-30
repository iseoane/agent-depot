#!/usr/bin/env python3
"""Gather local agent-session history (Claude Code, Codex, Pi, Grok Build, ZCode) for scoring.

The script looks through the session logs each supported harness leaves on
disk, finds the skills installed for the chosen projects, works out which
sessions touched which skills, picks a sample, and writes:

  <out>/inventory.json        - skills, per-session stats, sampling decisions
  <out>/transcripts/<id>.md   - condensed transcripts for the sampled sessions

Everything happens on the local machine; nothing is sent anywhere.
Python 3.9+, standard library only.

Design in one paragraph: every harness has a small *reader* class that turns
its native log format into one flat stream of neutral events (a user said
something, a tool was called, a tool returned...). A single digest routine
consumes any such stream and produces the statistics, the condensed
transcript entries and the set of skills seen, so the counting rules live in
exactly one place.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, NamedTuple
from urllib.parse import unquote

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

CHAT_CLIP = 1500          # characters kept from a user/assistant message
TOOL_CLIP = 500           # characters kept from a tool call or tool output
ENTRY_CEILING = 160       # transcripts longer than this are cut down
KEEP_FIRST = 100          # entries retained from the start of a long transcript
KEEP_LAST = 40            # entries retained from the end of a long transcript
ERROR_SCAN_WINDOW = 2000  # leading characters of an output searched for failure words

EDIT_MARKERS = ("apply_patch", "*** Begin Patch", "edit_file", "create_file", "str_replace", "write_file")
CLAUDE_EDIT_TOOLS = frozenset({"Edit", "MultiEdit", "NotebookEdit", "Write"})
COMMON_EDIT_TOOLS = frozenset({"edit", "write", "apply_patch", "edit_file", "write_file", "str_replace", "search_replace"})
FAILURE_WORDS = ("error", "failed", "traceback")
INJECTED_TAGS = (
    "environment_context", "user_instructions", "ENVIRONMENT", "system-reminder",
    "permissions", "collaboration_mode", "recommended_plugins", "turn_context",
    "user_info",
)
SKILL_MENTION_PATTERNS = (
    re.compile(r"(?:^|/)skills/+([^/]+)/+"),
    re.compile(r'"(?:skill|name|bundled_skill_id)"\s*:\s*"([^"]+)"'),
)
GIT_TIMEOUT_SECONDS = 10


# ---------------------------------------------------------------------------
# Small text helpers
# ---------------------------------------------------------------------------

def clip(text: str, limit: int) -> str:
    """Trim whitespace and cap the length, noting how much was dropped."""
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]} …[truncated {len(text) - limit} chars]"


def stringify(value) -> str:
    """Render a tool argument / output payload as text."""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def flatten_text(content) -> str:
    """Join the textual parts of a message body (string or list of blocks)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    pieces = []
    for block in content:
        if isinstance(block, str):
            pieces.append(block)
        elif isinstance(block, dict):
            piece = block.get("text") or block.get("content") or ""
            if isinstance(piece, str) and piece:
                pieces.append(piece)
    return "\n".join(pieces)


def is_harness_injection(text: str) -> bool:
    """True for text a harness injects on the user's behalf (system reminders etc.)."""
    opening = text.lstrip()[:80]
    return opening.startswith("<") and any(tag in opening for tag in INJECTED_TAGS)


def mentions_failure(text: str) -> bool:
    window = text[:ERROR_SCAN_WINDOW].lower()
    return any(word in window for word in FAILURE_WORDS)


def skill_mentions(text: str) -> set:
    """Names that look like installed skills inside one tool-call payload."""
    text = text.replace("\\", "/")
    found = set()
    for pattern in SKILL_MENTION_PATTERNS:
        found.update(pattern.findall(text))
    return found


def message_blocks(content) -> list:
    """Normalise a message body to a list of content blocks."""
    return content if isinstance(content, list) else [{"type": "text", "text": content}]


def read_jsonl(path: Path) -> Iterator[dict]:
    """Stream the JSON objects of a JSONL file, one line at a time."""
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            try:
                obj = json.loads(raw)
            except ValueError:
                continue
            if isinstance(obj, dict):
                yield obj


def file_mtime(path: Path):
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return None


def recent_files(paths, cutoff: datetime):
    """Pair each path with its mtime, drop stale ones, order newest first."""
    hits = []
    for path in paths:
        stamp = file_mtime(path)
        if stamp is not None and stamp >= cutoff:
            hits.append((stamp, path))
    hits.sort(key=lambda pair: pair[0], reverse=True)
    return hits


# ---------------------------------------------------------------------------
# Neutral event stream
# ---------------------------------------------------------------------------

STAMP = "stamp"            # text = a timestamp seen in the log
USER_TURN = "user_turn"    # one human turn happened
AGENT_TURN = "agent_turn"  # one assistant turn happened
USER_SAID = "user_said"    # text = transcript-worthy user message
AGENT_SAID = "agent_said"  # text = transcript-worthy assistant message
TOOL_CALL = "tool_call"    # name = tool, text = serialized arguments
TOOL_OUTPUT = "tool_output"  # text = output, failed = harness flagged an error
SKILL_HINT = "skill_hint"  # text = a skill name the harness stated explicitly


class Event(NamedTuple):
    kind: str
    text: str = ""
    name: str = ""
    failed: bool = False


class SkipSession(Exception):
    """Raised by a reader to say the session must be left out entirely."""


class EntryLog:
    """Ordered transcript entries; long logs keep a head and a tail only."""

    def __init__(self):
        self._front = []
        self._back = None
        self._seen = 0

    def __len__(self):
        return self._seen

    def add(self, role: str, text: str):
        self._seen += 1
        if self._back is not None:
            self._back.append((role, text))
            return
        self._front.append((role, text))
        if len(self._front) > ENTRY_CEILING:
            self._back = deque(self._front[-KEEP_LAST:], maxlen=KEEP_LAST)
            del self._front[KEEP_FIRST:]

    def entries(self):
        if self._back is None:
            return self._front
        dropped = self._seen - KEEP_FIRST - KEEP_LAST
        marker = ("note", f"[... {dropped} entries omitted ...]")
        return [*self._front, marker, *self._back]


# ---------------------------------------------------------------------------
# Readers: one per harness, each translating a log file into Events
# ---------------------------------------------------------------------------

class Reader:
    """Base class. Subclasses describe where a harness keeps sessions and how to decode them."""

    key = ""
    restrict_skills = True             # intersect detected skills with the known set
    edit_tools = COMMON_EDIT_TOOLS     # tool names that imply code edits
    drop_when_silent = False           # discard sessions that yield no transcript entries

    def __init__(self, path: Path, include_subagents: bool = False):
        self.path = path
        self.include_subagents = include_subagents

    # -- discovery ---------------------------------------------------------
    @classmethod
    def required_dir(cls, home: Path) -> Path:
        raise NotImplementedError

    @classmethod
    def absence_message(cls, home: Path) -> str:
        raise NotImplementedError

    @classmethod
    def locate(cls, home: Path, cutoff: datetime, include_subagents: bool = False):
        raise NotImplementedError

    # -- decoding ----------------------------------------------------------
    def events(self) -> Iterator[Event]:
        raise NotImplementedError

    def build_meta(self, first_ts) -> dict:
        raise NotImplementedError


class ClaudeReader(Reader):
    key = "claude"
    restrict_skills = False
    edit_tools = CLAUDE_EDIT_TOOLS

    def __init__(self, path, include_subagents=False):
        super().__init__(path, include_subagents)
        self._meta = {}
        self._sidechain = False
        self._counted_messages = set()

    @classmethod
    def required_dir(cls, home):
        return home / "projects"

    @classmethod
    def absence_message(cls, home):
        return f"Claude Code project history not found at {home / 'projects'}"

    @classmethod
    def locate(cls, home, cutoff, include_subagents=False):
        root = home / "projects"
        if not root.is_dir():
            return []
        paths = list(root.glob("*/*.jsonl"))
        if include_subagents:
            paths += root.glob("*/*/subagents/*.jsonl")
        return recent_files(paths, cutoff)

    def _track_envelope(self, obj, ts):
        agent = obj.get("agentId")
        if not self._meta:
            if not obj.get("sessionId"):
                return
            sid = obj["sessionId"]
            self._meta = {
                "id": f"{sid}-{agent}" if agent else sid,
                "cwd": obj.get("cwd"),
                "started_at": ts,
                "originator": "claude-code",
                "thread_source": "subagent" if obj.get("isSidechain") else None,
                "cli_version": obj.get("version"),
                "entrypoint": obj.get("entrypoint"),
            }
            return
        meta = self._meta
        for field, value in (("cwd", obj.get("cwd")), ("started_at", ts),
                             ("cli_version", obj.get("version")),
                             ("entrypoint", obj.get("entrypoint"))):
            meta[field] = meta.get(field) or value
        if agent and not meta["id"].endswith(f"-{agent}"):
            meta["id"] = f"{obj.get('sessionId') or meta['id']}-{agent}"

    def events(self):
        for obj in read_jsonl(self.path):
            ts = obj.get("timestamp")
            if ts:
                yield Event(STAMP, ts)
            if obj.get("isSidechain"):
                self._sidechain = True
                if not self.include_subagents:
                    raise SkipSession
            self._track_envelope(obj, ts)

            message = obj.get("message")
            if obj.get("type") not in ("user", "assistant") or not isinstance(message, dict):
                continue
            yield from self._decode_message(obj, message)

    def _decode_message(self, obj, message):
        role = message.get("role") or obj.get("type")
        if role == "assistant":
            msg_id = message.get("id") or obj.get("uuid")
            if msg_id and msg_id not in self._counted_messages:
                self._counted_messages.add(msg_id)
                yield Event(AGENT_TURN)
        human_spoke = False
        for block in message_blocks(message.get("content")):
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text = block.get("text")
                if not isinstance(text, str) or not text or is_harness_injection(text):
                    continue
                if role == "user":
                    human_spoke = True
                    yield Event(USER_SAID, text)
                elif role == "assistant":
                    yield Event(AGENT_SAID, text)
            elif btype == "tool_use":
                name = str(block.get("name") or "unknown")
                args = block.get("input") or {}
                yield Event(TOOL_CALL, stringify(args), name)
                if name == "Skill" and isinstance(args, dict) and args.get("skill"):
                    yield Event(SKILL_HINT, args["skill"])
            elif btype == "tool_result":
                yield Event(TOOL_OUTPUT, flatten_text(block.get("content")),
                            failed=bool(block.get("is_error")))
        if role == "user" and human_spoke:
            yield Event(USER_TURN)

    def build_meta(self, first_ts):
        if not self._meta:
            return {
                "id": self.path.stem,
                "cwd": None,
                "started_at": first_ts,
                "originator": "claude-code",
                "thread_source": "subagent" if self._sidechain else None,
            }
        if self._sidechain:
            self._meta["thread_source"] = "subagent"
        return self._meta


class CodexReader(Reader):
    key = "codex"
    restrict_skills = False
    edit_tools = frozenset()
    _CALL_TYPES = ("function_call", "custom_tool_call", "local_shell_call")
    _OUTPUT_TYPES = ("function_call_output", "custom_tool_call_output")

    def __init__(self, path, include_subagents=False):
        super().__init__(path, include_subagents)
        self._meta = {}

    @classmethod
    def required_dir(cls, home):
        return home

    @classmethod
    def absence_message(cls, home):
        return f"Codex home not found at {home}"

    @classmethod
    def locate(cls, home, cutoff, include_subagents=False):
        paths = []
        for sub in ("sessions", "archived_sessions"):
            folder = home / sub
            if folder.is_dir():
                paths.extend(folder.rglob("rollout-*.jsonl"))
        return recent_files(paths, cutoff)

    def _read_header(self, payload):
        self._meta = {
            "id": payload.get("id") or payload.get("session_id") or self.path.stem,
            "cwd": payload.get("cwd"),
            "started_at": payload.get("timestamp"),
            "originator": payload.get("originator"),
            "thread_source": payload.get("thread_source"),
            "cli_version": payload.get("cli_version"),
        }
        origin = payload.get("source")
        delegated = payload.get("thread_source") == "subagent" or (
            isinstance(origin, dict) and "subagent" in origin
        )
        if delegated and not self.include_subagents:
            raise SkipSession

    def events(self):
        for obj in read_jsonl(self.path):
            payload = obj.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if obj.get("timestamp"):
                yield Event(STAMP, obj["timestamp"])
            record = obj.get("type")
            inner = payload.get("type")
            if record == "session_meta":
                self._read_header(payload)
            elif record == "event_msg":
                if inner == "user_message":
                    yield Event(USER_TURN)
                elif inner == "agent_message":
                    yield Event(AGENT_TURN)
            elif record == "response_item":
                yield from self._decode_item(payload, inner)

    def _decode_item(self, payload, inner):
        if inner == "message":
            text = flatten_text(payload.get("content"))
            role = payload.get("role")
            if not text:
                return
            if role == "user" and not is_harness_injection(text):
                yield Event(USER_SAID, text)
            elif role == "assistant":
                yield Event(AGENT_SAID, text)
        elif inner in self._CALL_TYPES:
            args = payload.get("arguments") or payload.get("input") or ""
            yield Event(TOOL_CALL, stringify(args), payload.get("name") or inner)
        elif inner in self._OUTPUT_TYPES:
            yield Event(TOOL_OUTPUT, stringify(payload.get("output") or ""))

    def build_meta(self, first_ts):
        return self._meta or {"id": self.path.stem, "cwd": None, "started_at": first_ts}


class PiReader(Reader):
    key = "pi"

    def __init__(self, path, include_subagents=False):
        super().__init__(path, include_subagents)
        self._meta = {}

    @classmethod
    def required_dir(cls, home):
        return home / "sessions"

    @classmethod
    def absence_message(cls, home):
        return f"Pi session home not found at {home / 'sessions'}"

    @classmethod
    def locate(cls, home, cutoff, include_subagents=False):
        root = home / "sessions"
        return recent_files(root.glob("*/*.jsonl"), cutoff) if root.is_dir() else []

    def _read_header(self, obj):
        ts = obj.get("timestamp")
        if not self._meta:
            self._meta = {
                "id": obj.get("id") or self.path.stem,
                "cwd": obj.get("cwd"),
                "started_at": ts,
                "originator": "pi",
                "thread_source": None,
            }
        else:
            self._meta["cwd"] = self._meta.get("cwd") or obj.get("cwd")
            self._meta["started_at"] = self._meta.get("started_at") or ts

    def events(self):
        for obj in read_jsonl(self.path):
            if obj.get("timestamp"):
                yield Event(STAMP, obj["timestamp"])
            kind = obj.get("type")
            if kind == "session":
                self._read_header(obj)
            elif kind == "message" and isinstance(obj.get("message"), dict):
                yield from self._decode_message(obj["message"])

    def _decode_message(self, message):
        role = message.get("role")
        blocks = message_blocks(message.get("content"))
        if role == "toolResult":
            message_failed = bool(message.get("isError"))
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                text = block.get("text") or ""
                if isinstance(text, str) and text:
                    yield Event(TOOL_OUTPUT, text, failed=message_failed or bool(block.get("isError")))
            return
        if role == "assistant":
            yield Event(AGENT_TURN)
        human_spoke = False
        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text = block.get("text")
                if not isinstance(text, str) or not text or is_harness_injection(text):
                    continue
                if role == "user":
                    human_spoke = True
                    yield Event(USER_SAID, text)
                elif role == "assistant":
                    yield Event(AGENT_SAID, text)
            elif btype == "toolCall":
                yield Event(TOOL_CALL, stringify(block.get("arguments") or {}),
                            str(block.get("name") or "unknown"))
        if role == "user" and human_spoke:
            yield Event(USER_TURN)

    def build_meta(self, first_ts):
        return self._meta or {
            "id": self.path.stem,
            "cwd": None,
            "started_at": first_ts,
            "originator": "pi",
            "thread_source": None,
        }


def openai_style_calls(message) -> list:
    """(tool name, argument text) pairs from an OpenAI-style `tool_calls` list."""
    pairs = []
    for call in message.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        function = call.get("function") or {}
        name = call.get("name") or function.get("name") or "unknown"
        args = call.get("arguments")
        if args is None:
            args = function.get("arguments")
        pairs.append((str(name), stringify(args)))
    return pairs


def chat_events(role: str, message: dict) -> Iterator[Event]:
    """Events for one chat-completions style message; role is user/assistant/result."""
    text = flatten_text(message.get("content"))
    if role == "user":
        if text and not is_harness_injection(text):
            yield Event(USER_TURN)
            yield Event(USER_SAID, text)
    elif role == "assistant":
        if text:
            yield Event(AGENT_TURN)
            yield Event(AGENT_SAID, text)
        for name, args in openai_style_calls(message):
            yield Event(TOOL_CALL, args, name)
    elif role == "result" and text:
        yield Event(TOOL_OUTPUT, text)


class GrokReader(Reader):
    key = "grok"
    _IGNORED_TYPES = ("system", "reasoning", "backend_tool_call")
    _ROLE_OF_TYPE = {"user": "user", "assistant": "assistant", "tool_result": "result"}

    @classmethod
    def required_dir(cls, home):
        return home / "sessions"

    @classmethod
    def absence_message(cls, home):
        return f"Grok Build session home not found at {home / 'sessions'}"

    @classmethod
    def locate(cls, home, cutoff, include_subagents=False):
        root = home / "sessions"
        return recent_files(root.glob("*/*/chat_history.jsonl"), cutoff) if root.is_dir() else []

    def events(self):
        for obj in read_jsonl(self.path):
            if obj.get("type") in self._IGNORED_TYPES or obj.get("synthetic_reason"):
                continue
            role = self._ROLE_OF_TYPE.get(obj.get("type"))
            if role:
                yield from chat_events(role, obj)

    def build_meta(self, first_ts):
        return {
            "id": self.path.parent.name,
            "cwd": unquote(self.path.parent.parent.name),
            "started_at": None,
            "originator": "grok",
            "thread_source": None,
        }


class ZcodeReader(Reader):
    key = "zcode"
    drop_when_silent = True
    _ROLE_OF_ROLE = {"user": "user", "assistant": "assistant", "tool": "result"}

    @classmethod
    def required_dir(cls, home):
        return home / "cli" / "rollout"

    @classmethod
    def absence_message(cls, home):
        return f"ZCode model-io rollouts not found at {home / 'cli' / 'rollout'}"

    @classmethod
    def locate(cls, home, cutoff, include_subagents=False):
        root = home / "cli" / "rollout"
        return recent_files(root.glob("model-io-*.jsonl"), cutoff) if root.is_dir() else []

    def events(self):
        # Each line is a full request dump; only the final non-empty message
        # list describes the session as it ended, so keep just that one.
        latest = None
        for obj in read_jsonl(self.path):
            body = (obj.get("request") or {}).get("body") or {}
            batch = body.get("messages")
            if isinstance(batch, list) and batch:
                latest = batch
        if not latest:
            raise SkipSession
        for message in latest:
            if isinstance(message, dict):
                role = self._ROLE_OF_ROLE.get(message.get("role"))
                if role:
                    yield from chat_events(role, message)

    def build_meta(self, first_ts):
        stem = self.path.stem
        prefix = "model-io-"
        return {
            "id": stem[len(prefix):] if stem.startswith(prefix) else stem,
            "cwd": None,
            "started_at": None,
            "originator": "zcode",
            "thread_source": None,
        }


READERS = {cls.key: cls for cls in (ClaudeReader, CodexReader, PiReader, GrokReader, ZcodeReader)}


# ---------------------------------------------------------------------------
# Digest: the single place where events become statistics and transcript
# ---------------------------------------------------------------------------

def digest_session(reader: Reader, known_skills):
    """Consume a reader's events -> (meta, stats, entries, skills) or None to skip."""
    known = set(known_skills)
    tally = Counter()
    calls_seen = set()
    tools_used = set()
    skills = set()
    log = EntryLog()
    first_ts = last_ts = None
    edit_marker_hit = False

    try:
        for ev in reader.events():
            kind = ev.kind
            if kind == STAMP:
                first_ts = first_ts or ev.text
                last_ts = ev.text
            elif kind == USER_TURN:
                tally["user_turns"] += 1
            elif kind == AGENT_TURN:
                tally["assistant_turns"] += 1
            elif kind == USER_SAID:
                log.add("user", clip(ev.text, CHAT_CLIP))
            elif kind == AGENT_SAID:
                log.add("assistant", clip(ev.text, CHAT_CLIP))
            elif kind == TOOL_CALL:
                tally["tool_calls"] += 1
                signature = (ev.name, ev.text)
                if signature in calls_seen:
                    tally["repeated_tool_calls"] += 1
                calls_seen.add(signature)
                tools_used.add(ev.name)
                skills |= skill_mentions(ev.text)
                edit_marker_hit = edit_marker_hit or any(m in ev.text for m in EDIT_MARKERS)
                log.add(f"tool:{ev.name}", clip(ev.text, TOOL_CLIP))
            elif kind == TOOL_OUTPUT:
                if ev.failed or mentions_failure(ev.text):
                    tally["error_outputs"] += 1
                log.add("output", clip(ev.text, TOOL_CLIP))
            elif kind == SKILL_HINT:
                skills.add(ev.text)
    except (SkipSession, OSError):
        return None

    if reader.drop_when_silent and not len(log):
        return None

    stats = {
        name: tally[name]
        for name in ("user_turns", "assistant_turns", "tool_calls",
                     "repeated_tool_calls", "error_outputs")
    }
    stats["first_ts"] = first_ts
    stats["last_ts"] = last_ts
    stats["has_code_edits"] = bool(tools_used & reader.edit_tools) or edit_marker_hit
    if reader.restrict_skills:
        skills &= known
    return reader.build_meta(first_ts), stats, log.entries(), sorted(skills)


# Stable module-level entry points (other scripts import these).

def find_claude_session_files(claude_home: Path, cutoff: datetime, include_subagents: bool):
    return ClaudeReader.locate(claude_home, cutoff, include_subagents)


def parse_claude_session(path: Path, skill_names, include_subagents: bool):
    return digest_session(ClaudeReader(path, include_subagents), skill_names)


def find_codex_session_files(codex_home: Path, cutoff: datetime):
    return CodexReader.locate(codex_home, cutoff)


def parse_codex_session(path: Path, skill_names, include_subagents: bool):
    return digest_session(CodexReader(path, include_subagents), skill_names)


def find_pi_session_files(pi_home: Path, cutoff: datetime):
    return PiReader.locate(pi_home, cutoff)


def parse_pi_session(path: Path, skill_names, include_subagents: bool):
    return digest_session(PiReader(path, include_subagents), skill_names)


def find_grok_session_files(grok_home: Path, cutoff: datetime):
    return GrokReader.locate(grok_home, cutoff)


def parse_grok_session(path: Path, skill_names, include_subagents: bool):
    return digest_session(GrokReader(path, include_subagents), skill_names)


def find_zcode_session_files(zcode_home: Path, cutoff: datetime):
    return ZcodeReader.locate(zcode_home, cutoff)


def parse_zcode_session(path: Path, skill_names, include_subagents: bool):
    return digest_session(ZcodeReader(path, include_subagents), skill_names)


# ---------------------------------------------------------------------------
# Repositories and skills
# ---------------------------------------------------------------------------

def git_toplevel(directory=None):
    """Repository root containing `directory` (or the cwd), or None."""
    command = ["git"] + (["-C", str(directory)] if directory else []) + ["rev-parse", "--show-toplevel"]
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        return None
    top = done.stdout.strip()
    return Path(top).resolve() if done.returncode == 0 and top else None


def resolve_project_roots(explicit):
    """Turn --repo values into distinct absolute paths (default: git root of cwd)."""
    if not explicit:
        return [git_toplevel() or Path.cwd().resolve()]
    roots = []
    for value in explicit:
        root = Path(value).expanduser().resolve()
        if root not in roots:
            roots.append(root)
    return roots


def cwd_belongs_to(cwd, repo: Path) -> bool:
    """Does a session's recorded working directory belong to `repo`?

    Accepts a cwd nested under the repo root, and also any cwd whose last
    component (or any component) equals the repo's directory name; that
    catches worktrees stored elsewhere and sessions copied from another
    machine. Name matching can be generous when unrelated projects share a
    folder name, which is acceptable for a report.
    """
    if not cwd:
        return False
    location = Path(cwd)
    try:
        location.resolve().relative_to(repo)
        return True
    except (ValueError, OSError):
        pass
    return location.name == repo.name or repo.name in location.parts


def session_matches_repos(cwd, repos) -> bool:
    return any(cwd_belongs_to(cwd, repo) for repo in repos)


def repos_seen_in(sessions):
    """Git roots of every existing working directory the sessions recorded."""
    roots = []
    for session in sessions:
        cwd = session["meta"].get("cwd")
        if not cwd:
            continue
        folder = Path(cwd).expanduser()
        if not folder.is_dir():
            continue
        top = git_toplevel(folder)
        if top is not None and top not in roots:
            roots.append(top)
    return roots


def skill_search_roots(repos, codex_home, extra_dirs, include_global, pi_home, grok_home, zcode_home):
    roots = []
    for repo in repos:
        roots += [repo / ".agents" / "skills", repo / ".claude" / "skills", repo / ".codex" / "skills"]
    if include_global:
        roots += [codex_home / "skills", Path.home() / ".agents" / "skills", Path.home() / ".claude" / "skills"]
        roots += [Path(home) / "skills" for home in (pi_home, grok_home, zcode_home) if home is not None]
    roots += [Path(extra).expanduser() for extra in extra_dirs]
    return roots


def describe_skill(manifest: Path):
    try:
        body = manifest.read_text(errors="replace")
        info = manifest.stat()
    except OSError:
        return None
    found = re.search(r"^description:\s*(.+)$", body, re.MULTILINE)
    summary = found.group(1).strip().strip("\"'")[:300] if found else ""
    return {
        "name": manifest.parent.name,
        "path": str(manifest),
        "description": summary,
        "bytes": info.st_size,
        "modified_at": datetime.fromtimestamp(info.st_mtime, tz=timezone.utc).isoformat(),
    }


def discover_skills(repos, codex_home: Path, extra_dirs, include_global: bool,
                    pi_home: Path = None, grok_home: Path = None, zcode_home: Path = None):
    """Map skill name -> descriptor; the first root that provides a name wins."""
    if isinstance(repos, Path):
        repos = [repos]
    catalogue = {}
    for root in skill_search_roots(repos, codex_home, extra_dirs, include_global,
                                   pi_home, grok_home, zcode_home):
        if not root.is_dir():
            continue
        for manifest in sorted(root.glob("*/SKILL.md")):
            if manifest.parent.name in catalogue:
                continue
            entry = describe_skill(manifest)
            if entry is not None:
                catalogue[entry["name"]] = entry
    return catalogue


def detect_skills_from_entries(entries, skill_names):
    """Skills referenced by tool-call entries (chat text is deliberately ignored)."""
    haystack = "\n".join(
        text for role, text in entries if role == "skill" or role.startswith("tool:")
    ).replace("\\", "/")
    hits = set()
    for name in skill_names:
        signs = (
            f"skills/{name}/",
            f"{name}/SKILL.md",
            f'"skill": "{name}"',
            f'"name": "{name}"',
            f'"bundled_skill_id": "{name}"',
        )
        if any(sign in haystack for sign in signs):
            hits.add(name)
    return hits


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------

def sample_by_skill(sessions, limit, per_skill, no_skill, skill_names):
    """Fill the sample per skill first, then top up with skill-less sessions."""
    chosen = set()
    quota_used = {name: 0 for name in skill_names}
    for item in sessions:
        if len(chosen) >= limit:
            break
        for name in item["skills_used"]:
            if quota_used.get(name, 0) < per_skill:
                quota_used[name] = quota_used.get(name, 0) + 1
                chosen.add(item["_key"])
                break
    plain_taken = 0
    for item in sessions:
        if len(chosen) >= limit or plain_taken >= no_skill:
            break
        if not item["skills_used"] and item["_key"] not in chosen:
            chosen.add(item["_key"])
            plain_taken += 1
    return chosen


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def render_transcript(meta, stats, skills_used, entries) -> str:
    header = [
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
    body = []
    for role, text in entries:
        body += [f"[{role}] {text}", ""]
    return "\n".join(header + body)


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", choices=("auto", "all", *READERS), default="auto",
                    help="session source (default: auto; scans every locally available source)")
    ap.add_argument("--claude-home", default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"),
                    help="Claude Code config directory (default: CLAUDE_CONFIG_DIR or ~/.claude)")
    ap.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    ap.add_argument("--pi-home", default="~/.pi/agent", help="Pi agent home (default: ~/.pi/agent)")
    ap.add_argument("--grok-home", default="~/.grok", help="Grok Build home (default: ~/.grok)")
    ap.add_argument("--zcode-home", default="~/.zcode", help="ZCode home (default: ~/.zcode)")
    ap.add_argument("--repo", action="append", default=[],
                    help="project to include (repeatable; default: git root of cwd, else cwd)")
    ap.add_argument("--all-conversations", action="store_true",
                    help="score conversations from every project represented in local history")
    ap.add_argument("--include-global-skills", action="store_true",
                    help="also discover skills outside the repo (~/.codex/skills, ~/.agents/skills, "
                         "~/.claude/skills, ~/.pi/agent/skills, ~/.grok/skills, ~/.zcode/skills)")
    ap.add_argument("--days", type=int, default=45, help="only consider sessions modified in the last N days")
    ap.add_argument("--max-sessions", type=int, default=12, help="max sessions to sample for scoring")
    ap.add_argument("--per-skill", type=int, default=3, help="max sampled sessions per skill")
    ap.add_argument("--no-skill", type=int, default=4, help="max sampled sessions that used no skill")
    ap.add_argument("--skills-dir", action="append", default=[], help="extra skills directory to scan (repeatable)")
    ap.add_argument("--include-subagents", action="store_true", help="include subagent/child sessions")
    ap.add_argument("--out", default="./doctor-md-skill-report")
    return ap.parse_args()


class Scan:
    """Running totals while the selected sources are read."""

    def __init__(self):
        self.sessions = []
        self.sources = {}
        self.files_seen = 0
        self.in_scope = 0


def scan_source(reader_cls, home, args, cutoff, skills, repos, scan: Scan):
    files = reader_cls.locate(home, cutoff, args.include_subagents)
    scan.sources[reader_cls.key] = {"home": str(home), "records_in_window": len(files)}
    scan.files_seen += len(files)
    for mtime, path in files:
        parsed = digest_session(reader_cls(path, args.include_subagents), skills.keys())
        if parsed is None:
            continue
        meta, stats, entries, used = parsed
        if not args.all_conversations and not session_matches_repos(meta.get("cwd"), repos):
            continue
        scan.in_scope += 1
        if stats["assistant_turns"] < 1 or stats["tool_calls"] < 1:
            continue
        scan.sessions.append({
            "harness": reader_cls.key,
            "meta": meta,
            "stats": stats,
            "skills_used": used,
            "file": str(path),
            "modified_at": mtime.isoformat(),
            "_entries": entries,
        })


def main():
    args = parse_args()
    if args.all_conversations and args.repo:
        print("error: --all-conversations cannot be combined with --repo", file=sys.stderr)
        sys.exit(2)

    homes = {
        "claude": Path(args.claude_home).expanduser(),
        "codex": Path(args.codex_home).expanduser(),
        "pi": Path(args.pi_home).expanduser(),
        "grok": Path(args.grok_home).expanduser(),
        "zcode": Path(args.zcode_home).expanduser(),
    }
    out_dir = Path(args.out).expanduser()
    transcripts_dir = out_dir / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)

    def find_skills(repo_list):
        return discover_skills(repo_list, homes["codex"], args.skills_dir, args.include_global_skills,
                               pi_home=homes["pi"], grok_home=homes["grok"], zcode_home=homes["zcode"])

    repos = [] if args.all_conversations else resolve_project_roots(args.repo)
    skills = find_skills(repos)
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    scan = Scan()
    for key, reader_cls in READERS.items():
        home = homes[key]
        wanted = args.harness in ("auto", "all", key)
        if wanted and reader_cls.required_dir(home).is_dir():
            scan_source(reader_cls, home, args, cutoff, skills, repos, scan)
        elif args.harness == key:
            print(f"error: {reader_cls.absence_message(home)}", file=sys.stderr)
            sys.exit(1)

    if not scan.sources:
        print("error: no supported session source found (Claude Code, Codex, Pi, Grok, or ZCode)",
              file=sys.stderr)
        sys.exit(1)

    sessions = scan.sessions
    if args.all_conversations:
        repos = repos_seen_in(sessions)
        skills = find_skills(repos)
    installed = set(skills)
    for session in sessions:
        extra = detect_skills_from_entries(session["_entries"], installed)
        session["skills_used"] = sorted((set(session["skills_used"]) | extra) & installed)

    sessions.sort(key=lambda item: item["modified_at"], reverse=True)
    for session in sessions:
        session["_key"] = f"{session['harness']}:{session['meta']['id']}"

    chosen = sample_by_skill(sessions, args.max_sessions, args.per_skill, args.no_skill, skills)

    for session in sessions:
        session["sampled"] = session["_key"] in chosen
        if session["sampled"]:
            target = transcripts_dir / f"{session['harness']}-{session['meta']['id']}.md"
            target.write_text(render_transcript(session["meta"], session["stats"],
                                                session["skills_used"], session["_entries"]))
            session["transcript_path"] = str(target)
        del session["_entries"]
        del session["_key"]

    usage = {name: 0 for name in skills}
    for session in sessions:
        for name in session["skills_used"]:
            usage[name] += 1

    if args.all_conversations:
        scope_kind, scope_label = "all", "all-conversations"
    else:
        scope_kind = "projects"
        scope_label = repos[0].name if len(repos) == 1 else "multiple-projects"

    active = scan.sources
    inventory = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "harness": next(iter(active)) if len(active) == 1 else "mixed",
        "sources": active,
        **{f"{key}_home": (str(homes[key]) if key in active else None) for key in READERS},
        "conversation_scope": scope_kind,
        "repo": str(repos[0]) if len(repos) == 1 else None,
        "repos": [str(repo) for repo in repos],
        "repo_name": scope_label,
        "repo_names": [repo.name for repo in repos],
        "window_days": args.days,
        "skills": sorted(skills.values(), key=lambda entry: entry["name"]),
        "skill_usage": usage,
        "stats": {
            "session_files_in_window": scan.files_seen,
            "session_records_in_window": scan.files_seen,
            "sessions_in_repo": scan.in_scope,
            "sessions_in_scope": scan.in_scope,
            "sessions_considered": len(sessions),
            "sessions_sampled": len(chosen),
            "skills_found": len(skills),
            "skills_used": sum(1 for count in usage.values() if count > 0),
        },
        "sessions": sessions,
    }
    (out_dir / "inventory.json").write_text(json.dumps(inventory, indent=2))

    totals = inventory["stats"]
    scope_text = "all conversations" if args.all_conversations else ", ".join(str(r) for r in repos)
    print(f"scope:             {scope_text}")
    print(f"sources:           {', '.join(active)}")
    print(f"skills found:      {totals['skills_found']} ({totals['skills_used']} used in window)")
    print(f"sessions in window: {totals['session_records_in_window']} records, "
          f"{totals['sessions_in_scope']} in scope, {totals['sessions_considered']} scoreable")
    print(f"sessions sampled:  {totals['sessions_sampled']} -> {transcripts_dir}")
    print(f"inventory:         {out_dir / 'inventory.json'}")


if __name__ == "__main__":
    main()

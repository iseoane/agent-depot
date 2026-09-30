#!/usr/bin/env python3
"""Mine the raw session logs for hard evidence that the user had to correct
the agent -- the whole window, not a sample.

Sources: Claude Code JSONL (`<claude-home>/projects/*/*.jsonl`, required)
and, best-effort, Codex rollout JSONL (`<codex-home>/{sessions,
archived_sessions}/**/rollout-*.jsonl`) when that layout is present. When
Codex is not found, `sources` in the output is `["claude"]` only.

Detection is a case-insensitive regex over the user's own words, seeded with
both Spanish and English phrasings. The patterns intentionally over-match --
a missed correction can never be recovered later, a false positive costs one
human read of the report. Session logs also carry harness-injected content
disguised as a "user" turn (Claude Code's local-command wrappers, Codex's
own "# AGENTS.md instructions for ..." context dump) -- those are stripped
before matching, or the correction count would be dominated by the user's
own instruction file being echoed back at them.

Clustering is a rough, deterministic, non-model grouping by shared salient
tokens -- a starting point for a human to merge, split and rename, not an
answer.

Not every "user" turn in a session log was typed by a human. Sub-agents,
audit harnesses, judges and other skills all write turns the log records as
"user", and on a real corpus they can dwarf the genuine corrections: one
run found 688 pattern-matched "corrections" of which 686 were a single
agent-written prompt template, repeated verbatim across hundreds of
sessions. Three filters drop these by shape, never by naming a specific
tool or skill, so this script stays independent of whatever else runs on
this machine:

  1. --max-turn-chars   a user turn longer than this cannot be a typed
                         correction; dropped before pattern matching.
  2. --template-threshold  a candidate turn (one that already matched a
                         correction pattern) whose normalized text repeats
                         across this many or more DISTINCT sessions is a
                         template, not a correction -- every occurrence is
                         dropped. This needs two passes: collect every
                         candidate first, then decide per normalized
                         prefix, because the same short text repeated many
                         times within one session is not a template. The
                         grouping key is only the first --template-prefix-
                         chars of the folded text (default 160): a
                         template's identity is its opening, not whatever
                         variable payload (an id, a JSON blob) follows it --
                         a key long enough to reach into that payload makes
                         every instance hash differently and defeats the
                         filter on exactly the turns it exists to catch.
  3. self-session sentinel  a turn containing SELF_SESSION_SENTINEL is this
                         skill's own prior-run judging prompt, not a user
                         turn; its whole session is skipped, since the
                         session's other turns are this skill talking to
                         itself, not a human correcting an agent.

Emits:
  <out>/corrections.json - every detected correction (session, timestamp,
                            matched pattern, text, preceding assistant
                            context) plus keyword clusters.

Python 3.9+, stdlib only. Reads session logs, writes only under --out,
makes no network call, and never modifies a session file.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Correction patterns
# ---------------------------------------------------------------------------

APOS = "['’ʼ]"  # straight and curly apostrophes -- real logs carry both

SEED_PATTERNS = [
    # -- Spanish --
    ("no, usa", r"\bno,\s*usa\b"),
    ("no uses", r"\bno\s+uses\b"),
    ("no me has", r"\bno\s+me\s+has\b"),
    ("no hagas", r"\bno\s+hagas\b"),
    ("te dije", r"\bte\s+dije\b"),
    ("ya te dije", r"\bya\s+te\s+dije\b"),
    ("otra vez", r"\botra\s+vez\b"),
    ("vuelve a", r"\bvuelve\s+a\b"),
    ("siempre usa/haz/pon", r"\bsiempre\s+(usa|haz|pon)\b"),
    ("nunca", r"\bnunca\b"),
    ("sin co-authored/atribución", r"\bsin\s+(co-authored|atribuci[oó]n)\b"),
    ("está mal", r"\best[aá]\s+mal\b"),
    ("eso no", r"\beso\s+no\b"),
    ("no es así", r"\bno\s+es\s+as[ií]\b"),
    ("deberías haber", r"\bdeber[ií]as\s+haber\b"),
    ("acuérdate", r"\bacu[eé]rdate\b"),
    ("recuerda que", r"\brecuerda\s+que\b"),
    ("mal,", r"\bmal\s*,"),
    ("perdona no/pero", r"\bperdona,?\s+(no|pero)\b"),
    # -- English --
    ("no, use", r"\bno,\s*use\b"),
    ("don't use", rf"\bdon{APOS}t\s+use\b"),
    ("do not use", r"\bdo\s+not\s+use\b"),
    ("you didn't", rf"\byou\s+didn{APOS}t\b"),
    ("you did not", r"\byou\s+did\s+not\b"),
    ("i told you", r"\bi\s+told\s+you\b"),
    ("again,", r"\bagain\s*,"),
    ("always use", r"\balways\s+use\b"),
    ("never use", r"\bnever\s+use\b"),
    ("that's wrong", rf"\bthat{APOS}s\s+wrong\b"),
    ("that is wrong", r"\bthat\s+is\s+wrong\b"),
    ("not like that", r"\bnot\s+like\s+that\b"),
    ("you should have", r"\byou\s+should\s+have\b"),
    ("remember to", r"\bremember\s+to\b"),
    ("stop using", r"\bstop\s+using\b"),
]

SKIP_EXACT = {"[Request interrupted by user]"}
SKIP_PREFIXES = ("<local-command-caveat>", "<command-name>", "<local-command-stdout>")

# A turn carrying this marker is a prompt this skill itself sent to a judge
# (SKILL.md Step 4), not a human correcting an agent. Defined once here so
# every future run recognizes its own prior-run prompts in the logs and
# refuses to mine them.
SELF_SESSION_SENTINEL = "<!-- doctor-md-agents:self-session -->"

# Default grouping-key length for template detection (overridable via
# --template-prefix-chars). Deliberately short: a template's identity is
# its opening line(s), not whatever variable payload -- an id, a JSON blob
# -- follows. A key long enough to reach into that payload makes every
# instance of the same template hash differently and defeats the filter.
TEMPLATE_PREFIX_CHARS = 160
TEMPLATE_REPORT_PREFIX_CHARS = 160

PASTED_CONTENT_RE = re.compile(r"<pasted_content\b[^>]*>.*?</pasted_content>", re.DOTALL | re.IGNORECASE)

# Codex injects the project's own AGENTS.md/CLAUDE.md text into a fake
# "user" turn at session start (and after context compaction). Left
# unfiltered, every correction pattern that also appears in the user's own
# instruction file (many do -- "nunca", "siempre", "no uses"...) would fire
# on every single session.
CODEX_INJECTED_RE = re.compile(r"^#\s+(?:AGENTS|CLAUDE)\.md\s+instructions\s+for\b", re.IGNORECASE)
GENERIC_INJECTED_TAGS = (
    "environment_context", "user_instructions", "system-reminder", "recommended_plugins",
    "permissions", "collaboration_mode", "turn_context", "user_info", "skills_instructions",
)

MAX_CORRECTION_TEXT_CHARS = 4000

# A short, intentionally modest stopword list (ES + EN) plus the seed
# patterns' own trigger words, so clusters key on the *subject* of the
# correction rather than on "siempre"/"nunca"/"usa" appearing in almost
# every hit.
STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "has", "had", "you", "your",
    "yours", "are", "was", "were", "been", "being", "not", "but", "into", "onto", "they", "them",
    "their", "what", "when", "where", "which", "who", "whom", "why", "how", "then", "than", "also",
    "just", "like", "about", "again", "always", "never", "should", "would", "could", "please",
    "some", "more", "most", "very", "only", "over", "under", "after", "before", "during", "while",
    "because", "still", "even", "told", "didn", "did", "doesn", "does", "wrong", "remember", "stop",
    "use", "uses", "used", "using",
    "para", "esto", "esta", "estos", "estas", "pero", "como", "cuando", "donde", "cual", "cuales",
    "quien", "quienes", "porque", "tambien", "mas", "menos", "muy", "solo", "sobre", "bajo",
    "despues", "antes", "mientras", "todavia", "aun", "siempre", "nunca", "otra", "otro", "vez",
    "dijiste", "dije", "hagas", "haces", "usar", "usa", "usas", "pon", "ponme", "deberia",
    "deberias", "haber", "acuerdate", "recuerda", "perdona", "mal", "eres", "sera", "seria",
    "tiene", "tienen", "tenia", "hace", "hizo", "haciendo", "vuelve",
}


def compile_patterns(extra_file):
    patterns = [(label, re.compile(regex, re.IGNORECASE)) for label, regex in SEED_PATTERNS]
    if extra_file:
        text = Path(extra_file).expanduser().read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                patterns.append((line, re.compile(line, re.IGNORECASE)))
            except re.error as exc:
                print(f"warning: skipping invalid pattern {line!r}: {exc}", file=sys.stderr)
    return patterns


def first_match(patterns, text):
    for label, rx in patterns:
        if rx.search(text):
            return label
    return None


# ---------------------------------------------------------------------------
# Text extraction helpers
# ---------------------------------------------------------------------------


def truncate(text, limit):
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f" …[truncated {len(text) - limit} chars]"


def strip_pasted_content(text):
    return PASTED_CONTENT_RE.sub("", text)


def normalize_prefix(text, length=TEMPLATE_PREFIX_CHARS):
    """Fold whitespace and take the first `length` chars -- the key used to
    group repeated-template candidates regardless of which session wrote
    them or how the surrounding whitespace happens to differ."""
    return re.sub(r"\s+", " ", text).strip()[:length]


def turn_contains_sentinel(turn):
    return SELF_SESSION_SENTINEL in (turn.get("text") or "") or SELF_SESSION_SENTINEL in (turn.get("condensed") or "")


def looks_injected_generic(text):
    head = text.lstrip()[:80]
    return head.startswith("<") and any(tag in head for tag in GENERIC_INJECTED_TAGS)


def clean_user_text(raw_text):
    """Apply the skip/strip rules; return None if the turn is not real."""
    if raw_text is None:
        return None
    stripped_start = raw_text.lstrip()
    if raw_text.strip() in SKIP_EXACT:
        return None
    if stripped_start.startswith(SKIP_PREFIXES):
        return None
    without_pasted = strip_pasted_content(raw_text)
    if without_pasted.strip() == "":
        return None
    return without_pasted


# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------


def claude_text_blocks(content):
    """Return (joined_text_or_None, tool_use_blocks, saw_only_tool_result)."""
    if isinstance(content, str):
        return content, [], False
    if not isinstance(content, list):
        return None, [], False
    texts = []
    tool_uses = []
    saw_any_block = False
    saw_non_tool_result = False
    for block in content:
        if not isinstance(block, dict):
            continue
        saw_any_block = True
        btype = block.get("type")
        if btype == "text":
            saw_non_tool_result = True
            t = block.get("text")
            if isinstance(t, str) and t:
                texts.append(t)
        elif btype == "tool_use":
            saw_non_tool_result = True
            tool_uses.append(block)
        elif btype == "tool_result":
            pass  # tool_result blocks never count as user text
        else:
            saw_non_tool_result = True
    only_tool_result = saw_any_block and not saw_non_tool_result
    text = "\n".join(texts) if texts else None
    return text, tool_uses, only_tool_result


def condense_tool_uses(tool_uses, limit):
    parts = []
    for block in tool_uses:
        name = block.get("name") or "tool"
        args = block.get("input") or {}
        args_text = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
        parts.append(f"{name}({args_text[:60]})")
    return truncate("; ".join(parts), limit)


def iter_claude_turns(path, max_context):
    """Yield raw turn dicts for one Claude Code session file."""
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with fh:
        for line_no, line in enumerate(fh):
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            rtype = obj.get("type")
            if rtype not in ("user", "assistant"):
                continue
            if obj.get("isSidechain"):
                continue
            message = obj.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role") or rtype
            content = message.get("content")

            session_id = obj.get("sessionId")
            if not session_id:
                continue
            uuid = obj.get("uuid") or f"{path}:{line_no}"
            ts = obj.get("timestamp")

            if role == "user":
                if obj.get("isMeta"):
                    continue
                raw_text, _tool_uses, only_tool_result = claude_text_blocks(content)
                if only_tool_result or raw_text is None:
                    continue  # tool_result-only record is not a user turn
                text = clean_user_text(raw_text)
                yield {
                    "session_id": session_id, "harness": "claude", "uuid": uuid,
                    "timestamp": ts, "cwd": obj.get("cwd"), "git_branch": obj.get("gitBranch"),
                    "role": "user", "text": text,
                    "condensed": truncate(text, max_context) if text else "",
                }
            else:
                raw_text, tool_uses, _ = claude_text_blocks(content)
                if raw_text:
                    condensed = truncate(raw_text, max_context)
                elif tool_uses:
                    condensed = condense_tool_uses(tool_uses, max_context)
                else:
                    condensed = ""
                yield {
                    "session_id": session_id, "harness": "claude", "uuid": uuid,
                    "timestamp": ts, "cwd": obj.get("cwd"), "git_branch": obj.get("gitBranch"),
                    "role": "assistant", "text": None, "condensed": condensed,
                }


def find_claude_files(claude_home, cutoff):
    projects = claude_home / "projects"
    if not projects.is_dir():
        return []
    files = []
    for path in projects.glob("*/*.jsonl"):
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            files.append(path)
    return sorted(files)


# ---------------------------------------------------------------------------
# Codex (best-effort; shape confirmed against scripts/collect_sessions.py's
# parse_codex_session and against real ~/.codex/sessions rollout files)
# ---------------------------------------------------------------------------


def codex_extract_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = []
    for block in content:
        if isinstance(block, dict):
            t = block.get("text")
            if isinstance(t, str) and t:
                parts.append(t)
    return "\n".join(parts) if parts else None


def looks_injected_codex(text):
    if CODEX_INJECTED_RE.match(text.lstrip()):
        return True
    return looks_injected_generic(text)


def iter_codex_turns(path, max_context):
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return
    session_id = None
    cwd = None
    with fh:
        for line_no, obj_line in enumerate(fh):
            try:
                obj = json.loads(obj_line)
            except (json.JSONDecodeError, ValueError):
                continue
            rtype = obj.get("type")
            payload = obj.get("payload")
            if not isinstance(payload, dict):
                continue
            ts = obj.get("timestamp")

            if rtype == "session_meta":
                session_id = payload.get("id") or payload.get("session_id")
                cwd = payload.get("cwd")
                source = payload.get("source")
                thread_source = payload.get("thread_source")
                is_subagent = thread_source == "subagent" or (
                    isinstance(source, dict) and "subagent" in source
                )
                if is_subagent:
                    return
                continue

            if rtype != "response_item" or not session_id:
                continue

            ptype = payload.get("type")
            uuid = payload.get("id") or f"{path}:{line_no}"

            if ptype == "message" and payload.get("role") == "user":
                raw_text = codex_extract_text(payload.get("content"))
                if raw_text is None or looks_injected_codex(raw_text):
                    continue
                text = clean_user_text(raw_text)
                yield {
                    "session_id": session_id, "harness": "codex", "uuid": uuid,
                    "timestamp": ts, "cwd": cwd, "git_branch": None,
                    "role": "user", "text": text,
                    "condensed": truncate(text, max_context) if text else "",
                }
            elif ptype == "message" and payload.get("role") == "assistant":
                raw_text = codex_extract_text(payload.get("content"))
                condensed = truncate(raw_text, max_context) if raw_text else ""
                yield {
                    "session_id": session_id, "harness": "codex", "uuid": uuid,
                    "timestamp": ts, "cwd": cwd, "git_branch": None,
                    "role": "assistant", "text": None, "condensed": condensed,
                }
            elif ptype in ("function_call", "custom_tool_call", "local_shell_call"):
                name = payload.get("name") or ptype
                args = payload.get("arguments") or payload.get("input") or ""
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                condensed = truncate(f"{name}({args[:60]})", max_context)
                yield {
                    "session_id": session_id, "harness": "codex", "uuid": uuid,
                    "timestamp": ts, "cwd": cwd, "git_branch": None,
                    "role": "assistant", "text": None, "condensed": condensed,
                }


def find_codex_files(codex_home, cutoff):
    files = []
    for sub in ("sessions", "archived_sessions"):
        root = codex_home / sub
        if not root.is_dir():
            continue
        for path in root.rglob("rollout-*.jsonl"):
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
            if mtime >= cutoff:
                files.append(path)
    return sorted(files)


# ---------------------------------------------------------------------------
# Timestamp / scope helpers
# ---------------------------------------------------------------------------


def parse_ts(value):
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def normalize_repo(repo_arg):
    return os.path.normpath(os.path.expanduser(repo_arg))


def cwd_in_scope(cwd, repo_norms):
    if not cwd:
        return False
    cwd_norm = os.path.normpath(os.path.expanduser(cwd))
    for repo_norm in repo_norms:
        if cwd_norm == repo_norm or cwd_norm.startswith(repo_norm + os.sep):
            return True
    return False


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def salient_tokens(text):
    tokens = [t.lower() for t in WORD_RE.findall(text)]
    return [t for t in tokens if len(t) >= 4 and t not in STOPWORDS]


def build_clusters(corrections):
    """Deterministic, order-preserving greedy clustering by shared salient
    tokens (>=2 shared tokens joins the first qualifying cluster). This is a
    rough grouping meant for a human to merge/split/rename, not an answer."""
    clusters = []  # each: {"token_set": set, "token_counts": Counter, "indexes": [], "sessions": set}
    for index, corr in enumerate(corrections):
        tokens = set(salient_tokens(corr["text"]))
        target = None
        if tokens:
            for cluster in clusters:
                if len(tokens & cluster["token_set"]) >= 2:
                    target = cluster
                    break
        if target is None:
            target = {"token_set": set(), "token_counts": Counter(), "indexes": [], "sessions": set()}
            clusters.append(target)
        target["token_set"] |= tokens
        target["token_counts"].update(tokens)
        target["indexes"].append(index)
        target["sessions"].add(corr["session_id"])

    out = []
    for cluster in clusters:
        counted = cluster["token_counts"]
        ranked = sorted(counted.items(), key=lambda kv: (-kv[1], kv[0]))
        key_tokens = [t for t, _ in ranked[:3]]
        out.append({
            "key": " ".join(key_tokens) if key_tokens else "(no salient tokens)",
            "count": len(cluster["indexes"]),
            "sessions": sorted(cluster["sessions"]),
            "correction_indexes": cluster["indexes"],
        })
    out.sort(key=lambda c: (-c["count"], c["key"]))
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True)
    p.add_argument("--days", type=int, default=90)
    p.add_argument("--repo", action="append", default=[])
    p.add_argument("--all-conversations", action="store_true")
    p.add_argument("--claude-home", default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"))
    p.add_argument("--codex-home", default="~/.codex")
    p.add_argument("--patterns", default=None, help="extra newline-separated regex patterns")
    p.add_argument("--max-context", type=int, default=400,
                    help="chars of preceding-assistant excerpt to keep (default: 400)")
    p.add_argument("--max-turn-chars", type=int, default=1200,
                    help="a user turn longer than this cannot be a typed correction (default: 1200)")
    p.add_argument("--template-threshold", type=int, default=3,
                    help="drop a candidate as a machine template when its normalized text "
                         "repeats across this many or more distinct sessions (default: 3)")
    p.add_argument("--template-prefix-chars", type=int, default=TEMPLATE_PREFIX_CHARS,
                    help="chars of whitespace-folded text used as the template-matching key "
                         "(default: 160) -- a template's identity is its opening, not the "
                         "variable payload (an id, a JSON blob) that follows it")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.all_conversations and args.repo:
        print("error: --all-conversations cannot be combined with --repo", file=sys.stderr)
        sys.exit(2)

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    claude_home = Path(args.claude_home).expanduser()
    codex_home = Path(args.codex_home).expanduser()
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    repo_norms = [normalize_repo(r) for r in args.repo]

    patterns = compile_patterns(args.patterns)

    claude_files = find_claude_files(claude_home, cutoff)
    if not claude_files and not (claude_home / "projects").is_dir():
        print(f"error: Claude Code project history not found at {claude_home / 'projects'}",
              file=sys.stderr)
        sys.exit(1)

    codex_files = find_codex_files(codex_home, cutoff)
    sources = ["claude"]
    if codex_files:
        sources.append("codex")

    session_files_scanned = len(claude_files) + len(codex_files)

    # session_id -> {"turns": {turn_key: turn_dict}}
    sessions = {}
    for path in claude_files:
        for turn in iter_claude_turns(path, args.max_context):
            bucket = sessions.setdefault(turn["session_id"], {})
            key = turn["uuid"]
            bucket[key] = turn
    for path in codex_files:
        for turn in iter_codex_turns(path, args.max_context):
            bucket = sessions.setdefault(turn["session_id"], {})
            key = f"codex:{turn['uuid']}"
            bucket[key] = turn

    # Pass 1: walk every in-scope session and collect pattern-matched
    # candidates. Nothing here is decided to be a real correction yet --
    # the template filter (pass 2, below) needs every candidate gathered
    # first, because "repeated across N distinct sessions" cannot be known
    # from a single session's turns in isolation.
    candidates = []          # list of correction dicts (pending template decision)
    candidate_prefixes = []  # parallel list: normalize_prefix(text) per candidate
    user_turns_total = 0
    sessions_scanned = 0
    sessions_in_scope = 0
    turns_dropped_too_long = 0
    turns_dropped_self_session = 0
    sessions_skipped_self_session = 0

    for session_id in sorted(sessions):
        all_turns = list(sessions[session_id].values())

        def sort_key(t):
            ts = parse_ts(t["timestamp"])
            return (ts is None, ts or datetime.min.replace(tzinfo=timezone.utc))

        all_turns.sort(key=sort_key)

        # A self-session is a property of the whole session, independent of
        # which of its turns happen to fall inside --days: check the full,
        # unwindowed turn list.
        session_has_sentinel = any(turn_contains_sentinel(t) for t in all_turns)

        # window filter at turn level
        turns = [t for t in all_turns if parse_ts(t["timestamp"]) is None or parse_ts(t["timestamp"]) >= cutoff]
        if not turns:
            continue
        sessions_scanned += 1

        cwd = next((t["cwd"] for t in turns if t.get("cwd")), None)
        in_scope = args.all_conversations or cwd_in_scope(cwd, repo_norms)
        if not in_scope:
            continue
        sessions_in_scope += 1

        git_branch = next((t["git_branch"] for t in turns if t.get("git_branch")), None)

        if session_has_sentinel:
            # This skill's own prior-run judging prompts, not a human
            # correcting an agent -- the whole session is this skill
            # talking to itself. Every real user turn in it still counts
            # toward user_turns (it is a genuine turn in scope) and is
            # fully accounted for by turns_dropped_self_session, so the
            # arithmetic user_turns - dropped_* stays auditable.
            session_user_turns = sum(1 for t in turns if t["role"] == "user" and t["text"])
            user_turns_total += session_user_turns
            turns_dropped_self_session += session_user_turns
            sessions_skipped_self_session += 1
            continue

        for i, turn in enumerate(turns):
            if turn["role"] != "user" or not turn["text"]:
                continue
            text = turn["text"]
            user_turns_total += 1

            if len(text) > args.max_turn_chars:
                # Not a typed correction -- dropped before pattern matching.
                turns_dropped_too_long += 1
                continue

            pattern = first_match(patterns, text)
            if not pattern:
                continue
            preceding = ""
            for j in range(i - 1, -1, -1):
                if turns[j]["role"] == "assistant":
                    preceding = turns[j]["condensed"]
                    break
            candidates.append({
                "session_id": session_id,
                "harness": turn["harness"],
                "timestamp": turn["timestamp"],
                "cwd": cwd,
                "git_branch": git_branch,
                "pattern": pattern,
                "text": truncate(text, MAX_CORRECTION_TEXT_CHARS),
                "preceding": preceding,
            })
            candidate_prefixes.append(normalize_prefix(text, length=args.template_prefix_chars))

    # Pass 2: group candidates by normalized prefix and count DISTINCT
    # sessions per group -- the same text repeated many times inside one
    # session is not a template, only the same text spread across several
    # sessions is.
    prefix_sessions = {}   # normalized prefix -> set of session ids
    prefix_indexes = {}    # normalized prefix -> [candidate indexes]
    for idx, corr in enumerate(candidates):
        prefix = candidate_prefixes[idx]
        prefix_sessions.setdefault(prefix, set()).add(corr["session_id"])
        prefix_indexes.setdefault(prefix, []).append(idx)

    templated_indexes = set()
    dropped_templates = []
    for prefix, sess_set in prefix_sessions.items():
        if len(sess_set) >= args.template_threshold:
            templated_indexes.update(prefix_indexes[prefix])
            dropped_templates.append({
                "prefix": prefix[:TEMPLATE_REPORT_PREFIX_CHARS],
                "sessions": len(sess_set),
                "occurrences": len(prefix_indexes[prefix]),
            })
    dropped_templates.sort(key=lambda d: (-d["sessions"], -d["occurrences"]))
    turns_dropped_templated = len(templated_indexes)

    corrections = []
    sessions_with_corrections = set()
    for idx, corr in enumerate(candidates):
        if idx in templated_indexes:
            continue
        corrections.append(corr)
        sessions_with_corrections.add(corr["session_id"])

    clusters = build_clusters(corrections)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": args.days,
        "sources": sources,
        "stats": {
            "session_files_scanned": session_files_scanned,
            "sessions_scanned": sessions_scanned,
            "sessions_in_scope": sessions_in_scope,
            "user_turns": user_turns_total,
            "corrections_found": len(corrections),
            "sessions_with_corrections": len(sessions_with_corrections),
            "turns_dropped_too_long": turns_dropped_too_long,
            "turns_dropped_templated": turns_dropped_templated,
            "turns_dropped_self_session": turns_dropped_self_session,
            "sessions_skipped_self_session": sessions_skipped_self_session,
        },
        "corrections": corrections,
        "clusters": clusters,
        "dropped_templates": dropped_templates,
    }
    (out_dir / "corrections.json").write_text(json.dumps(report, indent=2))

    print(f"corrections.json:  {out_dir / 'corrections.json'}")
    print(f"sources:           {', '.join(sources)}")
    print(f"session files:     {session_files_scanned} scanned")
    print(f"sessions:          {sessions_scanned} scanned, {sessions_in_scope} in scope")
    print(f"user turns:        {user_turns_total}")
    print(f"corrections found: {len(corrections)} across {len(sessions_with_corrections)} sessions")
    print(f"dropped too long:  {turns_dropped_too_long}")
    print(f"dropped templated: {turns_dropped_templated} ({len(dropped_templates)} template group(s))")
    print(f"dropped self-session: {turns_dropped_self_session} turns "
          f"across {sessions_skipped_self_session} session(s)")
    print("top clusters:")
    for cluster in clusters[:5]:
        print(f"  {cluster['count']:4d}  {cluster['key']}")


if __name__ == "__main__":
    main()

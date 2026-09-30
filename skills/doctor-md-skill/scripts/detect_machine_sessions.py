#!/usr/bin/env python3
"""Flag local session logs whose "user" turns look machine-generated rather
than typed by a human -- SKILL.md runs this between collection and scoring
so this skill does not grade a machine talking to itself.

`collect_sessions.py` already excludes sidechains by default, which covers
subagents. It does not cover top-level sessions launched by other tooling --
audit harnesses, judges, other skills -- whose "user" turn is a
programmatically built prompt. On a real corpus these can dominate: one scan
found 686 of 688 candidate user turns were such templates, median 4024
characters, repeated verbatim across hundreds of sessions. Grading those for
efficiency and code quality measures a machine talking to itself and
silently drags the user's grades around.

Three filters flag a session by the SHAPE of its content, never by naming a
specific tool or skill, so this script stays independent of whatever else
runs on this machine:

  1. --max-turn-chars    the session's first user turn is longer than this;
                          a competent human rarely opens with more (default
                          1200 chars).
  2. --template-threshold  a normalized prefix of a user turn (any user
                          turn in the session, not only the first) that
                          repeats across this many or more DISTINCT
                          sessions is a template, not a human typing fresh
                          words each time -- every session containing that
                          prefix is flagged. The grouping key is only the
                          first --template-prefix-chars of the folded text
                          (default 160): a template's identity is its
                          opening, not whatever variable payload follows
                          it. The threshold counts DISTINCT SESSIONS, so the
                          same text repeated several times inside one
                          session is not, by itself, a template.
  3. self-session sentinel  a turn containing MACHINE_SESSION_SENTINEL is
                          this skill's own scoring prompt sent to a judge
                          (see SKILL.md Step 2), not a human talking to an
                          agent.

Reuses the session-file discovery and parsing already implemented in
collect_sessions.py (Claude Code, Codex, Pi, Grok Build, ZCode) instead of
re-implementing five JSONL readers -- this scans the exact same raw logs
the collector reads.

Emits:
  <out>/machine_sessions.json - every flagged session id (format
                                 "<harness>:<session-id>", matching the
                                 collector's own sampling key) with its
                                 reasons and evidence, plus stats and
                                 template groups for a human to audit.

Python 3.9+, stdlib only. Reads only local session logs, writes only under
--out, makes no network call, and never modifies a session file.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from collect_sessions import (  # noqa: E402
    find_claude_session_files, parse_claude_session,
    find_codex_session_files, parse_codex_session,
    find_pi_session_files, parse_pi_session,
    find_grok_session_files, parse_grok_session,
    find_zcode_session_files, parse_zcode_session,
)

# A turn carrying this marker is this skill's own scoring prompt sent to a
# judge (see SKILL.md Step 2), not a human turn. SKILL.md prepends this
# sentinel, on its own line, to every prompt this skill sends to a judge --
# including a delegated child agent's -- so any future run recognizes its
# own prior-run prompts in the logs and refuses to score them as if a human
# had written them.
MACHINE_SESSION_SENTINEL = "<!-- doctor-md-skill:self-session -->"

# Default grouping-key length for template detection (overridable via
# --template-prefix-chars). Deliberately short: a template's identity is
# its opening, not whatever variable payload (an id, a JSON blob) follows
# it -- a key long enough to reach into that payload makes every instance
# hash differently and defeats the filter on exactly the turns it exists
# to catch.
TEMPLATE_PREFIX_CHARS = 160
TEMPLATE_REPORT_PREFIX_CHARS = 160

DEFAULT_MAX_TURN_CHARS = 1200
DEFAULT_TEMPLATE_THRESHOLD = 3


def normalize_prefix(text, length=TEMPLATE_PREFIX_CHARS):
    """Fold whitespace and take the first `length` chars -- the key used to
    group repeated-template candidates regardless of the surrounding
    whitespace or which session wrote them."""
    return re.sub(r"\s+", " ", text).strip()[:length]


def iter_session_user_turns(entries):
    """Yield the text of every ("user", text) entry, in order."""
    for role, text in entries:
        if role == "user" and text:
            yield text


def session_contains_sentinel(entries):
    return any(MACHINE_SESSION_SENTINEL in text for _role, text in entries if text)


HARNESS_SOURCES = {
    "claude": (find_claude_session_files, parse_claude_session, "claude_home"),
    "codex": (find_codex_session_files, parse_codex_session, "codex_home"),
    "pi": (find_pi_session_files, parse_pi_session, "pi_home"),
    "grok": (find_grok_session_files, parse_grok_session, "grok_home"),
    "zcode": (find_zcode_session_files, parse_zcode_session, "zcode_home"),
}


def collect_candidates(homes, cutoff, include_subagents=False):
    """Walk every configured harness home and return a list of per-session
    records: {session_key, harness, first_user_turn, user_turns,
    has_sentinel}. `homes` maps harness name -> Path (or None to skip)."""
    records = []
    for harness, (find_files, parse_session, home_key) in HARNESS_SOURCES.items():
        home = homes.get(home_key)
        if home is None:
            continue
        try:
            # Only the Claude Code finder also walks sidechain files; every
            # other finder takes just (home, cutoff).
            if harness == "claude":
                files = find_files(home, cutoff, include_subagents)
            else:
                files = find_files(home, cutoff)
        except OSError:
            continue
        for _mtime, path in files:
            parsed = parse_session(path, set(), include_subagents)
            if parsed is None:
                continue
            meta, _stats, entries, _skills_used = parsed
            user_turns = list(iter_session_user_turns(entries))
            records.append({
                "session_key": f"{harness}:{meta.get('id')}",
                "harness": harness,
                "file": str(path),
                "user_turns": user_turns,
                "first_user_turn": user_turns[0] if user_turns else None,
                "has_sentinel": session_contains_sentinel(entries),
            })
    return records


def flag_sessions(records, max_turn_chars, template_threshold, template_prefix_chars):
    """Apply the three filters and return (flagged, dropped_templates,
    stats). `flagged` is a list of {session_key, harness, reasons,
    evidence} sorted by session_key."""
    # Pass 1: collect every (session_key, normalized prefix) pair across
    # every user turn in every session -- not only the first turn, so a
    # template that shows up mid-session is still caught, and so the same
    # text repeated inside ONE session collapses to one entry per prefix
    # (a set, not a count) before the distinct-session threshold is applied.
    prefix_sessions = {}   # normalized prefix -> set of session_key
    prefix_occurrences = {}  # normalized prefix -> total turn occurrences
    for record in records:
        seen_prefixes_this_session = set()
        for turn in record["user_turns"]:
            prefix = normalize_prefix(turn, length=template_prefix_chars)
            if not prefix:
                continue
            prefix_occurrences[prefix] = prefix_occurrences.get(prefix, 0) + 1
            if prefix not in seen_prefixes_this_session:
                seen_prefixes_this_session.add(prefix)
                prefix_sessions.setdefault(prefix, set()).add(record["session_key"])

    templated_prefixes = {
        prefix for prefix, sessions in prefix_sessions.items()
        if len(sessions) >= template_threshold
    }
    dropped_templates = [
        {
            "prefix": prefix[:TEMPLATE_REPORT_PREFIX_CHARS],
            "sessions": len(prefix_sessions[prefix]),
            "occurrences": prefix_occurrences[prefix],
        }
        for prefix in templated_prefixes
    ]
    dropped_templates.sort(key=lambda d: (-d["sessions"], -d["occurrences"]))

    flagged = []
    long_first_turn_count = 0
    templated_count = 0
    sentinel_count = 0
    for record in records:
        reasons = []
        evidence = {}

        first_turn = record["first_user_turn"]
        if first_turn is not None and len(first_turn) > max_turn_chars:
            reasons.append("long_first_turn")
            evidence["first_turn_chars"] = len(first_turn)
            long_first_turn_count += 1

        session_prefixes = {
            normalize_prefix(turn, length=template_prefix_chars)
            for turn in record["user_turns"]
        }
        matched = session_prefixes & templated_prefixes
        if matched:
            reasons.append("templated")
            sample_prefix = sorted(matched)[0]
            evidence["template_prefix"] = sample_prefix[:TEMPLATE_REPORT_PREFIX_CHARS]
            evidence["template_sessions"] = len(prefix_sessions[sample_prefix])
            templated_count += 1

        if record["has_sentinel"]:
            reasons.append("self_session_sentinel")
            sentinel_count += 1

        if reasons:
            flagged.append({
                "session_key": record["session_key"],
                "harness": record["harness"],
                "reasons": reasons,
                "evidence": evidence,
            })

    flagged.sort(key=lambda f: f["session_key"])

    stats = {
        "sessions_scanned": len(records),
        "sessions_flagged": len(flagged),
        "flagged_long_first_turn": long_first_turn_count,
        "flagged_templated": templated_count,
        "flagged_self_session_sentinel": sentinel_count,
        "template_groups": len(dropped_templates),
    }
    return flagged, dropped_templates, stats


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True)
    p.add_argument("--days", type=int, default=45, help="lookback window (default: 45)")
    p.add_argument(
        "--claude-home",
        default=os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"),
        help="Claude Code config directory (default: CLAUDE_CONFIG_DIR or ~/.claude)",
    )
    p.add_argument("--codex-home", default=os.environ.get("CODEX_HOME", "~/.codex"))
    p.add_argument("--pi-home", default="~/.pi/agent")
    p.add_argument("--grok-home", default="~/.grok")
    p.add_argument("--zcode-home", default="~/.zcode")
    p.add_argument("--include-subagents", action="store_true")
    p.add_argument("--max-turn-chars", type=int, default=DEFAULT_MAX_TURN_CHARS,
                    help=f"a first user turn longer than this is flagged (default: {DEFAULT_MAX_TURN_CHARS})")
    p.add_argument("--template-threshold", type=int, default=DEFAULT_TEMPLATE_THRESHOLD,
                    help="flag a user turn as a machine template when its normalized prefix "
                         f"repeats across this many or more distinct sessions (default: {DEFAULT_TEMPLATE_THRESHOLD})")
    p.add_argument("--template-prefix-chars", type=int, default=TEMPLATE_PREFIX_CHARS,
                    help=f"chars of whitespace-folded text used as the template-matching key (default: {TEMPLATE_PREFIX_CHARS})")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    homes = {
        "claude_home": Path(args.claude_home).expanduser(),
        "codex_home": Path(args.codex_home).expanduser(),
        "pi_home": Path(args.pi_home).expanduser(),
        "grok_home": Path(args.grok_home).expanduser(),
        "zcode_home": Path(args.zcode_home).expanduser(),
    }
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)

    records = collect_candidates(homes, cutoff, args.include_subagents)
    flagged, dropped_templates, stats = flag_sessions(
        records, args.max_turn_chars, args.template_threshold, args.template_prefix_chars,
    )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": args.days,
        "max_turn_chars": args.max_turn_chars,
        "template_threshold": args.template_threshold,
        "template_prefix_chars": args.template_prefix_chars,
        "sentinel": MACHINE_SESSION_SENTINEL,
        "stats": stats,
        "flagged_sessions": flagged,
        "dropped_templates": dropped_templates,
    }
    out_path = out_dir / "machine_sessions.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"machine_sessions.json: {out_path}")
    print(f"sessions scanned:      {stats['sessions_scanned']}")
    print(f"sessions flagged:      {stats['sessions_flagged']}")
    print(f"  long first turn:     {stats['flagged_long_first_turn']}")
    print(f"  templated:           {stats['flagged_templated']} ({stats['template_groups']} template group(s))")
    print(f"  self-session:        {stats['flagged_self_session_sentinel']}")
    if stats["sessions_scanned"] and stats["sessions_flagged"] > stats["sessions_scanned"] - stats["sessions_flagged"]:
        print(
            "warning: flagged sessions outnumber kept sessions -- this corpus is mostly "
            "machine-driven and any surviving grades rest on very little",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()

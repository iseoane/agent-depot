#!/usr/bin/env python3
"""Split agent instruction files (CLAUDE.md, AGENTS.md, ...) into individually
gradable rules and emit a token-cost rollup.

Splitting follows references/rule-model.md literally:

  1. Cut on every ATX heading (# .. ######). A section is the heading plus
     the body up to the next heading of any level. A section whose body is
     only whitespace is dropped, but its heading still contributes to the
     heading path of its child sections.
  2. Inside a section body, if there are 2 or more top-level list items
     (-, *, +, or "1.", indented no more than 3 spaces), each item -- with
     its indented continuation lines and any deeper-nested sub-items --
     becomes its own rule. Prose before the first item becomes one more
     rule. A single bullet under a heading is not enough to split: one
     item alone is just a heading with one paragraph, not a list a reader
     would scan item by item, so it stays part of its section.
  3. Otherwise the whole section body is one rule.

Fenced code blocks (``` or ~~~) are body text: headings and list markers
inside a fence never start a rule, regardless of the fence's own
indentation.

<important if="condition"> ... </important> blocks (references/structure.md)
are containers, recognized only when the tag sits alone on its own line: the
rules inside split the same way as any other section body and each one
carries `condition` (the block's condition text) in rules.json; a bare rule
outside any block has `condition: null`. The tags themselves are excluded
from a rule's text, chars and est_tokens -- they cost nothing to obey. A
nested <important if> (one opened while already inside another) is rejected
with a warning and kept as literal text under the outer condition rather
than flattened into it, and so is a stray closing tag with no matching
open. A file with no blocks at all extracts exactly as it did before this
feature existed, aside from the added `condition: null` key.

Emits:
  <out>/rules.json - every graded file, every rule (id, heading path, line
                      range, char/token cost, gist, full text), and a
                      per-top-level-section rollup.

Python 3.9+, stdlib only. Reads only the files named on the command line or
found by auto-discovery; writes only under --out. Never touches the source
instruction files, never makes a network call.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Auto-discovery -- exactly the paths listed in references/rule-model.md
# under "Which files get graded".
# ---------------------------------------------------------------------------

GLOBAL_CANDIDATES = (
    "~/.claude/CLAUDE.md",
    "~/.codex/AGENTS.md",
    "~/.agents/AGENTS.md",
    "~/AGENTS.md",
)

PROJECT_CANDIDATES = (
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/CLAUDE.md",
    ".github/copilot-instructions.md",
)

HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*))?$")
FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})(.*)$")
# Top-level list item: -, *, +, or "1." (multi-digit), indented <=3 spaces,
# with required whitespace after the marker so "---" rules and "|---|"
# table rows never match.
LIST_ITEM_RE = re.compile(r"^( {0,3})([-*+]|\d+\.)[ \t]+(.*)$")
# <important if="condition"> containers (references/structure.md,
# rule-model.md). Recognized only when the tag sits alone on its own line,
# indented no more than 3 spaces -- an inline mention of the tag in prose
# (this file's own docs, for instance) must never be treated as a real
# block boundary.
IMPORTANT_OPEN_RE = re.compile(r'^[ \t]{0,3}<important\s+if="([^"]*)">[ \t]*$')
IMPORTANT_CLOSE_RE = re.compile(r"^[ \t]{0,3}</important>[ \t]*$")

RULE_SIZE_WARNING_CHARS = 2000
MIN_RULES_PER_FILE_WARNING = 3
# A section splits into one rule per top-level list item once it has at
# least this many items. Below it, a lone bullet is just a heading with one
# paragraph -- not a list a reader would scan item by item -- so the whole
# section body stays one rule. See references/rule-model.md.
LIST_SPLIT_MIN_ITEMS = 2


# ---------------------------------------------------------------------------
# Fence / heading / list-item scanning
# ---------------------------------------------------------------------------


def find_fenced_line_numbers(lines):
    """Return the set of 1-based line numbers that fall inside a fenced code
    block (including the opening and closing fence lines themselves)."""
    fenced = set()
    open_char = None
    open_len = 0
    in_fence = False
    for i, line in enumerate(lines, start=1):
        m = FENCE_RE.match(line)
        if not in_fence:
            if m:
                marker = m.group(1)
                open_char = marker[0]
                open_len = len(marker)
                in_fence = True
                fenced.add(i)
        else:
            fenced.add(i)
            if m:
                marker = m.group(1)
                trailing = m.group(2).strip()
                if marker[0] == open_char and len(marker) >= open_len and trailing == "":
                    in_fence = False
                    open_char = None
                    open_len = 0
    return fenced


def parse_headings(lines, fenced):
    """Return [{"line_no", "level", "title"}] for ATX headings outside fences."""
    headings = []
    for i, line in enumerate(lines, start=1):
        if i in fenced:
            continue
        m = HEADING_RE.match(line)
        if not m:
            continue
        level = len(m.group(1))
        raw_title = (m.group(2) or "").strip()
        title = re.sub(r"[ \t]+#+\s*$", "", raw_title).strip()
        headings.append({"line_no": i, "level": level, "title": title})
    return headings


def build_sections(total_lines, headings):
    """Partition the file into sections: heading line + body up to the next
    heading (any level) or EOF. A synthetic preamble section (no heading)
    is emitted when content precedes the first heading. Each section carries
    its full heading_path, computed via a level stack -- pushed for every
    heading regardless of whether its body turns out to be whitespace-only,
    so an empty parent still contributes to its children's path."""
    sections = []
    stack = []  # list of (level, title)

    first_heading_line = headings[0]["line_no"] if headings else total_lines + 1
    if first_heading_line > 1:
        sections.append({
            "heading_line": None,
            "level": 0,
            "title": "",
            "heading_path": "",
            "body_start": 1,
            "body_end": first_heading_line - 1,
        })

    for idx, heading in enumerate(headings):
        level = heading["level"]
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, heading["title"]))
        heading_path = " \u203a ".join(t for _, t in stack)

        body_start = heading["line_no"] + 1
        body_end = (
            headings[idx + 1]["line_no"] - 1 if idx + 1 < len(headings) else total_lines
        )
        sections.append({
            "heading_line": heading["line_no"],
            "level": level,
            "title": heading["title"],
            "heading_path": heading_path,
            "body_start": body_start,
            "body_end": min(body_end, total_lines),
        })
    return sections


def parse_condition_blocks(lines, fenced):
    """Scan the whole file for <important if="..."> containers, outside
    fences. Returns (line_condition, tag_lines, warnings):

      line_condition: {1-based line_no: condition string or None} for every
                       line in the file.
      tag_lines:       set of line numbers that are a *recognized* open or
                       close tag -- these are dropped from every rule's text
                       and do not count toward char/token cost.
      warnings:        human-readable strings for anything rejected: a
                       nested block (kept as literal text under the outer
                       condition, never flattened), a stray closing tag with
                       no matching open, or a block left open at EOF (kept
                       as literal text with no condition at all -- a missing
                       </important> must never silently wrap the rest of
                       the file, possibly crossing headings and swallowing
                       bare invariants, under a condition nobody closed).

    Only one level of nesting is tracked. A second <important if="..."> seen
    while already inside a block is not a new container: its line -- and
    every line until a matching close (if any) -- stays literal body text
    under the *outer* condition, exactly like ordinary prose. This is a
    deliberate rejection, not a flattening: nothing about the inner text is
    dropped or reinterpreted, only its own condition is discarded.
    """
    line_condition = {}
    tag_lines = set()
    warnings = []
    # depth 0: outside any block. depth 1: inside the one real (outer)
    # block. depth > 1: inside a rejected nested block -- its own open/close
    # tags are literal text, and only the matching outer close (the one
    # that brings depth back to 0) is a real tag.
    depth = 0
    current_condition = None
    open_line = None

    for i, raw in enumerate(lines, start=1):
        if i in fenced:
            line_condition[i] = current_condition
            continue

        m_open = IMPORTANT_OPEN_RE.match(raw)
        m_close = IMPORTANT_CLOSE_RE.match(raw)

        if m_open:
            if depth == 0:
                depth = 1
                open_line = i
                current_condition = m_open.group(1)
                tag_lines.add(i)
                line_condition[i] = current_condition
            else:
                warnings.append(
                    f"line {i}: nested <important if> block rejected, kept as "
                    "text under the outer condition (not flattened)"
                )
                depth += 1
                line_condition[i] = current_condition
        elif m_close:
            if depth == 0:
                warnings.append(
                    f"line {i}: stray </important> with no matching open tag "
                    "(kept as text)"
                )
                line_condition[i] = current_condition
            elif depth == 1:
                depth = 0
                tag_lines.add(i)
                line_condition[i] = current_condition
                current_condition = None
                open_line = None
            else:
                # Closes a rejected nested block -- literal, like its open.
                depth -= 1
                line_condition[i] = current_condition
        else:
            line_condition[i] = current_condition

    if depth > 0:
        # Never let a missing </important> silently wrap the rest of the
        # file (potentially crossing headings, potentially swallowing
        # invariants) under a condition nobody closed. Revert it entirely:
        # the opening tag itself reverts to literal text, and every line
        # from the open onward loses its condition. Closes seen at
        # depth > 1 were already literal and never entered tag_lines, so
        # only the outer open needs undoing here.
        warnings.append(
            f"line {open_line}: <important if> block never closed before "
            "end of file (kept as text, condition discarded)"
        )
        tag_lines.discard(open_line)
        for j in range(open_line, len(lines) + 1):
            line_condition[j] = None

    return line_condition, tag_lines, warnings


def build_condition_runs(start, end, line_condition, tag_lines):
    """Split [start, end] (1-based, inclusive) into maximal runs of
    consecutive non-tag lines sharing the same condition. A recognized tag
    line is a run boundary and is itself excluded from every run."""
    if start > end:
        return []
    runs = []
    run_start = None
    run_condition = None
    for i in range(start, end + 1):
        if i in tag_lines:
            if run_start is not None:
                runs.append((run_start, i - 1, run_condition))
                run_start = None
            continue
        condition = line_condition.get(i)
        if run_start is None:
            run_start = i
            run_condition = condition
        elif condition != run_condition:
            runs.append((run_start, i - 1, run_condition))
            run_start = i
            run_condition = condition
    if run_start is not None:
        runs.append((run_start, end, run_condition))
    return runs


def _collapse_ws(text):
    return re.sub(r"\s+", " ", text).strip()


def _first_line_title(text, limit=80):
    first_line = text.splitlines()[0] if text else ""
    collapsed = _collapse_ws(first_line)
    return collapsed[:limit]


def _split_range_into_rules(lines, start, end, fenced, heading_title_fallback):
    """Return rule dicts (without id/file_label/section/condition) for one
    contiguous range of lines, following the list/prose split in
    rule-model.md. `heading_title_fallback` is the title to use when the
    range does not split into list items: the section's own heading title
    when this range is a whole, unwrapped section under a heading, or None
    to fall back to the first line of the body (prose, or a wrapped run that
    is not itself a heading)."""
    body_lines = lines[start - 1:end]
    body_text = "\n".join(body_lines)

    item_starts = [
        i for i in range(start, end + 1)
        if i not in fenced and LIST_ITEM_RE.match(lines[i - 1])
    ]

    rules = []
    if len(item_starts) >= LIST_SPLIT_MIN_ITEMS:
        # Prose before the first item.
        if item_starts[0] > start:
            prose_lines = lines[start - 1:item_starts[0] - 1]
            prose_text = "\n".join(prose_lines)
            if prose_text.strip() != "":
                rules.append({
                    "start_line": start,
                    "end_line": item_starts[0] - 1,
                    "text": prose_text,
                    "title": _first_line_title(prose_text),
                })
        for i, item_start in enumerate(item_starts):
            item_end = item_starts[i + 1] - 1 if i + 1 < len(item_starts) else end
            item_lines = lines[item_start - 1:item_end]
            item_text = "\n".join(item_lines)
            rules.append({
                "start_line": item_start,
                "end_line": item_end,
                "text": item_text,
                "title": _first_line_title(item_text),
            })
    else:
        title = heading_title_fallback if heading_title_fallback is not None else _first_line_title(body_text)
        rules.append({
            "start_line": start,
            "end_line": end,
            "text": body_text,
            "title": title,
        })
    return rules


def split_section_into_rules(lines, section, fenced, line_condition, tag_lines):
    """Return a list of rule dicts (without id/file_label) for one section's
    body, following the split rules in rule-model.md, with the body first
    cut into <important if> runs (parse_condition_blocks /
    build_condition_runs). Each resulting rule carries `condition`: None for
    a bare run, the block's condition text for a wrapped one."""
    start, end = section["body_start"], section["body_end"]
    if start > end:
        return []

    runs = [
        (r_start, r_end, condition)
        for (r_start, r_end, condition) in build_condition_runs(start, end, line_condition, tag_lines)
        if "\n".join(lines[r_start - 1:r_end]).strip() != ""
    ]
    if not runs:
        return []

    # A section with no <important if> tags inside it collapses to exactly
    # one run spanning its whole original body -- this is the byte-for-byte
    # compatible case a file with no blocks at all must always hit, so it
    # keeps the section's own heading as its title fallback, same as before
    # this feature existed. Any other shape (a block inside the section, or
    # a section split by one) always falls back to the first body line.
    whole_section_is_one_run = (
        len(runs) == 1 and runs[0][0] == start and runs[0][1] == end
    )

    rules = []
    for r_start, r_end, condition in runs:
        heading_title_fallback = (
            section["title"] if (whole_section_is_one_run and section["heading_line"]) else None
        )
        run_rules = _split_range_into_rules(lines, r_start, r_end, fenced, heading_title_fallback)
        for rule in run_rules:
            rule["condition"] = condition
        rules.extend(run_rules)

    for rule in rules:
        rule["section"] = section["heading_path"]
        rule["top_level_title"] = (
            section["heading_path"].split(" \u203a ", 1)[0] if section["heading_path"] else ""
        )
    return rules


def extract_rules_from_text(text, file_label, scope):
    """Return (rules, section_rollups, file_meta) for one file's raw text.

    file_meta = {"chars", "est_tokens", "rules"} (rules = count).
    """
    lines = text.splitlines()
    total_lines = len(lines)
    fenced = find_fenced_line_numbers(lines)
    headings = parse_headings(lines, fenced)
    sections = build_sections(total_lines, headings)
    line_condition, tag_lines, condition_warnings = parse_condition_blocks(lines, fenced)

    rules = []
    for section in sections:
        rules.extend(split_section_into_rules(lines, section, fenced, line_condition, tag_lines))

    out_rules = []
    rollup = {}  # top_level_title -> {"chars", "rule_ids"}
    for rule in rules:
        chars = len(rule["text"])
        est_tokens = chars // 4
        rule_id = f"{file_label}#{rule['start_line']}"
        gist = _collapse_ws(rule["text"])[:160]
        out_rules.append({
            "id": rule_id,
            "file_label": file_label,
            "scope": scope,
            "section": rule["section"],
            "title": rule["title"],
            "start_line": rule["start_line"],
            "end_line": rule["end_line"],
            "chars": chars,
            "est_tokens": est_tokens,
            "gist": gist,
            "text": rule["text"],
            "condition": rule.get("condition"),
        })
        bucket = rollup.setdefault(rule["top_level_title"], {"chars": 0, "rule_ids": []})
        bucket["chars"] += chars
        bucket["rule_ids"].append(rule_id)

    section_rollups = [
        {
            "file_label": file_label,
            "title": title,
            "chars": data["chars"],
            "est_tokens": data["chars"] // 4,
            "rule_ids": data["rule_ids"],
        }
        for title, data in rollup.items()
    ]

    file_chars = len(text)
    file_meta = {
        "chars": file_chars,
        "est_tokens": file_chars // 4,
        "rules": len(out_rules),
        "warnings": condition_warnings,
    }
    return out_rules, section_rollups, file_meta


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------


class FileEntry:
    __slots__ = ("path", "scope", "label", "label_explicit")

    def __init__(self, path, scope, label, label_explicit):
        self.path = path
        self.scope = scope
        self.label = label
        self.label_explicit = label_explicit


def _register(registry, order, path, scope, label, label_explicit):
    """Insert or merge a discovered/explicit file into the dedup registry.

    Dedup key is the resolved real path. When the same file is seen twice:
    - scope: an auto-discovered scope ("global"/"project") always wins over
      the "referenced" default, because the file genuinely is always
      injected -- demoting it would silently drop it from
      injected_est_tokens.
    - label: an explicit label (given after ":" in --file) always wins.
    """
    try:
        key = str(path.resolve())
    except OSError:
        key = str(path)
    if key not in registry:
        registry[key] = FileEntry(path, scope, label, label_explicit)
        order.append(key)
        return
    existing = registry[key]
    if existing.scope == "referenced" and scope != "referenced":
        existing.scope = scope
    if label_explicit:
        existing.label = label
        existing.label_explicit = True


def discover_files(repos, scope_arg, no_auto, explicit_files):
    """Return an ordered list of FileEntry, deduplicated by real path."""
    registry = {}
    order = []

    if not no_auto:
        if scope_arg in ("all", "global"):
            seen_names = {}
            for candidate in GLOBAL_CANDIDATES:
                path = Path(candidate).expanduser()
                if not path.is_file():
                    continue
                name = path.name
                if seen_names.get(name, 0) == 0:
                    label = f"global:{name}"
                else:
                    label = f"global:{path.parent.name}/{name}"
                seen_names[name] = seen_names.get(name, 0) + 1
                _register(registry, order, path, "global", label, False)

        if scope_arg in ("all", "project"):
            for repo_arg in repos:
                repo = Path(repo_arg).expanduser().resolve()
                for candidate in PROJECT_CANDIDATES:
                    path = repo / candidate
                    if not path.is_file():
                        continue
                    label = f"{repo.name}:{candidate.split('/')[-1]}"
                    if candidate.count("/"):
                        label = f"{repo.name}:{candidate}"
                    _register(registry, order, path, "project", label, False)

    for raw in explicit_files:
        if ":" in raw and not _looks_like_windows_drive(raw):
            file_part, label = raw.rsplit(":", 1)
        else:
            file_part, label = raw, None
        path = Path(file_part).expanduser()
        if not path.is_file():
            print(f"warning: --file not found, skipping: {file_part}", file=sys.stderr)
            continue
        if label:
            explicit_label, explicit = label, True
        else:
            explicit_label, explicit = _default_referenced_label(path, repos), False
        _register(registry, order, path, "referenced", explicit_label, explicit)

    return [registry[key] for key in order]


def _looks_like_windows_drive(raw):
    # Defensive only; this skill targets POSIX-style paths but a lone
    # "C:\..." shouldn't be mis-split on its drive-letter colon.
    return re.match(r"^[A-Za-z]:[\\/]", raw) is not None


def _default_referenced_label(path, repos):
    resolved = path.resolve()
    for repo_arg in repos:
        repo = Path(repo_arg).expanduser().resolve()
        try:
            resolved.relative_to(repo)
            return f"{repo.name}:{path.name}"
        except ValueError:
            continue
    try:
        resolved.relative_to(Path.home())
        return f"global:{path.name}"
    except ValueError:
        pass
    return f"referenced:{path.name}"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, help="directory to write rules.json into")
    p.add_argument("--repo", action="append", default=[], help="project root (repeatable)")
    p.add_argument(
        "--scope", choices=("all", "global", "project"), default="all",
        help="which auto-discovery categories to run (default: all)",
    )
    p.add_argument(
        "--file", action="append", default=[], dest="files",
        help="explicit extra file, PATH or PATH:LABEL (repeatable)",
    )
    p.add_argument("--no-auto", action="store_true", help="skip auto-discovery")
    p.add_argument(
        "--only", action="store_true",
        help="disable auto-discovery entirely; extract only the --file paths given "
             "(requires at least one --file)",
    )
    args = p.parse_args(argv)
    if args.only and not args.files:
        p.error("--only requires --file (auto-discovery is disabled by --only, so "
                 "at least one --file path is needed)")
    return args


def main(argv=None):
    args = parse_args(argv)
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    entries = discover_files(args.repo, args.scope, args.no_auto or args.only, args.files)

    if not entries:
        print("error: no instruction file found (auto-discovery empty and no --file given)",
              file=sys.stderr)
        sys.exit(1)

    all_rules = []
    all_sections = []
    files_out = []
    warnings = []

    for entry in entries:
        try:
            text = entry.path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(f"warning: could not read {entry.path}: {exc}", file=sys.stderr)
            continue

        rules, sections, meta = extract_rules_from_text(text, entry.label, entry.scope)
        all_rules.extend(rules)
        all_sections.extend(sections)
        files_out.append({
            "label": entry.label,
            "path": str(entry.path.resolve()),
            "scope": entry.scope,
            "chars": meta["chars"],
            "est_tokens": meta["est_tokens"],
            "rules": meta["rules"],
        })

        if meta["rules"] < MIN_RULES_PER_FILE_WARNING:
            warnings.append(
                f"  ! {entry.label}: only {meta['rules']} rule(s) -- "
                "granularity may have collapsed (see rule-model.md)"
            )
        largest = max((r["chars"] for r in rules), default=0)
        if largest > RULE_SIZE_WARNING_CHARS:
            warnings.append(
                f"  ! {entry.label}: largest rule is {largest} chars "
                f"(> {RULE_SIZE_WARNING_CHARS}) -- too big to judge or obey"
            )
        for condition_warning in meta.get("warnings", []):
            warnings.append(f"  ! {entry.label}: {condition_warning}")

    injected_est_tokens = sum(
        f["est_tokens"] for f in files_out if f["scope"] != "referenced"
    )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "injected_est_tokens": injected_est_tokens,
        "files": files_out,
        "rules": all_rules,
        "sections": all_sections,
    }
    (out_dir / "rules.json").write_text(json.dumps(report, indent=2))

    print(f"rules.json:        {out_dir / 'rules.json'}")
    print(f"files graded:      {len(files_out)}")
    print(f"injected est tokens: {injected_est_tokens}")
    for f in files_out:
        largest = max((r["chars"] for r in all_rules if r["file_label"] == f["label"]), default=0)
        print(
            f"  {f['label']:30s} scope={f['scope']:10s} rules={f['rules']:4d} "
            f"est_tokens={f['est_tokens']:6d} largest_rule_chars={largest}"
        )
    if warnings:
        print("granularity warnings:")
        for w in warnings:
            print(w)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Verify that a judge's cited quotes actually appear in the transcript they
claim to come from -- SKILL.md Step 4's mechanical check on findings.json.

A judge (scorers/adherence.md) is asked to copy `quote` verbatim from the
transcript it was shown. This script is the only thing that checks that
claim: it whitespace-folds both the quote and the transcript text and
requires the folded quote to be a literal substring of the folded
transcript. It is deliberately a literal-substring check, not a fuzzy
match -- a paraphrase must fail, and so must a quote that only differs in
case, because case is not whitespace.

Failure has four distinct reasons, and they are reported separately because
they mean different things to whoever reads findings.verified.json:

  quote_missing         the finding carries no usable quote text at all.
  quote_too_short       the quote is real but too short to prove anything
                         (a 3-character quote is trivially a substring).
  not_found             the transcript was read fine; the quote just is not
                         in it -- this is the judge confabulating.
  transcript_unreadable the transcript_path is missing or could not be
                         read -- an input-data problem, not a confabulation,
                         so it must never be folded into the judge's error
                         rate.

Emits:
  <out>/findings.verified.json - every input finding, in order, with every
                                  original field preserved, plus `verified`
                                  and `reason_code` (null when verified),
                                  and a top-level `stats` block.

Python 3.9+, stdlib only. Reads only findings_json and the transcript_path
files it names; writes only under --out; makes no network call; never
modifies a transcript or the input findings file.
"""

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

WHITESPACE_RE = re.compile(r"\s+")

REASON_CODES = ("quote_missing", "quote_too_short", "not_found", "transcript_unreadable")


def fold_whitespace(text):
    """Collapse every run of whitespace to a single space and strip ends.

    Deliberately does NOT lowercase and does NOT strip punctuation -- this
    must stay a literal-substring check, not a fuzzy match. A quote that
    differs from the transcript only in case is a real verification
    failure, not noise to smooth over.
    """
    return WHITESPACE_RE.sub(" ", text).strip()


def load_transcript_text(path):
    """Read one transcript file. Returns None if it cannot be read.

    A separate, patchable function so callers can count/observe real reads
    even though results are cached per run -- see get_folded_transcript.
    """
    try:
        return Path(path).expanduser().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def get_folded_transcript(path, cache):
    """Return the whitespace-folded transcript at `path`, cached per run.

    Many findings usually share a transcript_path; this makes sure each
    distinct path is only read from disk once per run, regardless of how
    many findings cite it. `cache` is owned by the caller (main), never a
    module-level dict, so nothing leaks between separate script runs or
    between tests.
    """
    if not isinstance(path, str) or not path:
        return None
    if path in cache:
        return cache[path]
    text = load_transcript_text(path)
    folded = fold_whitespace(text) if text is not None else None
    cache[path] = folded
    return folded


def verify_one(finding, min_quote_chars, transcript_cache):
    """Return (verified, reason_code) for one finding dict."""
    quote_raw = finding.get("quote")
    if not isinstance(quote_raw, str) or not quote_raw.strip():
        return False, "quote_missing"

    folded_quote = fold_whitespace(quote_raw)
    if len(folded_quote) < min_quote_chars:
        return False, "quote_too_short"

    folded_transcript = get_folded_transcript(finding.get("transcript_path"), transcript_cache)
    if folded_transcript is None:
        return False, "transcript_unreadable"

    if folded_quote in folded_transcript:
        return True, None
    return False, "not_found"


def transcript_key(finding):
    path = finding.get("transcript_path")
    return path if isinstance(path, str) and path else "(missing)"


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("findings_json", help="path to a findings.json ({'findings': [...]})")
    p.add_argument("--out", required=True)
    p.add_argument("--min-quote-chars", type=int, default=12,
                    help="minimum folded-quote length required to count as evidence (default: 12)")
    return p.parse_args(argv)


def load_findings_file(path):
    """Load and structurally validate the input file. Raises ValueError on
    any malformed shape -- caller turns that into a non-zero exit."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"could not read {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
        raise ValueError(f"{path} is not a valid findings file (expected {{'findings': [...]}})")
    return data["findings"]


def main(argv=None):
    args = parse_args(argv)
    findings_path = Path(args.findings_json).expanduser()

    try:
        findings = load_findings_file(findings_path)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    transcript_cache = {}
    verified_findings = []
    reason_counts = Counter()
    by_transcript = {}
    verified_count = 0
    skipped_non_object = 0

    for finding in findings:
        if not isinstance(finding, dict):
            skipped_non_object += 1
            continue

        verified, reason_code = verify_one(finding, args.min_quote_chars, transcript_cache)
        if verified:
            verified_count += 1
        else:
            reason_counts[reason_code] += 1

        # dict(finding) carries every input field through untouched --
        # including scorers/adherence.md's optional `trigger` field, which
        # this script never verifies (only `quote` is checked mechanically).
        out_finding = dict(finding)
        out_finding["verified"] = verified
        out_finding["reason_code"] = reason_code
        verified_findings.append(out_finding)

        key = transcript_key(finding)
        bucket = by_transcript.setdefault(key, {"total": 0, "verified": 0, "unverified": 0})
        bucket["total"] += 1
        bucket["verified" if verified else "unverified"] += 1

    total = len(verified_findings)
    stats = {
        "total": total,
        "verified": verified_count,
        "unverified": total - verified_count,
        "skipped_non_object_entries": skipped_non_object,
        "by_reason_code": {code: reason_counts.get(code, 0) for code in REASON_CODES},
        "by_transcript": by_transcript,
    }

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "min_quote_chars": args.min_quote_chars,
        "findings": verified_findings,
        "stats": stats,
    }
    out_path = out_dir / "findings.verified.json"
    out_path.write_text(json.dumps(report, indent=2))

    print(f"findings.verified.json: {out_path}")
    print(f"total findings:  {stats['total']}")
    print(f"verified:        {stats['verified']}")
    print(f"unverified:      {stats['unverified']}")
    for code in REASON_CODES:
        count = stats["by_reason_code"][code]
        if count:
            print(f"  {code}: {count}")
    if skipped_non_object:
        print(f"warning: skipped {skipped_non_object} non-object finding entries", file=sys.stderr)


if __name__ == "__main__":
    main()

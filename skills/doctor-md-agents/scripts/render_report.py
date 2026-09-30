#!/usr/bin/env python3
"""Render an doctor-md-agents report.json (SKILL.md Step 6 schema) into one
self-contained report.html.

The page is meant to make the budget argument readable at a glance: how much
is spent on always-injected instruction files, which rules have zero
evidence behind them despite their cost, and what would fix that. It has no
external assets, no CDN scripts or stylesheets, and makes no network call --
everything (including any proposed replacement text found on disk next to
report.json) is inlined at render time, once, here.

Output (next to report.json by default, or --out):
  report.html

Python 3.9+, stdlib only.
"""

import argparse
import html
import json
import sys
import webbrowser
from pathlib import Path

VERDICT_ORDER = ("keep", "improve", "drop", "unknown")
VERDICT_LABELS = {
    "keep": "keep", "improve": "improve", "drop": "drop", "unknown": "unknown",
}
ADHERENCE_LABELS = {
    "followed": "followed", "mixed": "mixed", "violated": "violated",
    "insufficient_evidence": "no evidence in sample",
}


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def esc_attr(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def open_report(path: Path) -> bool:
    try:
        return bool(webbrowser.open(path.absolute().as_uri(), new=2))
    except (OSError, webbrowser.Error):
        return False


def fmt_pct(part, whole) -> str:
    if not whole:
        return "0%"
    return f"{round(100 * part / whole)}%"


def resolve_proposed_text(proposed_path, base_dir: Path):
    if not proposed_path:
        return None
    candidate = Path(proposed_path)
    if not candidate.is_absolute():
        candidate = base_dir / candidate
    try:
        return candidate.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def render_diff(diff_text) -> str:
    if not diff_text:
        return ""
    lines_html = []
    for line in diff_text.splitlines():
        cls = "diff-ctx"
        if line.startswith("+++") or line.startswith("---"):
            cls = "diff-hdr"
        elif line.startswith("@@"):
            cls = "diff-hunk"
        elif line.startswith("+"):
            cls = "diff-add"
        elif line.startswith("-"):
            cls = "diff-del"
        lines_html.append(f'<span class="diff-line {cls}">{esc(line)}</span>')
    return '<pre class="diff">' + "\n".join(lines_html) + "</pre>"


def render_proposed_block(rule, base_dir: Path) -> str:
    proposed_path = rule.get("proposed_path")
    diff_text = rule.get("diff")
    proposed_text = resolve_proposed_text(proposed_path, base_dir)
    if not proposed_path and not diff_text:
        return ""
    parts = []
    if proposed_text:
        parts.append(f'<div class="proposed-text"><pre>{esc(proposed_text)}</pre></div>')
    elif proposed_path:
        parts.append('<p class="muted">Proposed text file not found on disk.</p>')
    if diff_text:
        parts.append(render_diff(diff_text))
    if not parts:
        return ""
    return (
        "<details class=\"proposed\"><summary>proposed change</summary>"
        + "".join(parts) + "</details>"
    )


PAGE_CSS = """
* { box-sizing: border-box; }
:root {
  --fg: #16151a; --muted: #5d5966; --muted-2: #8a8592; --accent: #4338ca;
  --line: rgba(20, 16, 40, 0.14); --line-soft: rgba(20, 16, 40, 0.06);
  --bg: #fdfcfe; --surface: #ffffff; --panel: #f4f3f8;
  --keep: #1a7f4b; --improve: #b3730a; --drop: #b3261e; --unknown: #6b7280;
  --add-bg: rgba(26, 127, 75, 0.12); --add-fg: #12613a;
  --del-bg: rgba(179, 38, 30, 0.10); --del-fg: #8f221c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #f1eef7; --muted: #bdb8c7; --muted-2: #948f9e; --accent: #a5b4fc;
    --line: rgba(240, 235, 255, 0.18); --line-soft: rgba(240, 235, 255, 0.07);
    --bg: #131019; --surface: #1b1725; --panel: #201c2b;
    --keep: #6bcf9a; --improve: #e0ad4f; --drop: #f0857c; --unknown: #a7a2b0;
    --add-bg: rgba(107, 207, 154, 0.14); --add-fg: #9be0bd;
    --del-bg: rgba(240, 133, 124, 0.14); --del-fg: #f6b3ac;
  }
}
html, body { background: var(--bg); }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg); margin: 0; padding: 0 0 64px; line-height: 1.5;
  max-width: 100%; overflow-x: hidden;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px; }
a { color: var(--accent); }
code { background: var(--panel); padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 36px 0 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 15px; margin: 20px 0 6px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 10px 0 4px; }
.meta-item { font-size: 13px; color: var(--muted); }
.meta-item b { color: var(--fg); font-variant-numeric: tabular-nums; }
.denominator-note { font-size: 12.5px; color: var(--muted-2); margin-top: 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin: 14px 0; }
.card { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 14px 16px; }
.card .label { font-weight: 600; margin-bottom: 6px; word-break: break-word; }
.card .stat-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin-top: 3px; }
.card .stat-row b { color: var(--fg); }
.verdict-pills { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
.pill.keep { color: var(--keep); border-color: var(--keep); }
.pill.improve { color: var(--improve); border-color: var(--improve); }
.pill.drop { color: var(--drop); border-color: var(--drop); }
.pill.unknown { color: var(--unknown); border-color: var(--unknown); }
.badge { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; display: inline-block; white-space: nowrap; }
.badge.keep { background: color-mix(in srgb, var(--keep) 16%, transparent); color: var(--keep); }
.badge.improve { background: color-mix(in srgb, var(--improve) 16%, transparent); color: var(--improve); }
.badge.drop { background: color-mix(in srgb, var(--drop) 16%, transparent); color: var(--drop); }
.badge.unknown { background: color-mix(in srgb, var(--unknown) 16%, transparent); color: var(--unknown); }
.badge.followed { background: color-mix(in srgb, var(--keep) 16%, transparent); color: var(--keep); }
.badge.mixed { background: color-mix(in srgb, var(--improve) 16%, transparent); color: var(--improve); }
.badge.violated { background: color-mix(in srgb, var(--drop) 16%, transparent); color: var(--drop); }
.badge.insufficient_evidence { background: color-mix(in srgb, var(--unknown) 16%, transparent); color: var(--unknown); }
/* Rule cards -- one card per rule, stacked in a single column. Prose
   (rationale, evidence quotes) and short labelled metrics never share a
   grid/table cell, which is what made the old 9-column table unreadable:
   a rationale sentence forced into a narrow numeric column wraps to one
   word per line. See ../references (no external file -- this comment is
   the record) and the render_rule_card()/render_rule_cards_section()
   functions below. */
.rule-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0 12px; }
.rule-toolbar .toolbar-label { font-size: 12px; color: var(--muted-2); margin-right: 2px; }
.rule-toolbar button { font: inherit; font-size: 12.5px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; cursor: pointer; }
.rule-toolbar button::after { content: ""; opacity: 0.6; margin-left: 5px; }
.rule-toolbar button[data-dir="asc"] { border-color: var(--accent); color: var(--accent); }
.rule-toolbar button[data-dir="asc"]::after { content: "\\25B2"; }
.rule-toolbar button[data-dir="desc"] { border-color: var(--accent); color: var(--accent); }
.rule-toolbar button[data-dir="desc"]::after { content: "\\25BC"; }
.rule-cards { display: flex; flex-direction: column; gap: 12px; margin: 0 0 24px; min-width: 0; }
.rule-card { border: 1px solid var(--line); background: var(--surface); border-radius: 10px;
  padding: 14px 16px; border-left-width: 3px; min-width: 0; max-width: 100%; overflow: hidden; }
.rule-card.v-keep { border-left-color: var(--keep); }
.rule-card.v-improve { border-left-color: var(--improve); }
.rule-card.v-drop { border-left-color: var(--drop); }
.rule-card.v-unknown { border-left-color: var(--unknown); }
.rule-card.has-harm { background: var(--del-bg); }
.rule-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.rule-title { font-weight: 600; min-width: 0; overflow-wrap: anywhere; flex: 1 1 auto; }
.rule-card-head .badge { flex: 0 0 auto; }
.rule-card-sub { color: var(--muted); font-size: 11.5px; margin-top: 3px; min-width: 0; overflow-wrap: anywhere; }
.rule-card-sub code { overflow-wrap: anywhere; }
.rule-metrics { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; }
.metric { display: inline-flex; align-items: baseline; gap: 5px; font-size: 12.5px; min-width: 0; }
.metric-label { color: var(--muted-2); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
.metric-value { color: var(--fg); font-variant-numeric: tabular-nums; }
.rule-rationale { margin: 10px 0 0; font-size: 13.5px; line-height: 1.55; text-wrap: pretty; }
details.evidence { margin-top: 8px; }
details.evidence summary { cursor: pointer; font-size: 12.5px; color: var(--accent); }
ul.evidence-list { list-style: none; margin: 6px 0 0; padding: 0; }
ul.evidence-list li { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; background: var(--panel); }
ul.evidence-list blockquote { margin: 6px 0 4px; padding-left: 8px; border-left: 2px solid var(--line); font-style: italic; }
.finding-block { border: 1px solid var(--drop); background: var(--del-bg); border-radius: 10px; padding: 16px 18px; margin: 14px 0 24px; }
.finding-block h3 { margin-top: 0; }
.missing-rule { border: 1px solid var(--line); background: var(--surface); border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
.missing-rule .occ { font-size: 12.5px; color: var(--muted); }
details.proposed { margin-top: 8px; }
details.proposed summary { cursor: pointer; font-size: 12.5px; color: var(--accent); }
.proposed-text pre, pre.diff { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; white-space: pre; margin: 6px 0; }
pre.diff .diff-line { display: block; }
pre.diff .diff-add { background: var(--add-bg); color: var(--add-fg); }
pre.diff .diff-del { background: var(--del-bg); color: var(--del-fg); }
pre.diff .diff-hunk { color: var(--muted-2); }
pre.diff .diff-hdr { color: var(--muted-2); font-weight: 600; }
ul.notes { font-size: 13px; color: var(--muted); padding-left: 18px; }
ul.notes li { margin-bottom: 6px; }
.top-findings li { margin-bottom: 6px; }
.evidence-ids { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: var(--muted); }
footer.page-footer { max-width: 1080px; margin: 40px auto 0; padding: 0 16px; font-size: 12px; color: var(--muted-2); }
"""

SORT_SCRIPT = """
(function () {
  document.querySelectorAll('.rule-toolbar').forEach(function (toolbar) {
    var container = toolbar.nextElementSibling;
    if (!container || !container.classList.contains('rule-cards')) return;
    var buttons = toolbar.querySelectorAll('button[data-key]');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.key;
        var type = btn.dataset.type || 'string';
        var dir = btn.dataset.dir === 'asc' ? 'desc' : 'asc';
        buttons.forEach(function (other) { delete other.dataset.dir; });
        btn.dataset.dir = dir;
        var cards = Array.prototype.slice.call(container.querySelectorAll('.rule-card'));
        cards.sort(function (a, b) {
          var av = a.dataset[key];
          var bv = b.dataset[key];
          if (type === 'number') {
            av = parseFloat(av) || 0;
            bv = parseFloat(bv) || 0;
            return dir === 'asc' ? av - bv : bv - av;
          }
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
          return 0;
        });
        cards.forEach(function (card) { container.appendChild(card); });
      });
    });
  });
})();
"""


def render_file_card(f, injected_total) -> str:
    verdicts = f.get("verdicts") or {}
    share = fmt_pct(f.get("est_tokens", 0), injected_total) if f.get("scope") != "referenced" else "n/a"
    pills = "".join(
        f'<span class="pill {v}">{esc(VERDICT_LABELS.get(v, v))}: {int(verdicts.get(v, 0))}</span>'
        for v in VERDICT_ORDER
    )
    return f"""<div class="card">
  <div class="label">{esc(f.get('label'))}</div>
  <div class="stat-row"><span>scope</span><b>{esc(f.get('scope'))}</b></div>
  <div class="stat-row"><span>rules</span><b>{esc(f.get('rules', 0))}</b></div>
  <div class="stat-row"><span>est. tokens</span><b>{esc(f.get('est_tokens', 0))}</b></div>
  <div class="stat-row"><span>share of injected total</span><b>{esc(share)}</b></div>
  <div class="verdict-pills">{pills}</div>
</div>"""



# The class field says what an adherence failure was worth (scorers/adherence.md):
# "non-compliance" argues for rewriting the rule, "harm" is the only class
# that can argue for dropping it, "irrelevant" argues for narrowing its
# scope. Reuse the existing verdict badge palette so the distinction reads
# at a glance without inventing a second color language.
EVIDENCE_CLASS_BADGE = {"harm": "drop", "non-compliance": "improve", "irrelevant": "unknown"}


def render_classes_badges(classes) -> str:
    classes = classes or {}
    harm = int(classes.get("harm", 0) or 0)
    noncompliance = int(classes.get("non-compliance", 0) or 0)
    irrelevant = int(classes.get("irrelevant", 0) or 0)
    if not (harm or noncompliance or irrelevant):
        return '<span class="muted small">—</span>'
    parts = []
    if harm:
        parts.append(
            '<span class="badge drop" title="harm: following the rule made the outcome worse -- '
            f'the strongest case for dropping it">harm {harm}</span>'
        )
    if noncompliance:
        parts.append(
            '<span class="badge improve" title="non-compliance: the rule was right and was not '
            f'followed -- argues for rewriting it, never removal">non-compliance {noncompliance}</span>'
        )
    if irrelevant:
        parts.append(
            '<span class="badge unknown" title="irrelevant: applied where it did not belong">'
            f'irrelevant {irrelevant}</span>'
        )
    return " ".join(parts)


def render_evidence_block(evidence) -> str:
    if not evidence:
        return ""
    # Backward compatibility: the old shape was a bare list of session-id
    # strings. Render it as a bare session list rather than crashing on it.
    if all(isinstance(e, str) for e in evidence):
        ids_html = ", ".join(esc(e) for e in evidence)
        return (
            '<details class="evidence"><summary>evidence</summary>'
            f'<div class="evidence-ids">{ids_html}</div></details>'
        )
    items = []
    for e in evidence:
        if not isinstance(e, dict):
            items.append(f'<li><span class="evidence-ids">{esc(e)}</span></li>')
            continue
        session_id = e.get("session_id", "")
        cls = e.get("class", "")
        quote = e.get("quote", "")
        reason = e.get("reason", "")
        badge_variant = EVIDENCE_CLASS_BADGE.get(cls, "unknown")
        cls_badge = f'<span class="badge {esc_attr(badge_variant)}">{esc(cls)}</span>' if cls else ""
        quote_html = f'<blockquote>{esc(quote)}</blockquote>' if quote else ""
        reason_html = f'<div class="small muted">{esc(reason)}</div>' if reason else ""
        items.append(
            f'<li><span class="evidence-ids">{esc(session_id)}</span> {cls_badge}'
            f'{quote_html}{reason_html}</li>'
        )
    return (
        f'<details class="evidence"><summary>evidence ({esc(len(evidence))})</summary>'
        f'<ul class="evidence-list">{"".join(items)}</ul></details>'
    )


def render_rule_card(rule, base_dir: Path) -> str:
    verdict = rule.get("verdict") or "unknown"
    adherence = rule.get("adherence") or "insufficient_evidence"
    title = rule.get("title") or ""
    section = rule.get("section") or ""
    evidence = rule.get("evidence") or []
    classes = rule.get("classes") or {}
    harm = int(classes.get("harm", 0) or 0)
    noncompliance = int(classes.get("non-compliance", 0) or 0)
    irrelevant = int(classes.get("irrelevant", 0) or 0)
    applicable_sessions = rule.get("applicable_sessions", 0) or 0
    est_tokens = rule.get("est_tokens", 0) or 0

    # Step 6's schema carries no per-rule "unverified evidence" count -- it
    # is derived here: a rule the judging pass actually reached
    # (applicable in some transcript, or carrying a real adherence label)
    # but whose evidence list came back empty means every citation it had
    # failed verify_citations.py's quote check.
    was_judged = bool(applicable_sessions) or adherence not in (None, "insufficient_evidence")
    unverified_marker = ""
    if was_judged and not evidence:
        unverified_marker = (
            ' <span class="badge unknown" title="Judges found this rule applicable, but no cited '
            'quote survived verify_citations.py -- this rule\'s case is unverified.">evidence unverified</span>'
        )

    classes_html = render_classes_badges(classes) if (harm or noncompliance or irrelevant) else ""
    classes_metric = f'<span class="metric">{classes_html}</span>' if classes_html else ""

    evidence_block = render_evidence_block(evidence)
    proposed_block = render_proposed_block(rule, base_dir)
    card_class = f"rule-card v-{esc_attr(verdict)}" + (" has-harm" if harm else "")

    return f"""<div class="{card_class}" data-tokens="{esc_attr(est_tokens)}" data-sessions="{esc_attr(applicable_sessions)}" data-verdict="{esc_attr(verdict)}">
  <div class="rule-card-head">
    <div class="rule-title">{esc(title)}{unverified_marker}</div>
    <span class="badge {esc_attr(verdict)}">{esc(VERDICT_LABELS.get(verdict, verdict))}</span>
  </div>
  <div class="rule-card-sub">{esc(section)} &middot; <code>{esc(rule.get('id'))}</code> &middot; línea {esc(rule.get('line', 0))}</div>
  <div class="rule-metrics">
    <span class="metric"><span class="metric-label">coste</span><span class="metric-value">{esc(est_tokens)} tokens</span></span>
    <span class="metric"><span class="metric-label">sesiones</span><span class="metric-value">{esc(applicable_sessions)} / {esc(rule.get('judged_sessions', 0))}</span></span>
    <span class="metric"><span class="metric-label">adherence</span><span class="badge {esc_attr(adherence)}">{esc(ADHERENCE_LABELS.get(adherence, adherence))}</span></span>
    {classes_metric}
    <span class="metric"><span class="metric-label">corrections</span><span class="metric-value">{esc(rule.get('corrections', 0))}</span></span>
  </div>
  <p class="rule-rationale">{esc(rule.get('rationale', ''))}</p>
  {proposed_block}
  {evidence_block}
</div>"""


def render_rule_cards_section(file_label, rules, base_dir: Path) -> str:
    cards = "".join(render_rule_card(r, base_dir) for r in rules)
    toolbar = """<div class="rule-toolbar">
  <span class="toolbar-label">ordenar por</span>
  <button type="button" data-key="tokens" data-type="number">coste</button>
  <button type="button" data-key="sessions" data-type="number">sesiones</button>
  <button type="button" data-key="verdict" data-type="string">veredicto</button>
</div>"""
    return f"""{toolbar}
<div class="rule-cards">{cards}</div>"""


def render_no_evidence_block(rules, injected_total) -> str:
    no_evidence = [
        r for r in rules
        if (r.get("adherence") or "insufficient_evidence") == "insufficient_evidence"
        and not r.get("corrections")
    ]
    if not no_evidence:
        return ""
    token_sum = sum(r.get("est_tokens", 0) for r in no_evidence)
    share = fmt_pct(token_sum, injected_total)
    items = "".join(
        f'<li><code>{esc(r.get("id"))}</code> — {esc(r.get("title"))} '
        f'<span class="muted">({esc(r.get("est_tokens", 0))} tokens)</span></li>'
        for r in sorted(no_evidence, key=lambda r: -r.get("est_tokens", 0))[:25]
    )
    more = len(no_evidence) - 25
    more_html = f"<li class=\"muted\">...and {more} more.</li>" if more > 0 else ""
    return f"""<div class="finding-block">
  <h3>No evidence, {esc(len(no_evidence))} rules, {esc(share)} of the injected budget</h3>
  <p class="small muted">These rules collected no adherence evidence in the sampled transcripts and no
  corrections in the full corpus. That means the sample never saw them -- not that they are unused.</p>
  <ul>{items}{more_html}</ul>
</div>"""


def render_structure_block(entry) -> str:
    label = entry.get("file_label", "")
    bare = int(entry.get("bare", 0) or 0)
    wrapped = int(entry.get("wrapped", 0) or 0)
    estimated = int(entry.get("estimated_conditions", 0) or 0)
    blocks = entry.get("blocks") or []
    proposed_path = entry.get("proposed_path")
    diff_path = entry.get("diff_path")

    rows = []
    for block in blocks:
        condition = block.get("condition", "")
        basis = block.get("basis", "")
        rule_ids = block.get("rule_ids") or []
        sessions = block.get("sessions") or []
        basis_badge = f'<span class="badge {esc_attr(basis) or "unknown"}">{esc(basis)}</span>' if basis else ""
        rule_ids_html = ", ".join(f"<code>{esc(rid)}</code>" for rid in rule_ids)
        sessions_html = (
            f'<div class="small muted evidence-ids">sessions: {", ".join(esc(s) for s in sessions)}</div>'
            if sessions else ""
        )
        rows.append(f"""<li>
  <div><strong>{esc(condition)}</strong> {basis_badge}</div>
  <div class="small">{rule_ids_html}</div>
  {sessions_html}
</li>""")

    links = []
    if proposed_path:
        links.append(f'<code>{esc(proposed_path)}</code>')
    if diff_path:
        links.append(f'<code>{esc(diff_path)}</code>')
    links_html = f'<div class="small muted">{" &middot; ".join(links)}</div>' if links else ""

    return f"""<div class="missing-rule">
  <div class="rule-title">{esc(label)}</div>
  <div class="occ">bare: {esc(bare)} &middot; wrapped: {esc(wrapped)} &middot; estimated conditions: {esc(estimated)}</div>
  {links_html}
  <ul class="evidence-list">{"".join(rows)}</ul>
</div>"""


def render_structure_section(structure) -> str:
    if not structure:
        return ""
    blocks_html = "".join(render_structure_block(entry) for entry in structure)
    return f"""<h2>Proposed restructure</h2>
<div>{blocks_html}</div>"""


def render_missing_rules(missing_rules) -> str:
    if not missing_rules:
        return "<p class=\"muted\">No missing-rule candidates with 2+ occurrences.</p>"
    blocks = []
    for m in missing_rules:
        evidence = m.get("evidence") or []
        evidence_html = ", ".join(esc(e) for e in evidence) if evidence else "—"
        proposed_text = m.get("proposed_text")
        proposed_html = (
            f'<details class="proposed"><summary>proposed text</summary>'
            f'<div class="proposed-text"><pre>{esc(proposed_text)}</pre></div></details>'
        ) if proposed_text else ""
        nearest = m.get("nearest_rule")
        nearest_html = f'<div class="small muted">nearest existing rule: <code>{esc(nearest)}</code></div>' if nearest else ""
        blocks.append(f"""<div class="missing-rule">
  <div class="rule-title">{esc(m.get('title'))}</div>
  <div class="occ">{esc(m.get('occurrences', 0))} occurrence(s) &middot; sessions:
    <span class="evidence-ids">{evidence_html}</span></div>
  {nearest_html}
  {proposed_html}
</div>""")
    return "".join(blocks)


def render_page(report: dict, base_dir: Path) -> str:
    title = report.get("title") or "Agent Instructions Report"
    generated_at = report.get("generated_at") or ""
    harness = report.get("harness") or "n/a"
    scope = report.get("scope") or "n/a"
    windows = report.get("windows") or {}
    stats = report.get("stats") or {}
    files = report.get("files") or []
    rules = report.get("rules") or []
    missing_rules = report.get("missing_rules") or []
    top_findings = report.get("top_findings") or []
    notes = report.get("notes") or []

    injected_total = stats.get("est_tokens", 0) or sum(
        f.get("est_tokens", 0) for f in files if f.get("scope") != "referenced"
    )

    findings_total = stats.get("findings_total", 0) or 0
    findings_unverified = stats.get("findings_unverified", 0) or 0
    findings_verified = findings_total - findings_unverified

    verification_note = ""
    if findings_unverified:
        # findings_unverified/findings_total are ints from report.json, esc()'d individually;
        # the surrounding text is a static literal, so nothing here needs re-escaping.
        verification_note = (
            f" {esc(findings_unverified)} of {esc(findings_total)} judged findings failed quote "
            "verification and are excluded from every rule's evidence below."
        )

    meta_html = f"""<div class="meta-row">
  <div class="meta-item">scope: <b>{esc(scope)}</b></div>
  <div class="meta-item">harness: <b>{esc(harness)}</b></div>
  <div class="meta-item">corrections window: <b>{esc(windows.get('corrections_days', '?'))} days</b></div>
  <div class="meta-item">adherence window: <b>{esc(windows.get('adherence_days', '?'))} days</b></div>
  <div class="meta-item">sessions scanned (corrections): <b>{esc(stats.get('sessions_scanned', 0))}</b></div>
  <div class="meta-item">sessions judged (adherence): <b>{esc(stats.get('sessions_judged', 0))}</b></div>
  <div class="meta-item">corrections found: <b>{esc(stats.get('corrections_found', 0))}</b></div>
  <div class="meta-item">corrections dropped as machine-written: <b>{esc(stats.get('corrections_dropped_as_machine', 0))}</b></div>
  <div class="meta-item">findings verified: <b>{esc(findings_verified)}</b> / <b>{esc(findings_total)}</b></div>
  <div class="meta-item">always-injected est. tokens: <b>{esc(injected_total)}</b></div>
</div>
<p class="denominator-note">Corrections and adherence have different denominators and are never divided by
each other: corrections come from {esc(stats.get('sessions_scanned', 0))} scanned sessions (the whole
window), adherence from {esc(stats.get('sessions_judged', 0))} judged transcripts (a sample).{verification_note}</p>"""

    findings_html = "".join(f"<li>{esc(f)}</li>" for f in top_findings) or "<li class=\"muted\">No findings recorded.</li>"

    cards_html = "".join(render_file_card(f, injected_total) for f in files)

    rules_by_file = {}
    for r in rules:
        rules_by_file.setdefault(r.get("file_label", ""), []).append(r)
    rule_sections_html = ""
    for f in files:
        label = f.get("label", "")
        file_rules = rules_by_file.get(label, [])
        if not file_rules:
            continue
        rule_sections_html += f"<h3>{esc(label)}</h3>" + render_rule_cards_section(label, file_rules, base_dir)

    no_evidence_html = render_no_evidence_block(rules, injected_total)
    structure_html = render_structure_section(report.get("structure") or [])
    missing_html = render_missing_rules(missing_rules)
    notes_html = "".join(f"<li>{esc(n)}</li>" for n in notes) or "<li class=\"muted\">No notes.</li>"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{esc(title)}</title>
<style>{PAGE_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>{esc(title)}</h1>
  <p class="muted small">Generated {esc(generated_at)}</p>
  {meta_html}

  <h2>Top findings</h2>
  <ul class="top-findings">{findings_html}</ul>

  <h2>Files</h2>
  <div class="cards">{cards_html}</div>

  <h2>No-evidence budget</h2>
  {no_evidence_html or '<p class="muted">Every rule collected at least some evidence.</p>'}

  <h2>Rules by file</h2>
  {rule_sections_html or '<p class="muted">No rules recorded.</p>'}

  {structure_html}

  <h2>Missing-rule candidates</h2>
  {missing_html}

  <h2>Notes</h2>
  <ul class="notes">{notes_html}</ul>
</div>
<footer class="page-footer">Rendered locally by doctor-md-agents. Nothing on this page was uploaded anywhere.</footer>
<script>{SORT_SCRIPT}</script>
</body>
</html>"""


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("report_path", help="path to report.json")
    p.add_argument("--out", default=None, help="output HTML path (default: next to report.json)")
    p.add_argument("--open", action="store_true", dest="open_browser")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    report_path = Path(args.report_path).expanduser()
    if not report_path.exists():
        print(f"error: {report_path} not found", file=sys.stderr)
        sys.exit(1)
    report = json.loads(report_path.read_text(encoding="utf-8"))

    out_path = Path(args.out).expanduser() if args.out else report_path.parent / "report.html"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_page(report, report_path.parent), encoding="utf-8")

    print(f"report: {out_path.absolute().as_uri()}")
    if args.open_browser:
        if open_report(out_path):
            print("        opened in the default browser")
        else:
            print("warning: could not open the report in the default browser", file=sys.stderr)


if __name__ == "__main__":
    main()

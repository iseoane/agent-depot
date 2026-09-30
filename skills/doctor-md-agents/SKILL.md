---
name: "doctor-md-agents"
description: "Runs only when the user asks for it by name. Grades the agent instruction files (AGENTS.md, CLAUDE.md and friends) against real local conversation history: which rules were ever applicable, which were obeyed, which the user had to correct by hand, what they cost in tokens, and which rules are missing. Never invoke it on inferred intent, on a related-sounding question about instructions or token budget, or as a step inside another workflow — only when the user names this skill."
argument-hint: "[--mode grade|restructure|both] [--scope repo|all|<path>...] [--files global|repo|both] [--days N]"
disable-model-invocation: true
---
# doctor-md-agents

Grade the instruction files that are injected into every prompt — `AGENTS.md`, `CLAUDE.md`, and any extra file the user names — by measuring them against the user's own local conversation history. Produce one report page with, per rule: how often it was applicable, whether it was obeyed, how often the user had to correct the agent on that point, what it costs in tokens, and a verdict of **keep / improve / drop**. Then propose the rules that are *missing*, mined from repeated user corrections that no current rule covers.

## Invocation: only when the user asks for it by name

This skill runs **only when the user names it**. Do not start it because a question resembles its subject — someone asking why a rule keeps being ignored, what their instruction files cost, or whether a rule is worth keeping is asking a question, not requesting an audit. Answer the question instead.

It is also never a step inside another workflow: no other skill, review, planning or implementation flow may invoke it on its own. A full run reads hundreds of sessions and spends several judging passes; that cost is the user's to authorize, every time.

Invocation arguments only preset answers to Step 0's questions — see "Arguments" under Step 0. They never make the skill run on inferred intent: the skill still runs only when the user names it explicitly, exactly as above.

Everything runs locally. Never upload transcripts, session files, instruction files, or any excerpt of them anywhere. The only shareable artifact is the report the user chooses to share.

Let `SKILL_ROOT` be the directory containing this SKILL.md.

## What this skill does and does not claim

A skill either fires or does not, and the transcript shows it. A rule in an instruction file is *always* in context, so "was it used?" is not observable. Only two things are observable, and they have **different denominators** — keep them apart everywhere, in the report and in what you tell the user:

- **Corrections (hard signal).** The user explicitly correcting the agent on a point. Mined by string patterns over the **entire** session corpus in the window (hundreds of sessions). Reliable evidence.
- **Adherence (soft signal).** A model judging, per sampled transcript, whether an applicable rule was followed. Sampled (a couple of dozen transcripts). Noisy — good for ranking candidates, never for deleting a rule on its own.

Never divide one by the other and never merge them into a single score. A rule with 9 corrections across 372 sessions and "followed" adherence across 20 judged transcripts is not a contradiction; those are two measurements of different things.

**Never edit the user's instruction files in this run.** Proposals go to `$REPORT_DIR/proposed/`. Applying them is a separate, explicitly confirmed step.

## Step 0: Start the run

### Nothing to resolve

Every script this skill runs lives under `$SKILL_ROOT/scripts/`, including the session collector, which reads Claude Code, Codex, Pi, Grok Build and ZCode history. The skill has no runtime dependency on any other skill or harness.

### Arguments

Invocation arguments: `$ARGUMENTS`. If the value shown in backticks above is empty, or is the unexpanded placeholder itself (a dollar sign followed by the word ARGUMENTS, meaning the harness did not substitute it), treat it as no arguments — every question below is asked, exactly as before this section existed.

Otherwise, parse it as flags, each preset-answering one question from "Ask the scope" below:

| Flag | Accepted values | Presets |
|---|---|---|
| `--mode` | `grade`, `restructure`, `both` | Question 3 — `grade` → *Grade only*, `restructure` → *Restructure only (no session evidence)*, `both` → *Grade and restructure* |
| `--scope` | `repo`, `all`, or one or more paths | Question 1 — `repo` → *Conversations in this repository*, `all` → *All conversations*, one or more paths → *Choose projects* with those paths. Paths are consumed until the next `--flag`. Ignored, with a one-line note, when the resolved mode is *Restructure only* for every selected file — see below. |
| `--files` | `global`, `repo`, `both` | Question 2 — `global` → *Global only*, `repo` → *This repository's only*, `both` → *Global + this repository's* |
| `--days N` | a positive integer | sets the **corrections** window (Step 2) to `N` days instead of the default 90; the adherence sample window stays 45. Under *Restructure only*, Step 2 does not run, so `--days` has no effect there. |

Validate before creating `REPORT_DIR` — a malformed invocation must leave no scratch directory behind. Stop and print the accepted syntax — `[--mode grade|restructure|both] [--scope repo|all|<path>...] [--files global|repo|both] [--days N]` — plus the specific reason, never guessing a value or falling back to a default, for any of:

- an unknown flag, or a flag repeated more than once
- a value for `--mode`/`--files` outside its accepted list, or a `--scope` value that is neither `repo`, `all`, nor a path
- a `--days` value that is not a positive integer
- a `--scope` path that does not validate as a git repository, the same check a manually-chosen project path gets
- `--scope repo` or `--files repo` when the current directory is not inside a git repository

`--mode` only matters when Question 3 would otherwise apply (at least one selected file has no `<important if>` blocks yet — see Question 3 below, which depends on the `--files`/Question 2 answer being resolved first). If `--mode` is given but every selected file already has blocks, say so in one line ("`--mode` ignored: all selected files already restructured") and do not ask Question 3.

Question 1 depends on the mode in turn: when the resolved mode — from `--mode` or from Question 3's answer — is *Restructure only* and it covers **every** selected file (none of them already has `<important if>` blocks, so none needs Steps 2–4 to be graded), Question 1 is not asked at all, since Steps 2–4 never run for this file set. If `--scope` was given in that case, say so in one line ("`--scope` ignored: restructure-only run, no conversations to mine") instead of asking about it or using it. If even one selected file already has blocks, that file still needs mining to be graded, so Question 1 is asked regardless of what the mode turns out to be. See "Ask the scope" below for the ordering this implies and for what happens when Question 2 later changes the selected-file set.

Ask, in as few interactions as the ordering in "Ask the scope" below requires, only the questions that arguments did not already answer and that apply. If arguments answered every question that applies, ask nothing — but still do the rest of "Ask the scope" below (create `REPORT_DIR`, run the block check that decides whether Questions 1 and 3 apply), then print the resolved choices, including the auto-discovered file list, before moving to Step 1.

### Ask the scope

Create one fresh scratch directory per run and use it as `REPORT_DIR` for every artifact. Never write into the user's repo or into the skill directory:

```bash
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doctor-md-agents-XXXXXXXX")"
```

Check whether the current directory is inside a git repository (`git rev-parse --show-toplevel`). Before asking anything, check each candidate file (auto-discovered, narrowed by any `--files` preset) for an own-line `<important if="` opening tag (`references/rule-model.md` — same recognition rule the extractor uses: the tag alone on its line, up to 3 leading spaces). This single check decides both whether Question 3 applies and, together with the mode, whether Question 1 applies.

1. **"Which conversations should I mine?"** — *Conversations in this repository* (recommended when there is one) / *All conversations* (recommended when there is not) / *Choose projects*. For chosen projects, ask for paths and validate each as a git repository.
2. **"Which instruction files should I grade?"** — *Global + this repository's* (recommended) / *This repository's only* / *Global only*. Mention the files auto-discovery found, so the user can add one you missed.
3. **"What should this run do?"** (only when at least one selected file has no `<important if>` blocks yet, and only about those files) — *Grade and restructure* (recommended) / *Grade only* / *Restructure only (no session evidence)*. A file that already has blocks is read as already restructured, is graded only (Step 5b is skipped for it regardless of the answer), and is never asked about again.

*Restructure only* skips Steps 2–4 entirely: no corrections mining, no transcript sampling, no adherence judging. It also skips Step 5's verdicts — with no adherence or correction evidence to apply `rule-value.md` to, every rule keeps verdict `unknown` and goes straight into Step 5b. Every condition Step 5b writes is marked `estimated`, and the report says so. Use it for a file with no session history yet, or to reorder quickly without spending a judging pass.

The mode must be known — from `--mode` or from Question 3's answer — before deciding whether Question 1 is asked, since Question 1 is skipped only when the resolved mode is *Restructure only* for every selected file. Using the harness's user-question tool when available, resolve in this order:

- The mode is already known (`--mode` given, or Question 3 does not apply because every selected file already has blocks, which always needs Question 1 to be graded): ask Question 1 together with whichever of Questions 2 and 3 arguments left unanswered, all in one interaction — except that when the now-known mode is *Restructure only* covering every selected file, Question 1 is not asked at all, only the rest.
- The mode is not yet known, but at least one selected file already has blocks: that file needs Question 1 regardless of what Question 3's answer turns out to be, so asking together is possible — ask Questions 1, 2 and 3 together in one interaction, as before.
- The mode is not yet known and every selected file lacks blocks: Question 1's necessity depends entirely on the still-unknown mode, so asking it together with Question 3 is not possible. Ask Question 3 first, alone (together with Question 2 if that is also unanswered). Once the answer comes back, ask Question 1 in a second, separate interaction — unless the answer is *Restructure only*, in which case skip Question 1 entirely.

All three bullets above decide Question 1's applicability from the candidate files known before asking. Question 2's "add one you missed" can change the selected set afterward, so re-run the block check on any file the user adds through Question 2, then re-decide Question 1 against that final set, not the original candidates:

- A newly added file has blocks, and Question 1 was skipped or is about to be: ask Question 1 now (in the same interaction if it has not been sent yet, otherwise as one more follow-up), since that file needs mining to be graded.
- A newly added file has no blocks and none of the added files change the outcome, and Question 1 was already asked and answered under a mode that turns out to be *Restructure only* for the now-final set: the collected answer is unnecessary — drop it and say so in one line, the same way an ignored `--scope` is noted.

Default window: 90 days for the corrections pass, 45 for the adherence sample. `--days N` (see Arguments above) overrides only the corrections window. Accept a different window if the user asks, even without `--days`.

## Step 1: Extract the rules

```bash
python3 "$SKILL_ROOT/scripts/extract_rules.py" --out "$REPORT_DIR" \
  <--repo PATH per selected repo | --scope global> [--file PATH[:LABEL]]...
```

This writes `$REPORT_DIR/rules.json`: every instruction file it graded, every rule inside it with a stable `id`, its heading path, line range, character count and estimated tokens, plus a per-section rollup. Read `references/rule-model.md` for what counts as one rule and why the rollup exists.

Read `rules.json`. Sanity-check the granularity before going on: a large prose contract file should land in the low hundreds of rules, a compact project file in the dozens. If a single rule is thousands of characters, note it in the findings as a rule that is too big to judge or to obey — that is itself a finding.

If no instruction file is found, stop and say so.

## Step 2: Mine the corrections (hard signal, full corpus)

```bash
python3 "$SKILL_ROOT/scripts/scan_corrections.py" --out "$REPORT_DIR" \
  --days <90, or N from --days> <--repo PATH... | --all-conversations>
```

This reads the raw session logs directly — every session in the window, not just the sampled ones — and writes `$REPORT_DIR/corrections.json`: each user turn that looks like a correction, with session id, timestamp, cwd, branch, the matched pattern, the user's words, and a short excerpt of what the agent had just done. It also groups them into rough keyword clusters.

Not every `user` turn was typed by a human. Sub-agents, audit harnesses, judges and other skills all write turns that the log records as `user`, and they are long, templated and repeated verbatim across hundreds of sessions — left unfiltered they drown the real corrections. The script drops them by shape, not by name: turns above `--max-turn-chars`, turns whose normalized text repeats across `--template-threshold` or more distinct sessions, and turns carrying the self-session sentinel. Read `stats.turns_dropped_*` in the output: if the dropped counts dwarf the kept ones, say so — it means this corpus is mostly machine-driven and the corrections signal is thin.

The clusters are a starting point, not an answer. Read them and:

- Merge, split and rename clusters by meaning. Drop anything that is not really a correction (the patterns over-match on purpose — a missed correction cannot be recovered later, a false positive costs one read).
- For each real cluster, decide whether an existing rule in `rules.json` already covers it. If one does, attach the cluster to that rule id — those corrections are evidence that the rule exists and is *not working*. If none does, it becomes a **missing-rule candidate**.

Cite session ids for every cluster. A cluster with one occurrence is an anecdote; say so rather than proposing a rule from it.

## Step 3: Sample transcripts for the adherence pass

```bash
python3 "$SKILL_ROOT/scripts/collect_sessions.py" --out "$REPORT_DIR" \
  <conversation-scope arguments> \
  --days 45 --max-sessions 20 --sample newest
```

Scope arguments are `--repo PATH` (repeatable) or `--all-conversations`. `--sample newest` takes the newest N sessions with no skill-related stratification, which is what this report needs.

Read `$REPORT_DIR/inventory.json` and take the session list from `inventory.sessions`, using each entry's `transcript_path`. Ignore every skill-related field in that file — this run is not about skills. Deduplicate by session id. If `sessions_sampled` is 0, continue with the corrections pass alone and say clearly in the report that no adherence judgment was possible.

## Step 4: Judge adherence

Score transcripts in the current local agent process, or delegate only to local child agents that keep transcript contents on this machine. Process up to 50 transcripts in one batch; beyond that, use parallel batches of about 20.

Build a **rule index** to pass as context: for every rule, its `id`, file label, heading path and `gist` — not the full text. Pass `$SKILL_ROOT/scorers/adherence.md` as the rubric.

Every prompt you send to a judge — including a delegated child agent's — must start with the self-session sentinel line, on its own line:

```
<!-- doctor-md-agents:self-session -->
```

This is how a future run recognizes its own prompts in the logs and refuses to mine them as user corrections. A run that omits it poisons the next one's evidence.

For each transcript, record only the rules the transcript gives evidence about, in the shape `scorers/adherence.md` defines: the five required fields (`rule_id`, `label`, `class`, `quote`, `reason`) plus the optional sixth, `trigger` — what the session was doing when the rule applied. `trigger` feeds Step 5b's conditions directly, so record it whenever a clear one-clause answer exists. A rule the transcript never had occasion to touch is simply absent from that transcript's result. Absence is the normal case; do not invent `not_applicable` entries for 200 rules.

Write the collected findings to `$REPORT_DIR/findings.json` as `{"findings": [ ... ]}`, each carrying its `transcript_path`, then verify them:

```bash
python3 "$SKILL_ROOT/scripts/verify_citations.py" "$REPORT_DIR/findings.json" --out "$REPORT_DIR"
```

This whitespace-folds each `quote` and the transcript the finding came from and requires the quote to be a literal substring. It writes `$REPORT_DIR/findings.verified.json`, marking each finding `verified: true|false`. **Aggregate only the verified ones.** Carry the unverified count into the report: a judge that cites text which is not there is confabulating, and a rule whose entire case was unverified has no case.

Then aggregate per rule, counting **distinct sessions** rather than findings: `applicable_sessions` (sessions that judged it anything other than `not_applicable`), the adherence label from the rubric's aggregation table, the judging denominator, and the counts per evidence class. Never take a count from a judge's own claim — compute it. A rule that no sampled transcript could judge gets `insufficient_evidence`, which is *not* the same as "never applicable", and the report must not present it as such.

## Step 5: Verdicts

Skip this step entirely under *Restructure only* (Step 0): with no corrections or adherence evidence gathered, every rule keeps verdict `unknown` and goes straight into Step 5b.

Apply `$SKILL_ROOT/scorers/rule-value.md` to every rule, using its token cost, its applicability, its adherence label, and its correction count. Each verdict is `keep` / `improve` / `drop` / `unknown` with a one-sentence rationale naming the evidence that produced it.

Two constraints that the rubric enforces and you must not relax:

- A `drop` verdict needs a cost argument plus absence of evidence for the rule, never a low adherence score. Low adherence means the rule is not working, which argues for `improve` — a rewrite, a move to a more visible position, a concrete command instead of prose.
- Nothing is dropped because a model found it mediocre. The payload of this report is the budget: rank by `est_tokens` × absence of evidence, and lead with the aggregate — "these N rules are X% of the file and no sampled session was ever able to judge them."

For each `improve` rule, write the proposed replacement text to `$REPORT_DIR/proposed/<file-label>/<rule-id>.md` and produce a unified diff against the current rule text. For each missing-rule candidate with 2+ occurrences, write the proposed new rule the same way, with the evidence sessions listed.

## Step 5b: Restructure

Skip this step if the user chose *Grade only*. Read `$SKILL_ROOT/references/structure.md` first.

Work per instruction file, on the rules that survive Step 5 (every verdict except `drop`; a `drop` stays in place and is left to its own confirmation — under *Restructure only*, every rule survives, since Step 5 never ran). For each rule:

1. Decide bare or wrapped using the thresholds and exceptions in `structure.md`. Record the ratio that decided it, or `invariant` / `estimated`. Under *Restructure only*, every condition is `estimated` — there is no adherence sample to compute a ratio from.
2. For wrapped rules, write the condition from the verified findings' `trigger` fields and the attached correction clusters. Cite the session ids behind it. When a rule has no evidence (or Steps 2–4 never ran), derive the condition from the rule's own text instead, and mark it `estimated`.
3. Group rules only when their conditions are the same situation.

Write the whole restructured file to `$REPORT_DIR/proposed/<file-label>/RESTRUCTURED.md` and its unified diff against the current file to `RESTRUCTURED.diff`. The rule text inside each block is the Step 5 replacement when the rule got `improve`, and the original text otherwise; the restructure never rewrites a rule on its own.

Skip a file entirely if Step 0 found it already had `<important if>` blocks — it was graded only, and its existing structure is left alone.

Check before writing: re-extract `RESTRUCTURED.md` on its own —

```bash
python3 "$SKILL_ROOT/scripts/extract_rules.py" --out "$REPORT_DIR/proposed/<file-label>/check" \
  --file "$REPORT_DIR/proposed/<file-label>/RESTRUCTURED.md:restructured" --only
```

— using `--only` so auto-discovery never pulls in whatever CLAUDE.md/AGENTS.md the repo happens to have; only the restructured file itself is parsed. `ids` are internal bookkeeping and are never written into the file, so match by text, not id: every rule from `rules.json` that is not `drop` must have its text (the Step 5 replacement when it got `improve`, the original text otherwise) appear exactly once in the re-extracted output, and every command and fenced block from the original must be present. If either check fails, fix it; never ship a restructure that lost a rule.

When assembling `RESTRUCTURED.md` programmatically from extracted `text` fields, copy each rule's whitespace exactly as extracted: an extra or missing blank line inside a rule changes its text and breaks the "appears exactly once" check above.

Record, per file, how many blocks were written, how many rules stayed bare vs got wrapped, and how many conditions are `estimated` — this feeds `report.json`'s `structure` section (Step 6). Under *Restructure only*, there is no evidence session to cite for any block, so every block's `sessions` is `[]` and its `basis` is `estimated`, not just some of the wrapped ones.

## Step 6: Report

Write `$REPORT_DIR/report.json`:

```json
{
  "title": "Agent Instructions Report",
  "generated_at": "<ISO timestamp>",
  "harness": "<from inventory.json, or 'n/a'>",
  "scope": "<repo name, project list, or 'all conversations'>",
  "windows": {"corrections_days": 90, "adherence_days": 45},
  "stats": {
    "files": 0, "rules": 0, "est_tokens": 0,
    "sessions_scanned": 0, "sessions_judged": 0,
    "corrections_found": 0, "corrections_dropped_as_machine": 0,
    "rules_without_evidence": 0,
    "findings_total": 0, "findings_unverified": 0
  },
  "files": [
    {"label": "", "path": "", "scope": "global|project", "rules": 0, "est_tokens": 0,
     "verdicts": {"keep": 0, "improve": 0, "drop": 0, "unknown": 0}}
  ],
  "top_findings": ["", "", ""],
  "rules": [
    {"id": "", "file_label": "", "section": "", "title": "", "line": 0, "est_tokens": 0,
     "applicable_sessions": 0, "judged_sessions": 0,
     "adherence": "followed|mixed|violated|insufficient_evidence",
     "classes": {"harm": 0, "non-compliance": 0, "irrelevant": 0},
     "corrections": 0, "verdict": "keep|improve|drop|unknown",
     "rationale": "",
     "evidence": [{"session_id": "", "class": "", "quote": "", "reason": ""}],
     "proposed_path": null, "diff": null}
  ],
  "missing_rules": [
    {"title": "", "occurrences": 0, "evidence": ["<session id>"],
     "proposed_path": "", "proposed_text": "", "nearest_rule": null}
  ],
  "structure": [
    {"file_label": "", "proposed_path": "", "diff_path": "",
     "bare": 0, "wrapped": 0, "estimated_conditions": 0,
     "blocks": [{"condition": "", "rule_ids": [""], "basis": "measured|estimated",
                 "sessions": ["<session id>"]}]}
  ],
  "notes": [""]
}
```

`structure` is Step 5b's output and is entirely optional: omit it when Step 5b did not run (the user chose *Grade only*), and `render_report.py` renders the rest of the page exactly the same either way. When present, put the count of `estimated` conditions (summed across every file's `structure` entry) in `notes` alongside the rest.

Under *Restructure only*, every block's `basis` is `"estimated"` and its `sessions` is `[]` — there is no adherence sample or correction cluster to cite a session from, for any block, not only the wrapped ones. When Question 1 was not asked (Step 0 skipped it — see "Ask the scope"), set the top-level `scope` field to `"n/a (restructure only, no conversations mined)"` and leave `sessions_scanned`/`sessions_judged`/`corrections_found` at `0`.

Put these in `notes` every time: the denominator caveat (corrections come from `sessions_scanned` sessions, adherence from `sessions_judged`), how many machine-written turns were dropped from the corrections pass, how many findings failed quote verification, and — when `structure` is present — the estimated-conditions count above. Then render:

```bash
python3 "$SKILL_ROOT/scripts/render_report.py" "$REPORT_DIR/report.json" --open
```

That writes one self-contained `$REPORT_DIR/report.html` and tries to open it.

## Step 7: Output

Tell the user, in text: the total token cost of their instruction files, the three top findings, the single largest block of rules with no evidence, and the count of missing-rule candidates. Then:

- Your instruction file report: `file://$REPORT_DIR/report.html`
- Proposed edits (nothing applied): `$REPORT_DIR/proposed/`
- Proposed restructure (nothing applied): `$REPORT_DIR/proposed/<file-label>/RESTRUCTURED.md`

Ask whether to apply any of the proposed edits. Apply only the ones the user names, one file at a time, and show each diff before writing. Never apply a `drop` without the user confirming that specific rule.

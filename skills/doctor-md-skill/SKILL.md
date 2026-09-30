---
name: "doctor-md-skill"
description: "Runs only when the user asks for it by name. Grades agent skills by scoring agent conversations against efficiency and code-quality rubrics, using verbatim-quote anchored evidence, then drafts concrete skill edits and a shareable report. Never invoke it on inferred intent, on a related-sounding question — whether a skill is working, whether an agent setup is any good, why a skill never fires — or as a step inside another workflow — only when the user names this skill."
disable-model-invocation: true
---
# doctor-md-skill

Grade the user's agent setup by scoring recent local agent conversations, then propose concrete skill edits and render one shareable report page.

The report can cover conversations in the current repository, conversations in selected projects, or all local conversations. It can evaluate project skills alone or project and global skills together.

Everything runs locally. Never upload transcripts, session files, or any excerpt of them anywhere. The only shareable artifact is the report the user chooses to post.

## Explicit invocation only

Run this skill only when the user names it directly (for example "doctor-md-skill", "run doctor-md-skill", or an explicit slash/skill invocation). A question that merely sounds related — "is my agent setup any good?", "which of my skills actually work?", "why doesn't skill X ever fire?" — is a question to answer directly, not a request to run a full grading pass over hundreds of sessions. Do not run it as a step another workflow decided it needed on your own initiative. If a request sounds like a fit but did not name this skill, ask the user whether they want to run it rather than starting it. This applies even after this file is already loaded into context: loading it is not the same as being asked to run it. `disable-model-invocation: true` above stops the harness from invoking this skill on inferred intent; this section is the reminder for an agent that has already loaded it.

Let `SKILL_ROOT` be the directory containing this SKILL.md.

## Step 0: Start the run

### Verify the executing harness

Read `$SKILL_ROOT/references/supported-harnesses.md` and identify the harness executing this skill from the runtime context. If it is unsupported or cannot be identified confidently, follow the reference's stop behavior. Do not create a report directory or read conversation history.

### Ask which conversations to grade

First check whether the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

Use the harness's user-question tool when available.

When a current repository is available, ask **“Which conversations should I grade?”** with:

1. **Conversations in this repository** — recommended.
2. **All conversations**.
3. **Choose projects to analyze**.

When there is no current repository, ask the same question with:

1. **All conversations** — recommended.
2. **Choose projects to analyze**.

If the user chooses projects, ask for one or more project paths. Expand and validate every path as a git repository before continuing. The run produces one combined report across those projects.

### Ask which skills to evaluate

Then ask **“Which skills should I evaluate?”** with:

1. **Project skills + global skills** — recommended.
2. **Project skills only**.

For an all-conversations run, “Project skills” means skills from local git repositories inferred from the conversations' working directories. After these answers, proceed immediately.

Never write artifacts into the user's repo. Create one fresh, collision-free scratch directory per run and use it as `REPORT_DIR` for every artifact:

```bash
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/doctor-md-skill-XXXXXXXX")"
```

## Step 1: Collect
Build the collector arguments from the startup answers:

- Current repository: `--repo "$REPO"`.
- Selected projects: repeat `--repo PATH` for every project.
- All conversations: `--all-conversations`.
- Project and global skills: add `--include-global-skills`.
- Project skills only: do not add `--include-global-skills`.

```bash
python3 "$SKILL_ROOT/scripts/collect_sessions.py" \
  --out "$REPORT_DIR" \
  <conversation-scope arguments> \
  <skill-scope arguments>
```

By default `--harness auto` scans every locally available supported source. Read `$SKILL_ROOT/references/supported-harnesses.md` for source identifiers, storage details, skill locations, and source-specific override flags.

Useful flags:

- `--harness VALUE` — which local session sources to scan; use the reference's collector IDs.
- `--repo PATH` — include a project; repeatable.
- `--all-conversations` — do not filter conversations by project.
- `--include-global-skills` — also grade global skills.
- `--days N` — lookback window (default 45).
- `--max-sessions N` — cap on sampled sessions (default 12).
- `--skills-dir PATH` — nonstandard skill locations.
- `--include-subagents` — include child or sidechain sessions.

Read `$REPORT_DIR/inventory.json`. If `sessions_sampled` is 0, tell the user there is nothing recent to score in the selected conversation scope (suggest raising `--days` or choosing different projects) and stop. If `skills_found` is 0, continue — the report becomes a case for creating skills, and `skill_coverage` is 0.

## Step 2: Exclude machine-driven sessions

Not every session in local history was a human talking to an agent. Sub-agents are already excluded by the collector (it drops sidechains by default), but a top-level session launched by other tooling — an audit harness, a judge, another skill — still looks like an ordinary session, and its "user" turn is a programmatically built prompt, not something a person typed. Left in the sample, these drag efficiency and code-quality grades around for work a human never did.

```bash
python3 "$SKILL_ROOT/scripts/detect_machine_sessions.py" \
  --out "$REPORT_DIR" \
  --days <window_days from inventory.json>
```

This scans the same raw session logs the collector reads and flags session ids (format `<harness>:<session-id>`, matching the collector's own sampling key) whose first user turn is unusually long, whose normalized opening repeats across several distinct sessions (a template), or which carries this skill's own self-session sentinel (see Step 3). It writes `$REPORT_DIR/machine_sessions.json`.

Read `machine_sessions.json`. Drop every sampled session in `inventory.json` whose key appears in `flagged_sessions` from the set to be scored in Step 3 — do not delete its transcript file, just exclude it from scoring. Record `sessions_dropped_as_machine` = the number dropped this way. If dropped sessions outnumber the sessions that remain to be scored, say so plainly in the findings: the surviving corpus is mostly machine-driven and the grades rest on very little.

## Step 3: Score each sampled transcript

Scoring is based on efficiency and code quality for the sessions sampled, minus whatever Step 2 dropped. Process datasets of 50 transcripts or fewer in a single batch. For datasets with more than 50 transcripts, use parallel batches (20 transcripts per batch recommended). Score batches in the current local agent process, or delegate only to local child agents that keep transcript contents on the user's machine. Pass the following rubrics as context:

- `$SKILL_ROOT/scorers/efficiency.md`
- `$SKILL_ROOT/scorers/code-quality.md`

Every prompt sent to a judge — including a delegated child agent's — must start with the self-session sentinel line, on its own line, so any future run of this skill recognizes its own scoring prompts in the logs and never grades itself:

```
<!-- doctor-md-skill:self-session -->
```

Instructions: For each remaining transcript in `$REPORT_DIR/transcripts/`, read it and judge it against both rubrics. For each scorer record: `session_id`, `transcript_path` (absolute path to the transcript file under `$REPORT_DIR/transcripts/`), `scorer` (`efficiency` or `code-quality`), `label`, numeric `score` (from the rubric's label table), a 1–3 sentence `reason` citing specifics from the transcript, and `quote` — a verbatim excerpt copied character-for-character from the transcript, per each rubric's Quote section. Apply the code-quality scorer only where the transcript shows code changes; otherwise record `insufficient_evidence` with an empty `quote` and exclude that result from the code-quality average and failed-conversation filter.

Write every result to `$REPORT_DIR/results.json` as `{"results": [ {...}, ... ]}`.

## Step 4: Verify quotes

A scorer citing a quote is not the same as the quote actually being there — on a real run, judges have claimed to have grep-verified a quote that was not in the transcript. This step is the mechanical check on that claim, and only what survives it is used for anything downstream.

```bash
python3 "$SKILL_ROOT/scripts/verify_citations.py" "$REPORT_DIR/results.json" --out "$REPORT_DIR"
```

This writes `$REPORT_DIR/results.verified.json`: every result from Step 3, unchanged, plus `verified` (true/false) and `reason_code` (`null` when verified, else `quote_missing`, `quote_too_short`, `not_found`, or `transcript_unreadable`). Read its `stats.verified` and `stats.unverified`. **Only `verified: true` results are aggregated in Step 5** — an unverified result is not scored down, it is dropped entirely, and its count is surfaced in the report instead. An `insufficient_evidence` result (empty quote by design) is exempt from this filter and still counts in Step 5 as before.

If `stats.unverified` is a large share of `stats.total`, say so plainly in the findings: a scoring run with many unverified quotes is a broken run, and if every result for a given scorer was unverified, that scorer has no case this run.

## Step 5: Aggregate

- `raw_efficiency` = mean of efficiency scores across all **verified** sessions (plus `insufficient_evidence` sessions, which are exempt from verification).
- `raw_code_quality` = mean of code-quality scores, excluding `insufficient_evidence`, across all **verified** sessions. If no session had enough evidence, set it to 0.5 and say so in the findings.
- Curve qualitative rubric means into letter-grade report scores with `curve(score) = 0.5 + 0.5 * score`.
- `efficiency = curve(raw_efficiency)`.
- `code_quality = curve(raw_code_quality)`.
- `skill_coverage` = fraction of sampled (post-Step-2) sessions where at least one installed skill was detected. If `skills_found` is 0, coverage is 0.
- `overall = 0.5 * efficiency + 0.35 * code_quality + 0.15 * skill_coverage.`

Then, define `failed_conversations` from each conversation's raw, uncurved, **verified** scorer results. A conversation fails when at least one applicable, verified efficiency or code-quality score is below `0.5`. An `insufficient_evidence` result does not make a conversation fail. Use only `failed_conversations` as evidence for skill-improvement suggestions and draft skill edits.

Then derive the substance:

- `top_findings`: the 3 most impactful, specific patterns across sessions. These lead the report and the spoken summary. Make each summary concrete and concise, following the STE-100 standard.
- `suggestions`: concrete skill changes, if any. Each names a skill (existing or proposed-new) and a specific change: a trigger-description fix so it fires when it should, a missing step or check, a command to encode, a new skill to create. Suggestions must trace back to observed waste or defects in `failed_conversations`, not generic best practices — cite the failed session, scorer, and moment that motivated each one. An installed skill that never triggered in a failed conversation is usually a description problem and worth a suggestion of its own.

## Step 6: Draft skill edits

Follow `$SKILL_ROOT/references/skill-improvements.md` to propose improvements to project skills based only on `failed_conversations`.

1. Read the skill's current file (path is in `inventory.json`).
2. Write the full improved version to `$REPORT_DIR/proposed/<skill-name>/SKILL.md`, changing only what the evidence justifies. Improve the parts the sessions actually exercised: the trigger description that failed to fire, the missing preflight check, the step the agent had to figure out by trial and error.
3. Produce a unified diff between current and proposed (`diff -u <current> <proposed>`) and put it in the suggestion's `diff` field so it renders in the report.

For a proposed-new skill, write the complete new SKILL.md to the same `proposed/` directory and set `diff` to its full content as an addition.

Do not modify the user's real skill files in this step.

## Step 7: Write report.json and render
Write `$REPORT_DIR/report.json`. Store the curved `efficiency` and `code_quality` values, literal `skill_coverage`, and weighted `overall` in `scores`; do not store the raw rubric means there. `unverified_quotes` is `results.verified.json`'s `stats.unverified`; `sessions_dropped_as_machine` is Step 2's count.

```json
{
  "title": "Agent Skill Report",
  "generated_at": "<ISO timestamp>",
  "harness": "<harness from inventory.json>",
  "handle": "<repo_name from inventory.json>",
  "stats": {
    "sessions_analyzed": 0, "sessions_scanned": 0,
    "skills_found": 0, "skills_used": 0, "window_days": 45,
    "sessions_dropped_as_machine": 0, "unverified_quotes": 0
  },
  "scores": {"efficiency": 0.0, "code_quality": 0.0, "skill_coverage": 0.0, "overall": 0.0},
  "top_findings": ["", "", ""],
  "suggestions": [
    {
      "skill": "",
      "change": "<one-sentence summary of the edit>",
      "evidence": "<which session(s) and what happened that motivates this>",
      "proposed_path": "<path under proposed/, if an edit was drafted>",
      "diff": "<unified diff, or full content for a new skill>"
    }
  ]
}
```

```bash
python3 "$SKILL_ROOT/scripts/render_report.py" "$REPORT_DIR/report.json" --open
```

This writes a single self-contained `$REPORT_DIR/report.html` and attempts to open it in the default browser. The scorecard, findings, and suggested skill edits appear on one page. Long diffs are collapsed behind a "show more" toggle, and a "share as png" button exports a 1200x675 share image locally. There is no separate card file to open or screenshot.

## Step 8: Output

Tell the user the grade and the three findings, in text.

Finish every response with this exact summary, substituting the absolute `REPORT_DIR` path:

- Your agent skill report: file://$REPORT_DIR/report.html

Want me to apply these suggestions to your skills?

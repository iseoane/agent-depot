# doctor-md-skill

It grades your agent setup by scoring recent local agent conversations against efficiency and code-quality rubrics, then drafts concrete skill edits and renders one shareable HTML report. Everything runs locally; nothing is uploaded.

## Design

- **Quote-anchored scoring.** A judge asked to "quote or closely paraphrase" the evidence for a finding can invent a quote, and nothing afterwards checks it. On a real run of the sibling skill (`doctor-md-agents`), 2 of 62 findings cited text that was never in the transcript, despite every judge claiming to have grep-verified its quotes. Both scorers here now require a verbatim, character-for-character `quote` alongside the reason, and `scripts/verify_citations.py` mechanically checks it — whitespace-folded, literal-substring, case-sensitive — before anything is aggregated. An unverifiable quote is discarded, not down-scored, and the discarded count is surfaced in the report.
- **Machine-session exclusion.** The collector already drops sidechains (which covers subagents), but not a top-level session some other tool launched against this same agent — an audit harness, a judge, another skill — whose "user" turn is a programmatically built prompt. On this machine, a real scan found 686 of 688 candidate "user" turns were exactly that: a single template, repeated verbatim across hundreds of sessions. `scripts/detect_machine_sessions.py` flags sessions by shape (an oversized first turn, a prefix repeated across several distinct sessions, or this skill's own `<!-- doctor-md-skill:self-session -->` sentinel) — never by naming a specific tool — and `SKILL.md` drops them before scoring.
- **Explicit invocation only.** This skill runs only when the user names it directly. `SKILL.md`'s frontmatter sets `disable-model-invocation: true` so the harness itself will not invoke it on inferred intent, and both the description and a body section near the top of `SKILL.md` restate the same rule for an agent that already loaded the skill. A question that merely sounds related — "is my agent setup any good?", "why doesn't skill X ever fire?" — is a question to answer, not a trigger to run a full grading pass.

## Install

Symlink this directory into wherever your agent looks for skills, for example:

```bash
ln -s /path/to/doctor-md-skill ~/.agents/skills/doctor-md-skill
```

(or `~/.claude/skills/doctor-md-skill`, `~/.codex/skills/doctor-md-skill`, depending on the harness — see `references/supported-harnesses.md`).

## Run the tests

Stdlib `unittest` only, Python 3.9+, no network access required:

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```

## Licence

`scripts/collect_sessions.py` includes third-party code under the MIT licence; see `references/LICENSE-third-party.txt`.

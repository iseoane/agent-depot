# What counts as one rule

## The problem this solves

Instruction files have wildly different granularity. A global file can be prose contracts under nested headings, hundreds of lines deep; a project file is usually numbered lists and tables. A naive heading splitter emits one 400-line "rule" for a review lifecycle and fifteen 2-line rules for a lessons-learned list — and the token-cost ranking, which is the report's whole payload, ends up measuring the splitter instead of the file.

## The split

1. **Sections.** Cut on every ATX heading (`#`…`######`). A section is the heading plus the body up to the next heading of any level. Sections whose body is only whitespace are dropped; their heading survives as part of the child sections' heading path.
2. **List items.** Inside a section, if there are **2 or more** top-level list items (`-`, `*`, `+`, or `1.`, indented no more than 3 spaces), each item — with its indented continuation lines and nested sub-items — becomes its own rule. Prose before the first item becomes one more rule. The threshold exists to stop the splitter from atomising a single paragraph into fragments: a lone bullet under a heading is just a heading with one paragraph, not a list a reader would scan item by item, so it stays part of its section as one rule. Two clearly labelled bullets are not that case — each is already a distinct, independently gradable rule (a project file's "Otras reglas" section with exactly two unrelated bullets, one about learning from corrections and one about the package manager, is two rules, not one merged verdict covering both).
3. **Otherwise** the whole section body is one rule.

A fenced code block never starts a rule: list markers and `#` lines inside ``` fences are body text. Table rows are body text too; a Markdown table is part of whatever rule contains it.

## `<important if="condition">` containers

A block written as `<important if="…">` on its own line, closed by a `</important>` also on its own line, is a container -- not a rule of its own. The rules inside it split exactly the same way as any other section body (list-item splitting still applies), and each one carries `condition`: the block's condition text. A rule outside any block has `condition: null`.

The tags themselves are excluded from a rule's `text`, `chars` and `est_tokens`: they cost nothing to obey and must not inflate the rule's cost. They do count toward the file's own `chars`/`est_tokens`, since they really are injected into the prompt.

A tag is only recognized when it sits alone on its own line (up to 3 leading spaces, like a heading or list marker). An inline mention of the tag in prose -- this file's own examples, for instance -- is never treated as a real block boundary.

Nesting is rejected, not flattened: a second `<important if="…">` opened while already inside a block is a defect in the instruction file, not something the extractor silently resolves. Its content stays exactly where it is, as literal text under the *outer* condition, and a warning names the line. The same holds for a stray `</important>` with no matching open. Nothing is ever dropped: a rejected nested block still keeps every line of its text, just without its own (discarded) condition.

A block that is never closed reverts entirely: the opening tag itself becomes literal text, and every line from it through end of file loses its condition (`condition: null`), instead of silently wrapping the rest of the file -- potentially crossing headings and swallowing bare invariants -- under a condition nobody closed.

A file with no `<important if>` blocks at all extracts exactly as it did before this container existed, aside from the added `condition: null` key on every rule.

## Identity and cost

- `id` is `<file-label>#<start line>` — stable while the file does not move, and traceable back to the source by line.
- `section` is the full heading path (`Otras reglas › Lecciones Aprendidas`), so the rollup can group rules under the heading a human would recognize.
- `est_tokens` is `chars // 4`. A rough estimate is enough: the report ranks rules against each other, and every rule is measured the same way. Say it is an estimate in the report.

## Rollups

Report cost at two levels: per rule and per top-level section. A verdict belongs to a rule; a budget argument usually belongs to a section. "These 23 rules under *Review Execution Contract* are 31% of the global file and no sampled session could judge any of them" is an actionable finding. "Rule global#231 is 1.6k characters" is not.

## Granularity sanity check

After extraction, look at the counts before trusting anything downstream:

- A dense contract file should land in the **low hundreds** of rules. Under ten means the splitter collapsed it and the cost ranking is meaningless.
- A compact project file should land in the **dozens**.
- A single rule over ~2000 characters is a finding in its own right: too big to judge and too big to obey. Surface it rather than quietly scoring it.

## Which files get graded

Auto-discovery looks for the usual instruction files and lets the user add more:

- Global: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.agents/AGENTS.md`, `~/AGENTS.md`
- Project: `<repo>/CLAUDE.md`, `<repo>/AGENTS.md`, `<repo>/.claude/CLAUDE.md`, `<repo>/.github/copilot-instructions.md`

Files a project file merely *indexes* (a `rules/` directory, for instance) are not injected into every prompt, so they are not graded by default and must not be counted in the budget. Grade one only if the user names it with `--file`, and label it as a referenced file so its cost is reported separately from the always-injected total.

`--only` disables auto-discovery entirely, so the run extracts exactly the `--file` paths given and nothing else; it errors if given without `--file`, since without auto-discovery there would be nothing to grade. This is not a user-facing scope choice (Step 0 still asks that) — it exists so Step 5b can re-extract one proposed `RESTRUCTURED.md` on its own, without the repo's real instruction files leaking into the check.

# Job brief

## Identity and authorization
- Job: I0010/J001, r1. Source: operator 2026-10-29. Mode: bug-to-PR.
- Side effects: edit `tests/` (shared helpers allowed) and, only if a product defect is proven, `src/tui/`; local commits on `fix/54-tui-teardown-races`; no push.

## Objective
GitHub issue #54 (`gh issue view 54`). Background: #45 (merged) was caused by a test ending while Catalog still took `SourceStateStore` locks under the fixture state dir; teardown `rm` failed with ENOTEMPTY. Fixed for one test by waiting for Catalog to finish loading. Known latent case: `tests/tui-sources-recipes.test.tsx` "one cursor dispatches contextual actions…" (view `await reload()` after `Removed Git Source`, src/tui/sources-view.tsx ~:202). Also `src/tui/catalog-view.tsx` ~:118 stops reporting loading on a catalog error while the installed-skills scan may still lock.

## Skills and evidence (mandatory)
- Follow isswf-debug: `/home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-debug/SKILL.md`.
- Follow isswf-tdd: `/home/iseoane/.claude/plugins/cache/isswf/isswf/1.5.0/.agents/skills/isswf-tdd/SKILL.md`. For each fixed race, show RED first: a reproduction (e.g. 24-way parallel load, or an injected lock delay in dist) failing before the fix, then green after. Paste the commands and counts in the report.
- Comments: explain why, not what; match surrounding density.
- If you deviate from any skill, state it in the report under "Deviations" with the reason.

## Acceptance
1. Audit all `tests/tui-*.test.tsx` with `rm` teardown: table test → ends-while-busy? (yes/no/unknown) → evidence → fix.
2. Fix every confirmed case, preferring a shared "wait until settled" helper over per-test sleeps. No `rm` maxRetries masking.
3. Decide the catalog-view error-path `loading` gap: fix if it is a real product defect (user-visible?) or document why not.
4. Under 24-way parallel load, the affected test files show 0 ENOTEMPTY in ≥ 72 runs each (report counts before/after).
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; CI includes Windows now.

## Execution
Sonnet 5.5 / high. Commits `test: ...` / `fix(tui): ...`, no attribution lines of any kind. Report: `.isswf/initiatives/I0010/jobs/J001/A001.md` with sections Skills applied and evidence, Deviations, Audit table, Results.

## Scope addition (operator, 2026-10-29, mid-job)
Coordinator found a test-isolation leak: the operator's shell has `XDG_CACHE_HOME=~/.cache`, and `tests/isolated-env.ts` does not neutralize it, so tests using the default Git Source cache wrote fixture entries into the real `~/.cache/agent-depot/git-sources` (e.g. `https://example.test/packages/pstack.git` at 13:10 during your load runs). Not your fault; pre-existing on main.
- Fix in the preload: neutralize `XDG_CACHE_HOME` (and check `XDG_CONFIG_HOME`/`XDG_DATA_HOME` for any product default path that reads them), consistent with the existing `XDG_STATE_HOME` handling and comment.
- isswf-tdd: first a RED sentinel test (like tests/source-state-isolation.test.ts) proving that with a sentinel `XDG_CACHE_HOME` outside the sandbox the default Git cache path escapes; then green.
- Until fixed, run your load reproductions with `XDG_CACHE_HOME` pointed into a temp dir, and remove the temp dirs your runs leak in /tmp when done (only ones your runs created).
- Separate commit: `test: isolate XDG_CACHE_HOME in the test preload`.

# isSWF project setup

Host: Claude Code (Linux), host-native delegation. No legacy runtime, pin or factory store.

## Tracking

GitHub Issues in `iseoane/agent-depot`, using the labels in `docs/agents/triage-labels.md`.
Existing specs under `.scratch/` remain readable history.

## Claude Code model selection

Applied per delegation through the Agent tool's `model`/`effort` parameters
(the plugin role profiles ship `model: inherit`).

| Role | Model | Effort |
| --- | --- | --- |
| isswf-worker | sonnet (Sonnet 5.5) | high |
| isswf-reviewer | opus (Opus 5.5) | medium |
| isswf-researcher | haiku (Haiku 5.5) | high |
| isswf-planner | opus (Opus 5.5) | low |

## Delivery

- Default: feature branch → PR against `main` on `origin`; no direct push to `main`.
- Integration: low-risk PRs are merged into `main` by the coordinator without asking once independent review passes and CI is green on the exact head; medium or high risk waits for the operator. Use a merge commit (`gh pr merge --merge`), never squash or rebase. No auto-merge.
- Cleanup after merge: delete the merged branch on `origin` and locally, and remove its worktree if any. Before deleting, confirm the PR is MERGED and the branch content is in `main` (`git cherry`/`--merged`).
- Correction budget: at most 2 correction cycles per feature.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`; CI `.github/workflows/ci.yml` on the PR head.

## Worktrees

Only for parallel writers or on explicit request. Root configured locally in
`git config --local isswf.worktreeRoot` (sibling of the project, one directory per feature).
Do not use Claude Code's automatic `.claude/worktrees/` isolation for isSWF assignments.

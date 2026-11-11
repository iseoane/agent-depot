# isSWF project setup

Host: Claude Code 2.1.319 (Windows 11), host-native delegation; plugin isswf 1.8.2. No legacy runtime, pin or factory store.

## Tracking

GitHub Issues in `iseoane/agent-depot`, using the labels in `docs/agents/triage-labels.md`.
Existing specs under `.scratch/` remain readable history.

## Claude Code model selection

Applied per delegation through the Agent tool's `model`/`effort` parameters
(the plugin role profiles ship `model: inherit`).

| Role | Model | Effort |
| --- | --- | --- |
| isswf-worker | sonnet (Sonnet 5.5) | medium |
| isswf-reviewer | opus (Opus 5.5) | medium |
| isswf-researcher | haiku (Haiku 5.5) | high |
| isswf-planner | opus (Opus 5.5) | low |

## Delivery

- Default: feature branch → PR against `main` on `origin`; no direct push to `main`.
- Integration: low-risk PRs are merged into `main` by the coordinator without asking once independent review passes and CI is green on the exact head; medium or high risk waits for the operator. Use a merge commit (`gh pr merge --merge`), never squash or rebase. No auto-merge.
- Cleanup after merge: delete the merged branch on `origin` and locally, and remove its worktree if any. Before deleting, confirm the PR is MERGED and the branch content is in `main` (`git cherry`/`--merged`).
- Review budget: up to 3 review rounds per functional unit with up to 2 correction cycles (ceiling, not mandatory rounds); beyond that, stop for an explicit extension.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`; CI `.github/workflows/ci.yml` on the PR head.

## Worktrees

Only for parallel writers or on explicit request. Root configured locally in
`git config --local isswf.worktreeRoot` (sibling of the project, one directory per feature).
Do not use Claude Code's automatic `.claude/worktrees/` isolation for isSWF assignments.

Model selection follows the isSWF portable preset (approved 2026-11-05 with 1.7.0; unchanged in 1.8.0 and 1.8.2);
the coordinator runs on the session model (`opus`).

## Parallel writers

Unverified: the Agent tool cannot bind a child to a specific prepared external
checkout. Sequential work in the assigned checkout is ready; assignments that
explicitly require parallel writers are blocked until binding is verified.

## Native usage capture

Disabled (no `.isswf/claude-native-usage.json`). Use
`tools/token-native-claude-transcript.mjs` for on-demand usage from local transcripts.

## Job sizing

Decided by the operator on 2026-11-11 after I0031 and I0032 J001 grew too large to review in one pass.

Before dispatching a writer, the planner (or the coordinator when there is no planner) classifies each job by its verification cost, never by a line count:

1. How many distinct user-visible flows or screens must the reviewer check?
2. Does it carry a concurrency, timing or security risk?
3. Can an independent reviewer read the whole change in one pass?
4. Would the worker have to improvise design decisions?

| Size | When |
| --- | --- |
| S | One flow, no special risk, fits in one review pass |
| M | Two or three related flows, or one well-bounded special risk |
| L | Anything else |

- S and M are dispatched as they are. An L job is split into functional parts that are each useful on their own (never into technical layers), or the brief records why it cannot be split.
- Record the size and its one-line reason in the brief. When in doubt between two sizes, choose the smaller and proceed; there is no numeric threshold.
- If a job needs more than one correction round, or the reviewer leaves parts uninspected, record it as a sizing miss in the plan's evidence.

# App installs can sit at a stale version while the update check says up to date

Status: needs-triage

Labels: `needs-triage`

Reported: 2026-10-06, Engram App, worktree `c7479c9` (reporter's own machine).

## Symptom

The Installations row showed `engram 3.0.0` while the installed binary was 3.1.0. The row only
revealed 3.1.0 after the cursor landed on it. Before the manual update, the Updates list offered
nothing while release 3.1.0 existed, and it showed only `1 up to date`.

## Reproduction

Deterministic, offline, no real state or Homebrew touched.

```
pnpm build && node --test --import ./dist/tests/isolated-env.js dist/tests/engram-app-version-repro.js
```

3 pass, 2 fail, identical frames across three runs. The two failing tests state the behavior the
reporter expected. Full transcripts in `.scratch/engram-app-version/repro-run-{1,2,3}.txt`.

Real-state confirmation, read-only, Homebrew on PATH.

```
agent-depot app list
engram	installed	3.1.0	/home/linuxbrew/.linuxbrew/bin/engram	latest: 3.1.0	current
```

The tracked record still says `3.0.0`.

## Root causes

Full evidence and ranked hypotheses in `diagnosis.md`.

1. The Installations row renders the tracked record in the same slot as a live reading, so a
   record and a verified value look identical. `AppInspection` cannot express which one it
   holds (`src/app-flow.ts:224-231`, `src/tui/installations-tree.ts:96`). The spec already
   decided the distinction matters (`.scratch/apps/spec.md:246`).
2. The reporter's recipe takes its latest signal from `brew info`, which reads the local tap
   clone. Homebrew does not refresh the tap for `info`
   (`utils/auto-update.sh:144-152`), so the check compared 3.0.0 against a cached 3.0.0 until
   the manual `brew upgrade` refreshed the tap on 2026-10-06 08:54. The release had existed
   upstream since 2026-10-05 19:47.

## Fix routing

Fix 1 is a change to the reporter's own recipe, not to this repository, and it removes the
symptom the report is about. Fix 2 is in-repo guidance that currently cannot be followed,
because the recipe schema has no freshness field. Fix 3 is a product change that makes a
recorded version legible as recorded. The reporter should pick the route before an agent
starts, since fixes 1 and 2 together make the update check correct while only fix 3 changes
what the Installations row says.

## Regression tests

- Installations provenance, `tests/tui-apps.test.tsx`, extending the lazy-version-check test.
- Update-check freshness, `tests/app-updates.test.ts`, plus the recipe authoring guidance.
- Keep the harness assertion that a read-only check runs only the recipe's `version` and
  `latest` commands.

## Comments

Implementation is held open. A separate worker owns `src/tui` and the Package Catalog paths
until integration, so no product fix was written here.

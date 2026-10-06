# 13: Reconcile a tracked App version after a live probe

**What to build:** When an authorized live `version` probe verifies a version ahead of the
tracked record for the same recipe file, rewrite that record so a reload shows the version the
App actually reports. Show the cached tracked value as recorded until the probe replaces it.

**Blocked by:** 06, 07.

**Status:** implemented

- [x] A pre-focus App row reads `3.0.0 (recorded)`; a live probe reads the verified version.
- [x] A live probe reconciles only an already-tracked App whose record names the same recipe file.
- [x] An untracked App, an equal or older version, and a failed or unknown probe write nothing.
- [x] TUI start-up still runs no recipe commands.

## Root cause

Reported and reproduced in `.scratch/engram-app-version/`. The Installations row rendered the
tracked record in the same slot as a live reading, so `AppInspection` could not express which one
it held, and nothing rewrote the record when a live probe found a newer binary. The row was
therefore wrong again after every reload. `.scratch/apps/spec.md` (ticket 06) already decided that
cached tracking is not fresh version evidence. The ranked hypotheses and the Homebrew evidence are
in `diagnosis.md`.

The update-check half of the report, `1 up to date` while release 3.1.0 existed, has no product
cause. The reporter's recipe took `latest` from `brew info`, which reads the local tap clone, and
Homebrew never auto-updates for `info`. That is repaired in the recipe and in the
recipe-authoring guidance, without a recipe-schema change.

## Implementation

- `AppInspection` carries `evidence: "recorded" | "verified"` on an installed result.
- `src/app-flow.ts` reconciles the tracked record after a live probe that verifies a strictly
  newer version, and only for a record whose `recipeFile` matches `entry.canonicalFile`.
  Untracked, equal, older and non-comparable versions, and failed probes, write nothing.
- `src/tui/installations-tree.ts` renders a recorded value as `3.0.0 (recorded)`.

## Recipe repair (user-owned, not executed here)

Set the Engram recipe's `latest` to `{"github": "Gentleman-Programming/engram"}` and re-approve it
with `agent-depot app approve engram --yes`. Read-only probe on 2026-10-06:
`/releases/latest` reports `v3.1.0`, not a prerelease, published `2026-10-05T17:47:32Z`. `brew
install` and `brew upgrade` refresh the tap themselves, so install and update stay reliable. The
repository does not change the reporter's recipe; it stays their file.

## Regression tests

- `tests/tui-apps.test.tsx`: focus records the live version, the cached row says recorded, and a
  reload reads the reconciled record.
- `tests/app-updates.test.ts`: an update check reconciles a version that moved outside Agent Depot.
- `tests/app-flow.test.ts`: reconcile only for an already-tracked matching record, and no write on
  the untracked, mismatched, equal, older, failed and cached paths.
- `tests/engram-app-version-repro.tsx` stays the issue's harness. After the fix it is 4 pass,
  1 fail; the remaining failure is the upstream-truth expectation that only the recipe repair
  clears.

## Comments

### Evidence and verification

- Harness before the fix: 3 pass, 2 fail (`.scratch/engram-app-version/repro-run-{1,2,3}.txt`).
- Harness after the fix: 4 pass, 1 fail
  (`.scratch/engram-app-version/repro-run-after-fix.txt`); the surviving failure is the
  lagging-tap latest expectation, which the recipe repair owns.
- `pnpm test` passes 953/953. `pnpm typecheck`, `pnpm lint` and
  `pnpm audit:dead-code` pass.

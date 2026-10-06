# Engram App version surfaces and the missed 3.1.0 update

Read-only investigation of worktree `c7479c9` against the reporter's own state under
`~/.local/state/agent-depot`. No source file in `src/` was changed. Nothing was installed,
updated, or deleted.

Repro harness and its three recorded runs:

- `tests/engram-app-version-repro.tsx`
- `.scratch/engram-app-version/repro-run-1.txt`, `repro-run-2.txt`, `repro-run-3.txt`

## Overview

An App has three version numbers, and Agent Depot reads them from three different places.
The Installations row reads the tracked record. The Updates check reads the installed binary
and the recipe's `latest` command. The reporter saw the row disagree with the binary, and saw
the Updates list offer nothing while release 3.1.0 existed.

Both symptoms reproduce deterministically. They have different root causes, and only one of
them is a defect in Agent Depot code.

## Key concepts

**Tracked version.** Written to `app-installations/<sha256(name)>.json` by a successful install
or update, from the recipe's `version` command (`src/app-flow.ts:367-395`, `recordOutcome`).
It is a record of the last verified install, not a live reading.

**Live version.** What the installed executable reports right now, read by running
`version.argv`.

**Latest version.** What the recipe's `latest` declares, read either from a public registry
over HTTP or by running `latest.argv` (`src/app-flow.ts:249-279`).

An App updated outside Agent Depot keeps its old tracked version. That is by design, since
Agent Depot does not watch the filesystem for App changes.

## What the three numbers were

| Reading | Value | Source |
| --- | --- | --- |
| Tracked | `3.0.0` | `app-installations/450dcf23….json`, written 2026-10-05 15:17 |
| Live | `3.0.0` until 2026-10-06 08:54, `3.1.0` after | `engram version`; `/home/linuxbrew/.linuxbrew/bin/engram -> ../Cellar/engram/3.1.0/bin/engram` |
| Latest, upstream truth | `3.1.0` from 2026-10-05 19:47 | the engram formula commit `cece367` in the `gentleman-programming/tap` clone |
| Latest, as the update check read it | `3.0.0` until 2026-10-06 08:54 | `brew info` against the local tap clone at `40bf37d` |

`agent-depot app list` on the real state today, with Homebrew on PATH:

```
engram	installed	3.1.0	/home/linuxbrew/.linuxbrew/bin/engram	latest: 3.1.0	current
```

The tracked record on disk still says `3.0.0`. The CLI reads live, the TUI Installations row
reads the record, and that is symptom one.

## How it works

**Installations row.** `loadInstallations` reads the tracked records and passes the matching
record's version into `inspect` as a cache (`src/tui/installations.ts:163-171`). `inspect`
returns that value as the installed version without resolving or running anything
(`src/app-flow.ts:224-231`). `describeNode` renders it beside the App name
(`src/tui/installations-tree.ts:96`). Focusing the row runs a live `inspect` and replaces the
row in place, once per recipe file and content hash (`src/tui/installations-view.tsx:84-107`).

**Updates row.** `loadUpdateRows` calls `checkAppUpdates`, which runs a live `inspect` for
every applicable recipe and then the `latest` step (`src/tui/updates.ts:239-256`,
`src/app-flow.ts:249-279`, `src/app-flow.ts:504`). The row shows the live installed version.
A row whose status is `current` is not listed at all, it only counts toward `N up to date`
(`src/tui/updates-model.ts:37-47`). So an App that Agent Depot believes is current is invisible
in that view, which is what "Updates did not offer 3.1.0" looks like on screen.

**Why the Updates verdict was wrong.** The recipe's latest step is
`brew info --formula --json=v2 gentleman-programming/tap/engram`, and its pattern reads
`versions.stable` (`~/.local/state/agent-depot/apps/engram-linux.json`). Homebrew's local tap
clone is the only thing that command reads. Homebrew refreshes the tap through auto-update
before `install`, `outdated`, `upgrade`, `bundle`, `release`, and `tap <name>`
(`/home/linuxbrew/.linuxbrew/Homebrew/Library/Homebrew/utils/auto-update.sh:144-152`).
`info` is not in that list, so `brew info` never refreshes it. Confirmed on this machine, the
`brew info` run left `Homebrew/.git/FETCH_HEAD` at its 2026-10-06 08:54 mtime and added no
reflog entry.

The user's update command, `brew upgrade --formula --yes gentleman-programming/tap/engram`,
is in that auto-update list, and its tap-qualified argument puts the refresh window at five
minutes (`auto-update.sh:38-50`, `:72-79`). That is why the manual update found 3.1.0 while the check
could not.

The local tap clone timeline closes the case.

```
40bf37d  2026-10-02  update engram formula to v3.0.0     (version "3.0.0")
cece367  2026-10-05  update engram formula to v3.1.0     (version "3.1.0")

local tap reflog
  2026-10-05 15:00:08  clone from github.com/gentleman-programming/homebrew-tap   -> 40bf37d
  2026-10-06 08:54:43  rebase (finish): returning to refs/heads/main             -> cece367
```

From 2026-10-05 15:00 until 2026-10-06 08:54 the local tap said 3.0.0, while upstream said
3.1.0 from 2026-10-05 19:47. Every update check in that window compared live 3.0.0 against
cached 3.0.0 and concluded "up to date".

## Where things live

App core and its state: `src/app-flow.ts`, `src/app-version.ts`, `src/app-latest.ts`, state
under `<state>/apps`, `<state>/app-installations`, `<state>/app-approvals`,
`<state>/app-pending-updates`.

TUI surfaces: `src/tui/installations.ts`, `src/tui/installations-tree.ts`,
`src/tui/installations-view.tsx`, `src/tui/updates.ts`, `src/tui/updates-model.ts`,
`src/tui/updates-panel.tsx`.

Recipe authoring guidance: `skills/agent-depot-apprecipe/SKILL.md`, installed copy at
`~/.agents/skills/agent-depot-apprecipe/SKILL.md` and byte-identical to the repo at `c7479c9`.

Decisions: `docs/adr/0007-delegate-app-lifecycle-to-user-recipes.md`,
`.scratch/apps/spec.md` (ticket 05 for latest lookups, ticket 06 for TUI Installations,
ticket 07 for TUI Updates).

## Reproduce

```
pnpm build && node --test --import ./dist/tests/isolated-env.js dist/tests/engram-app-version-repro.js
```

Five tests, three pass and two fail, identical verdicts and identical captured frames across
three consecutive runs. The fixture injects the runner and never touches the real state
directory, the real `brew`, or the network.

Green tests capture the observed behavior.

- `repro: Installations shows the recorded 3.0.0 and only reveals live 3.1.0 when the row is highlighted`
  records the exact row: `[ ] engram  3.0.0` with zero commands run, then `engram 3.1.0` after
  the highlight, with command log `["version"]`.
- `repro: the update check offers nothing while the local tap says 3.0.0, and offers 3.1.0 once the tap is refreshed`
  records `1 up to date` with no `App: engram` row for the first frame, then `App: engram …
  3.0.0 -> 3.1.0` after only the tap value changes. Nothing else differs between the two runs.
- `facts the diagnosis rests on…` asserts `compareAppVersions("3.0.0", "3.1.0") === -1` and
  records the exact command log of one update check, `["version", "info --formula --json=v2
  gentleman-programming/tap/engram"]`, with no `brew update` and no `upgrade`.

Red tests state the expectation the user had.

- `red: the Installations row must not present unverified recorded evidence as the installed version`
  fails on the frame `[ ] engram  3.0.0`. `.scratch/apps/spec.md:246` already decided that
  cached tracking is not fresh version evidence, and the row cannot express the difference.
- `red: an update check must not report up to date while the App's release channel names a newer version`
  fails on the frame `1 up to date`. The check has no source of upstream truth, because the
  recipe's `latest` is its only input and this recipe's input is a cache.

## Ranked hypotheses

H1, surviving. The recipe's latest step reads a lagging local tap clone, and Homebrew never
refreshes the tap for `info`. Prediction, injecting tap 3.0.0 then tap 3.1.0 with the live
version unchanged flips `current` to `update available`. Confirmed by the second green test.
Falsifier, the tap already held 3.1.0 before the check. The tap reflog and commit dates say
otherwise.

H2, refuted. `brew` was unresolvable from the TUI process, so latest was `unknown` and the App
sat in the "cannot be checked" fold. `brew` and `engram` resolve from the same directory,
`brew install` ran successfully at 2026-10-05 15:17 and produced the tracked record (which
itself requires `engram` to have resolved and run), and `app list` resolves both today.

H3, refuted as load-bearing. The tracked 3.0.0 could have come from the earlier
`~/.local/bin/engram` install rather than the Homebrew one. Both channels held 3.0.0 at
2026-10-05 15:17, so the value is right either way and this changes nothing.

H4, refuted. Approval drift made the App unassessable. The receipt
`app-approvals/214abb40….json` holds `727612df…`, which equals the sha256 of the current
`engram-linux.json`, and the receipt file name equals the sha256 of that recipe's canonical
path. The author's rewrite of the recipe happened before the install and the approval.

H5, refuted. The comparator treats 3.0.0 as current against 3.1.0. Asserted false in the
harness, and the second green test shows the update is offered once latest is 3.1.0.

H6, refuted. The whole Updates check failed, so nothing was offered. App assessment is
independent of Skill scope failure by construction (`src/app-flow.ts:504`), and today the same
App assesses as `current` with both versions resolved.

## Surviving causes

**Cause 1, Installations shows a record as if it were a reading.** `AppInspection` has one
shape for a value read from the record and a value read from the executable, so the renderer
cannot tell them apart and the user cannot either. This is the spec's own distinction, missing
from the type. The load-time cache is deliberate, since the suite asserts that startup runs no
recipe commands, so the gap is what the row says, not when it checks.

**Cause 2, the recipe's latest signal is a lagging cache and nothing says so.** The 15:13
revision of the recipe replaced `"latest": {"github": "Gentleman-Programming/engram"}` (still
visible in `engram-linux.json.20261005145241.bak`) with the `brew info` argv. The authoring
skill at `skills/agent-depot-apprecipe/SKILL.md:45` asks the author to disclose freshness
limits, but the recipe schema has no field for that and no Agent Depot surface shows it. So
the instruction cannot be followed, and the update check has no way to know its latest came
from a cache.

## Proposed fixes, smallest first

1. Recipe, user-owned, immediate. Set `latest` back to
   `{"github": "Gentleman-Programming/engram"}` and approve the recipe again. The formula
   points at GitHub release assets, so `/releases/latest` is the authoritative signal and it
   excludes prereleases. Install and upgrade stay reliable because `brew install` and
   `brew upgrade` refresh the tap themselves.
2. Skill guidance, in-repo. Make `skills/agent-depot-apprecipe/SKILL.md:45` concrete for
   Homebrew: `brew info` reads the local tap clone, Homebrew does not auto-update for `info`,
   so do not use it as the latest signal when the tap mirrors a GitHub release. Either that,
   or drop the "disclose freshness limits" instruction, which nothing can currently satisfy.
3. Product, only if the record-versus-reading ambiguity should be visible in general. Give the
   cached inspection a distinct shape, for example an evidence discriminant on the installed
   variant, and render the record as recorded. This is the fix that makes the reporter's first
   observation self-explanatory instead of surprising.

## Regression tests to add with the fix

- Provenance, `tests/tui-apps.test.tsx`, extending "approved Apps stay cached at startup and
  version checks are lazy on focus". The pre-focus row must be distinguishable from the
  post-focus row. That is exactly the first red test.
- Freshness, `tests/app-updates.test.ts` plus a case in the recipe skill's own checks. A
  recipe whose `latest` is a channel cache must not be presented as an update verdict. That is
  the second red test, and it stays red until fix 1 or fix 3 is chosen, because the current
  check has no upstream truth to compare against.
- Keep the harness assertion that an update check runs only the recipe's `version` and `latest`
  commands. A fix that starts mutating channel metadata during a read-only check should fail.

## Gotchas

- `brew info` is read-only but not fresh. Homebrew's auto-update command list,
  `auto-update.sh:144-152`, is the authority on which brew commands refresh anything.
- The tracked record is only rewritten by a successful install or update through Agent Depot,
  so any App updated by hand keeps a stale record until the next Agent Depot update of that App.
- `inspect` with a cache returns `installed` whenever a record exists, without running the
  version command. A record left behind by an App that was later removed by hand reads as
  installed until the row is focused.
- The Updates view hides `current` rows entirely, so a wrong `current` verdict is silent. It
  appears only as a count of "up to date".

## Open questions

The exact minute of the reporter's update check is not recorded anywhere. Every possible check
time from 2026-10-05 15:17 to 2026-10-06 08:54 yields the same verdict, so the conclusion holds
without it. A check after 08:54 would have found live 3.1.0 and correctly reported current, and
in that reading only the stale row is a defect. That reading contradicts the report's stated
order, that the manual update came after the failed offer, so it is treated as unlikely here.
Label it inferred.

Whether `engram` resolved to the Homebrew shim or the old `~/.local/bin` binary at install time
is not recoverable from the record. Both were 3.0.0, and the question does not affect either
cause.

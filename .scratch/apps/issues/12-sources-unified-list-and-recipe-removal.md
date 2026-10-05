# 12: Sources unified list, App recipe removal, labelled Source groups

**What to build:** One windowed Sources list holding Skill Sources and App recipes with a single cursor and a KIND column; an explicit App recipe removal flow; repository-name labels for Catalog Source groups; groups collapsed by default; actionable App lifecycle failures; GitHub `tree/<ref>/<directory>` Source URLs; and a Catalog that stays usable when one Source cannot be read.

**Blocked by:** none. Builds on ticket 11.

**Status:** completed

- [x] Sources shows Skill Sources and App recipes in one windowed list with `skills`/`app` kinds, one cursor and contextual action hints; Tab section switching is removed. Adding a first App recipe is available through `n`, which opens the add menu on a Skill Source row and the add guide on a recipe row; marks apply to Skill Sources only, and Enter opens a Skill Source's Catalog or previews/approves a recipe.
- [x] App recipe removal previews the exact recipe path, checks approved App state, offers the existing uninstall flow for installed or tracked Apps, and requires a separate deletion confirmation. Declining or failing uninstall retains the recipe; a recipe whose version command cannot run is not removable, because installed state is then unverified.
- [x] Catalog Source groups show repository names, with GitHub directory/ref scope, instead of opaque Git IDs; internal Source identities are unchanged.
- [x] Catalog and Installations start with every group collapsed. Enter and the right arrow open groups; Catalog filters still expand matching Sources automatically.
- [x] App lifecycle failures identify the missing executable and action, suggest installing Homebrew when `brew` is unavailable, and distinguish manual-only steps and blocked Windows executables. TUI previews name missing commands instead of only "unavailable".
- [x] GitHub `tree/<ref>/<directory>` Source URLs clone and fetch the repository URL, use the selected ref, and restrict Skill discovery and reads to the directory without changing existing Source identities. Git transport, Skill discovery and the Catalog group label read one parse of that shape.
- [x] The TUI Catalog keeps available Sources browsable when another Source has no mirror or cannot be read, and shows an individual warning naming the Source with refresh guidance instead of failing the whole view.

## Comments

Implemented as an uncommitted working tree on `main`, then committed on
`feat/sources-unified-list` after review. The review ran two axes over the whole
working tree against `67a2964`: a Standards pass (documented standards plus the
Fowler smell baseline) and a Spec pass against the `[Unreleased]` CHANGELOG
bullets and ADR 0007.

Verification: `tsc --noEmit`, `eslint`, and `tsc` build clean; unit tests 747
passed / 0 failed; end-to-end 4 passed / 0 failed. The same harness on a clean
`67a2964` worktree ran 721 unit tests with 1 failure and 4 e2e with 1 failure, so
these changes leave the suite strictly greener than the commit they start from.

The two unit failures that the unified list introduced came from one cause:
`tests/isolated-env.ts` deleted `XDG_STATE_HOME` and left `HOME` pointing at the
developer's real home, so every TUI test that rendered Sources read the
developer's real App recipes and counted their rows. It now pins `HOME`,
`USERPROFILE`, `APPDATA` and `LOCALAPPDATA` to a fresh directory and still
deletes `XDG_STATE_HOME`, so no test process reads or writes real Agent Depot
state.

Review corrections applied: the removal flow fails closed when the version
command cannot run; recipe identity is compared field by field instead of through
`JSON.stringify`; the Catalog's per-Source warning names the Source instead of
its opaque Git ID; the GitHub directory URL shape is parsed once for Git
transport, Skill discovery and the group label; and the dead `sources` branch of
the App footer hints is gone, with the hint strings owned by one exported
function. `SPEC.md`, `DESIGN.md` and `.scratch/apps/spec.md` were updated where
they still asserted the pre-change behaviour, and ADR 0007 records the
fail-closed rule.

Findings recorded but not fixed, each judged out of scope for this change:
`render-expanded.ts` walks rendered glyphs to open the first group, which couples
unrelated action tests to display strings across roughly ten test files;
`sources-recipes.tsx` `handleKey` is a long `kind` cascade that a handler table
could reduce, as `sources-mode.ts` already does; and `app-flow.ts`
`missingExecutableReason` hardcodes Homebrew guidance inside a
package-manager-agnostic module. The CLI also builds its App-owned Skill filter
from the ambient state directory in the install path (`src/skill-install.ts`
through the install context) and in `update check`'s unmanaged inventory, so an
embedder that injects `appOperations` with a different recipes directory still
sees the ambient one in those paths. In production both resolve identically, so
this is a testability seam rather than a user-visible defect.

`skills/agent-depot-apprecipe/SKILL.md` grew an Installer Preflight and a
Homebrew checklist (version 1.1) that no CHANGELOG bullet requested, which is
scope the review could not tie to a requirement. The Spec pass also reported the
skill's "Homebrew 7.0.8" example as a fabricated version, on the grounds that
Homebrew is at 4.x. That finding is rejected: the session date is 2026-10-05, so
the reviewer was applying pre-2026 knowledge, and the skill already frames the
line as version-specific evidence and tells the reader to recheck their installed
version. No brew exists on this machine, so the number itself stays unverified
here and is a guess until someone checks a real install.

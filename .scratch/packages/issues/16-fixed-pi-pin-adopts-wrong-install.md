# 16: Fixed Pi pins can adopt a different installed pin

**What is wrong:** `package-flow.ts` treats any Pi install with the same source identity as satisfying an `install` plan. A fixed selection such as `git:github.com/example/demo-bundle@aaaaaaaa...` can therefore skip execution when host state reports `git:github.com/example/demo-bundle@bbbbbbbb...`.

**User impact:** Agent Depot can record a fixed Package selection without installing the requested pin. The record then claims the desired selection while the host runs different package content.

**What ships now:** `actionSatisfied` consults a fixed-pin verdict before an install skips, and `recordOutcome` fails an install or update whose observed evidence contradicts a fixed Pi pin without writing the selection. The verdict has four states: `not-pinned`, `satisfied`, `contradicted`, `unverifiable`. Two hexadecimal refs must match (case-insensitive, trimmed); a version pin compares through `sameAppVersion`. Evidence that cannot express the pin is `unverifiable`: it never satisfies a skip, and it is not reported as a contradiction, because the host state boundary exposes a commit but not an arbitrary pin such as a tag.

**Status:** completed

- [x] `install` skip logic checks fixed Pi evidence before treating host state as already satisfied.
- [x] `executeLifecycle` fails if the final observed host evidence contradicts the fixed Pi pin.
- [x] A regression test proves a wrong installed pin does not skip and that the pinned install argv runs.

## Verification

- `tests/package-flow.test.ts`: `a fixed Pi pin does not adopt a different installed pin`.
- `tests/package-flow.test.ts`: `a fixed Pi pin whose install leaves a different pin fails and writes no record`.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-flow.test.ts.

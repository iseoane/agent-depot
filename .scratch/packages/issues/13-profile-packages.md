# 13: Package selections in the portable Profile

**What to build:** Carry Package selections in `agent-depot-profile/v1` as an
additive `packages` array, per section 5 of `.scratch/packages/design.md`.

- Export writes the selection source, coordinates, and version policy. It never
  writes a receipt and never writes installed evidence.
- Import replays the selection through the flow's `select` action, which runs no
  host command and installs nothing.
- Reuse the existing portability rules, including the no-installation-evidence
  rule.
- An older profile with no `packages` key still parses.
- `--package <selection>` and `--no-packages` filters follow the Source and Skill
  filter conventions.

**Blocked by:** 07, 08.

**Status:** completed

- [x] A round trip restores the selection and never installs a bundle.
- [x] Export contains no receipt and no installed state.
- [x] A profile with no `packages` key parses unchanged.
- [x] Import conflicts are skipped, matching the existing add-only rule.
- [x] The receipt digest is not part of the profile and does not travel.

## Verification

- Extensions to `tests/profile.test.ts`, `tests/profile-import.test.ts`, and `tests/e2e-profile.test.ts`.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/profile.test.ts, tests/profile-import.test.ts, and tests/e2e-profile.test.ts.

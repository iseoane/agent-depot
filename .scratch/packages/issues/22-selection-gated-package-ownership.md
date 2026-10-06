# 22: Selection-gated Package ownership and the portable-duplicate refusal

**What is wrong:** The owned-Skill guard claimed a Skill from every discovered
descriptor, whether or not the user selected the bundle and whether or not it was
installable. `mattpocock/skills` is an ordinary skill repository that also
declares a Claude plugin, so its `tdd` and `teach` skills were dimmed and refused
as portable installs with no bundle chosen. The reverse direction had no rule at
all: nothing stopped a user from selecting a Package and then installing the same
Skill as a portable copy, or the other way around.

**What ships now:** A discovered bundle owns its declared Skills only while it is
**active**. It is active when the user selected it (a record in `packages.json`),
or when a host state file proves it installed, with Source, host, and coordinates
agreeing. An
unselected and absent bundle, an unrelated Source or host, a noninstallable
descriptor, and an unreadable host state own nothing, so their Skills stay
portable. `BundleDescriptor.installable` is now a typed field rather than text
parsed out of a warning. Selecting or installing a Package that would duplicate a
managed portable user-global Skill fails with an actionable conflict naming the
portable paths; nothing is uninstalled, replaced, or copied.

**Status:** completed

- [x] An unselected and absent bundle owns nothing; its Skills install as loose Skills.
- [x] A selected bundle owns its Skills, matched by Source, host, and coordinates.
- [x] A host-proven install owns its Skills with no selection record, including a hand-installed one.
- [x] An unrelated Source or host, and an unreadable host state file, never claim an install.
- [x] A noninstallable descriptor never owns its Skills, even when a selection names it.
- [x] The guard, the unmanaged inventory, the CLI install and uninstall paths, and the Catalog consume one classifier.
- [x] The classifier reuses the descriptors from the snapshot pass the guard already reads.
- [x] Selecting or installing a Package with an overlapping portable installation refuses before any change.
- [x] The Catalog dims a Skill only when its Package is active.
- [x] ADR 0009 records the amendment; CONTEXT.md, DESIGN.md, and both readmes agree.

## Verification

- `tests/package-ownership.test.ts` covers the gating matrix, including the Matt
  `tdd` Skill and the native pstack Pi selection.
- `tests/package-owned-skills.test.ts` covers the call sites: the inventory, the
  removal paths, the CLI install and uninstall, and the recheck after preview.
- `tests/package-flow.test.ts` covers the portable-duplicate refusal and the
  unrelated-Source control.
- `tests/tui-catalog-labels.test.ts` covers the Catalog owner.
- `pnpm typecheck`, `pnpm lint`, `pnpm audit:dead-code`, `pnpm test` (971 tests),
  and `git diff --check` are clean.

## Limitations

- A corrupt `sources.json` makes the duplicate check fail closed: the Package
  lifecycle refuses rather than risk a duplicate. A corrupt `packages.json` makes
  the guard fail open, matching the existing "an unresolvable input never hides a
  Skill" stance, but Package operations already refuse on corrupt state.
- A bundle whose manifest gains a Skill after the user selected it is not
  re-checked against portable installations; the conflict is evaluated when the
  Package lifecycle is planned.
- The conflict matches by Source and Skill path or name, not by content. An
  identical portable copy from the same Source is still a conflict.

## Comments

- 2026-10-06 (feature, base bbd3504): completed. Evidence:
  `tests/package-ownership.test.ts`, `tests/package-owned-skills.test.ts`,
  `tests/package-flow.test.ts`, `tests/tui-catalog-labels.test.ts`.

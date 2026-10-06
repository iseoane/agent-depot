# 09: package-owned-skills.ts guard and its two call sites

**What to build:** The choke point that stops a bundle's own skills from becoming
a second managed copy, per section 4.5 of `.scratch/packages/design.md`.

- `bundleOwnedSkillMatcher(descriptors)`, built from the same snapshot pass that
  feeds skill discovery, so there is no second walk and no hand-synced list.
- `assertSkillNotPackageOwned(skillPath, owned)`, which throws naming the Package
  and the host.
- Call it beside `assertSkillNotAppOwned` in `src/skill-install.ts` and
  `src/user-global-skill-inventory.ts`, at every unmanaged mutation path.
- An unresolvable Source snapshot means no exclusions rather than a hidden skill.

**Blocked by:** 03.

**Status:** completed

- [x] Installing a bundle-owned skill path throws with a Package pointer.
- [x] A loose skill in the same Source still installs.
- [x] Every unmanaged adopt, remove, and inventory path is guarded, verified by enumerating the call sites.
- [x] A Source that cannot be read produces no exclusions and does not hide skills.
- [x] The matcher is derived from discovery output, not from a second list.

## Verification

- `tests/package-owned-skills.test.ts`, mirroring the `app-owned-skills` tests.
- `pnpm typecheck` for the call-site wiring.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-owned-skills.test.ts.

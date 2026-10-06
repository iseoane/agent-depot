# 02: package-model.ts domain types and pure helpers

**What to build:** The type contract every other Package module consumes, per
section 3 of `.scratch/packages/design.md`. `src/package-model.ts` imports
`project-manifest.ts` only.

- `PACKAGE_HOSTS` with the `satisfies readonly ProjectHost[]` check, and
  `PackageHost`.
- `PackageCoordinates`, the union discriminated on host. A Claude selection
  carries `marketplaceRoot` and `pluginName` together.
- `PackageSelection`, `PackageAction`, and the modeled-and-deferred
  `PackageSourceKind`.
- `PackageComponentKind`, `PackageComponentOwnership`, `PackageComponentEffect`,
  `PackageComponent`, and `DEFERRED_COMPONENT_KINDS` as the single deferred list.
- `BundleDescriptor`, `PackageVersionEvidence`, `InstalledBundleEvidence`,
  `InstalledPackage`, `PersistedPackageState`.
- `PackageInspection`, `PackageCommand`, `PackagePlanOrigin`,
  `PackageLifecyclePlan`, `PackageLifecycleResult`, `PackageUpdateCheck`,
  `PackageDeclaration`, `HostInstallSpec`.
- Pure helpers: `bundleRoot`, `describeCoordinates`, `selectionKey`.

**Blocked by:** None. Can start immediately.

**Status:** completed

- [x] The types match section 3 of the design, including the discriminated unions.
- [x] A Claude coordinate cannot be constructed without both marketplace fields, proven by a type-level test.
- [x] `DEFERRED_COMPONENT_KINDS` is exported from exactly one place and referenced nowhere else as a literal list.
- [x] `selectionKey` is stable across a bundle rename and changes when the source or coordinates change.

## Verification

- `tests/package-model.test.ts` covers the pure helpers and the key stability rule.
- `pnpm typecheck` proves the union constraints, including a `@ts-expect-error` case for the missing marketplace field.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): completed. Evidence: tests/package-model.test.ts.

# 03: package-bundles.ts manifest parsing, inventory, and discovery

**What to build:** The boundary between raw manifest bytes and the domain types,
per section 4.1 of `.scratch/packages/design.md`.

- `parsePiPackageManifest`: the `pi` key path arrays, or the conventional
  `extensions/`, `skills/`, `prompts/`, and `themes/` directories.
- `parseClaudePluginManifest`: `name` required, the component keys read into the
  inventory at the plugin root.
- `parseClaudeMarketplace`: the top-level fields and the `plugins` entries, with
  the entry `version` overriding the plugin manifest `version`.
- `buildComponentInventory`: `(kind, ownership, effect)` per component, with the
  deferred kinds surfaced exactly once.
- `discoverBundlesInSnapshot`: one pass over the snapshot files that indexes
  `package.json` at the scope root and `.claude-plugin/*.json` under it, and
  yields a descriptor per bundle. A dual-format repository yields two descriptors
  over the shared skills directory.
- The owned-skill matcher built from the same descriptors, exported for the guard
  module.

Boundary refusals: a Pi manifest below the scope root, a scoped GitHub Source URL
for Pi, a Claude plugin with no in-repo marketplace binding, and a bundle-declared
`command` marketplace source.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] The pstack-shaped fixture yields one Pi descriptor and one Claude descriptor over the shared `plugins/pstack/skills`.
- [ ] The Claude descriptor reports twelve agents and the correct deferred kinds, and no skill is folded into the deferred list.
- [ ] The Pi conventional fixture with no `pi` key discovers the same inventory as the explicit manifest.
- [ ] `manifestDigest` changes when any bundle manifest byte changes, and is stable across a rebuild.
- [ ] Each refusal above yields a warning or an installability reason rather than a throw.
- [ ] The `EXCLUDED_LIFECYCLE_SEGMENTS` filter applies to discovered skill paths.

## Verification

- `tests/package-bundles.test.ts` over the fixture repositories, pure functions only, no seams.

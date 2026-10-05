# 01: Record the Package resource in SPEC, CONTEXT, DESIGN, an ADR, and the research doc

**What to build:** Promote the deferred plugins/extensions category to a managed
**Package** resource, as specified in `.scratch/packages/spec.md` and designed in
`.scratch/packages/design.md`.

- SPEC.md: remove plugins and extensions from the deferred list, add Package as a
  confirmed category, and narrow the deferred list to agent definitions and MCP
  servers.
- CONTEXT.md: add Package, bundle, component inventory, and marketplace binding,
  and drop the avoid-note that told readers not to use the word Package.
- DESIGN.md: remove plugins and extensions from the deliberate exclusions and add
  a Package section beside the App recipe section. Keep the no-generic-plugin-
  framework line, because Packages are explicit logic and frozen tables.
- Add `docs/adr/0009-delegate-package-lifecycle-to-host-clis.md` recording the
  ownership boundary, the derived-declaration approval digest, and the absence of
  any Agent Depot write under a Host skill root.
- Amend the recommended V1 interpretation in
  `docs/research/host-resource-compatibility.md`, which currently says portable
  skills are the only confirmed category.

**Blocked by:** None. Can start immediately.

**Status:** ready-for-agent

- [ ] SPEC.md, CONTEXT.md, and DESIGN.md no longer list plugins or extensions as deferred, and they describe the Package scope and exclusions.
- [ ] ADR 0009 exists and records the ownership boundary and the approval decision.
- [ ] The research doc's recommended V1 interpretation names Package as a confirmed category.
- [ ] Agent definitions and MCP servers remain explicitly deferred in all four documents.

## Verification

- Documentation-only scope. TDD and a runtime harness do not apply, because no runtime behavior changes.
- `pnpm typecheck`, `pnpm test`, and `git diff --check` pass.
- Code review against the starting HEAD, Standards and Spec reviewed separately.
- Rollback boundary: revert the doc edits and delete ADR 0009. No runtime files are affected.

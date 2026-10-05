# 06: package-content.ts source view port and the git-source read methods

**What to build:** The read-only Source snapshot port, per section 4.3 of
`.scratch/packages/design.md`.

- `PackageSourceView` with `origin`, `resolvedCommit`, `find`, `list`, and `read`.
  No field carries a filesystem path a host CLI could be given, so handing a host
  a bare-mirror path is impossible by type.
- `HostFacingOrigin`, including the repository URL without scheme, the ref, and
  the directory scope from a GitHub tree URL when there is one.
- `PackageContentAccess` and `createNodePackageContentAccess`.
- Add `listFiles` and `readFile` to `GitSourceSnapshotAccess` in
  `src/git-source.ts`, so the port does not duplicate `requireMirror`,
  `readResolvedCommit`, or the symlink guard.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] `createNodePackageContentAccess` reads a fixture repository's files at a resolved commit.
- [ ] `origin` for a scoped GitHub tree Source carries the directory and never a local path.
- [ ] A source that is not a directory URL still yields a view whose `origin` is the repository root.
- [ ] The bare-mirror, symlink, and size guards in `git-source.ts` are unchanged and still cover the new methods.

## Verification

- `tests/package-content.test.ts` over a local fixture mirror, no network.

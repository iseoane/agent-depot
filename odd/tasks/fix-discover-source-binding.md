# Fix CLI discovery binding

- [x] Reproduce the real default Source operations failure in a deterministic CLI regression test (red: 1 failed).
- [x] Fix discovery dispatch without breaking injected operations and verify CLI plus full suite (26 CLI tests, 88 full tests, typecheck passed).
- [x] Review the focused diff and commit the fix.

Root cause: extracting `discoverSkills` detached its `this` receiver, which real Source operations use to select sources. The isolated real-operations regression covers the public CLI path.

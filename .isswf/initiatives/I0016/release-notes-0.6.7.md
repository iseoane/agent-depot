## [0.6.7] - 2026-11-03

### Fixed

- Claude Skill installations on Windows now use directory junctions instead of
  privilege-sensitive directory symlinks. Installation, additional Host exposure
  and overwrite share the same creation policy; POSIX directory symlinks remain
  unchanged. Rollback removes the managed link without following its target.
- User-global Skill removal can now explicitly forget a missing installation
  record, without removing files, so the Skill can be selected again in Catalog.
  Recovery refuses unsafe paths, remaining Claude locations, overlapping records
  and changes to the confirmed installation state. CLI and TUI previews and
  completion messages distinguish record-only recovery from file removal.

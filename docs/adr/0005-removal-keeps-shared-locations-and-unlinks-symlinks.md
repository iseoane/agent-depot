# Removal keeps locations used by another Host and unlinks symlinks

Status: Accepted (2026-09-30)

## Context

Non-Claude Hosts share the [canonical location](../../CONTEXT.md) and Claude Code is a symlink to it. A recursive delete of a symlink or of a shared directory could destroy content still in use or a link target.

## Decision

Removing some Hosts never deletes the canonical directory while another Host uses it; only the managed Claude symlink is removed. Symlinks are removed with `lstat` identity checks and `unlink` only, never a recursive delete, and their target is never read or modified. A full removal deletes the canonical directory. Targets and records are rechecked just before deleting, and the Claude link of an unmanaged canonical directory is removed first so it never dangles.

## Consequences

- A foreign symlink at a Claude path is refused rather than replaced.
- If recording the change fails after removing a link, the error says so and rollback errors are reported together with the original.
- A failing location does not stop the others in a batch.

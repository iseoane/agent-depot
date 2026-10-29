# I0001: Windows: run npm-installed host CLIs (#41)

Type: bug

This coordinator-owned plan records reported progress, not execution permission or process liveness.

## J001

- Status: awaiting-human
- Objective: Package installs on Windows run npm-installed host CLIs (e.g. pi) instead of failing with spawn ENOENT
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md) (pending until prepared)
- Blocker: Operator decision: integrate PR #42 into main; recommended real-Windows check first
- Next step: Operator verifies on Windows (install isswf-pi-resources from the TUI) and decides on merging PR #42

### Acceptance

- win32 resolver prefers name.cmd over the extensionless npm sh shim; shim-only resolves to no executable (manual required)
- win32 .cmd/.bat run through cmd.exe /d /s /c with MSVCRT-quoted, caret-escaped arguments; other commands spawn directly
- Arguments with line breaks or & | < > are rejected with EINVAL and reported as a manual step
- No behavior change on Linux, macOS or WSL-blocked logic
- pnpm typecheck, lint and test pass; CI green on the PR head

### Evidence

- PR https://github.com/iseoane/agent-depot/pull/42 head d1c1bef6ba9ccec549d0c65741f715a670d3958e
- CI run 40753279943: check pass (after rerun of an unrelated flaky test), pack pass
- Reviews V001 (approve) and V002 (approve after correction round 1)
- jobs/J001/delivery.md

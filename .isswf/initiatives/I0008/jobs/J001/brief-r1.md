# Job brief

## Identity and authorization
- Job: I0008/J001, r1. Source: operator 2026-10-29 (accepted Windows runner cost). Mode: feature-to-PR.
- Side effects: edit `.github/workflows/ci.yml`, `tests/`, and only test-skip guards elsewhere; local commits on `ci/46-windows`; no push. The coordinator pushes and observes Windows CI, and will return failures to you.

## Objective
GitHub issue #46 (`gh issue view 46`). All CI jobs run on ubuntu-latest; add Windows.

## Acceptance
1. A `windows-latest` job (matrix entry fine) runs `pnpm typecheck`, `pnpm lint`, `pnpm test`. Do not run pack/audit/publish on Windows unless trivial. Mind line endings (`.gitattributes` / `core.autocrlf`) and shell differences (`shell: bash` where scripts assume POSIX).
2. Tests that genuinely cannot run on win32 are skipped explicitly with a reason (`{ skip: process.platform === "win32" && "reason" }`), never silently. List them in the report. Do not skip to hide real product bugs: report suspected product bugs instead.
3. A win32-only round-trip test of `runProcess` (src/process-runner.ts) against a `.cmd` in a path containing a space and `(x86)`, echoing argv through node; arguments `""`, `a b`, `say "hi"`, `x\`, `x\\`, `a\\"b`, `%PATH%` must arrive byte-identical. On non-win32 it is skipped.
4. Locally: `pnpm typecheck`, `pnpm lint`, `pnpm test` still pass on Linux.
5. You cannot run Windows: predict likely win32 failures by reading tests (path separators, symlinks, chmod/executable bits, `/tmp`, shebangs, PTY e2e) and pre-empt the obvious ones; list the uncertain ones.

## Execution
- Sonnet 5.5 / high. Commits `ci: ...` / `test: ...`, no attribution lines of any kind.
- Report to `.isswf/initiatives/I0008/jobs/J001/A001.md`.

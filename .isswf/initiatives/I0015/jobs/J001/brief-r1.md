# Job brief

## Identity and authorization
- Job: I0015/J001, r1. Source: operator 2026-10-29 ("ok pero por favor coordinador encargate"). Mode: bug-to-PR.
- Work in the main checkout C:\0-BackupVF\WorkSpace\agent-depot on branch fix/70-windows-self-update (base 9faaaf973cb3029ffcfd261cc4d0b1bb0ce28ff7). Host: Windows 11, Git Bash + PowerShell.
- Side effects: edit src/self-update.ts, tests/self-update.test.ts (and helpers if needed), CHANGELOG.md, docs only if they describe the npm verification; local commits only. No push, no PR (coordinator owns delivery). Leave untracked .scratch/* and package-lock.json alone.

## Objective
GitHub issue #70 (`gh issue view 70`). `npmGlobalExecutable()` (src/self-update.ts:98-122) requires `realpath(npm)` to end in `npm/bin/npm-cli.js` (line 102). On win32 the resolver (src/executable-resolution.ts:59-61, PATHEXT-only) returns `C:\Program Files\nodejs\npm.cmd`; its realpath is itself, so self-update is always "unsupported" on Windows. Observed on the operator's machine with a correct npm global install.

## Skills and evidence (mandatory)
- isswf-debug: C:\Users\iseoane\.claude\plugins\cache\isswf\isswf\1.4.0\.agents\skills\isswf-debug\SKILL.md
- isswf-tdd: C:\Users\iseoane\.claude\plugins\cache\isswf\isswf\1.4.0\.agents\skills\isswf-tdd\SKILL.md — add a win32 test (filesystem fixture with `<dir>/npm.cmd` + `<dir>/node_modules/npm/bin/npm-cli.js`, injected resolver/run) that is RED before the fix; paste output.
- Read both before writing code. Follow AGENTS.md test isolation (tests/isolated-env.ts). Deviations section mandatory.

## Acceptance
1. On win32, an `npm.cmd` (case-insensitive extension) whose directory contains `node_modules/npm/bin/npm-cli.js` is accepted as npm; the remaining guards (`npm root -g` absolute, package dir exists, realpath(packageRoot) === realpath(installed path)) stay unchanged and still reject mismatches. Make the platform injectable for tests if needed (match existing seam style).
2. win32 rejections still hold: npm.cmd without sibling npm-cli.js; a non-npm .cmd; packageRoot not equal to global install (tests).
3. POSIX behavior unchanged; existing self-update tests pass untouched.
4. Real check on this machine: after `pnpm build`, running the built CLI's check path against the real npm returns not-"unsupported" ONLY if this checkout were the global install — instead, demonstrate with a direct call of `npmGlobalExecutable`-equivalent logic (createSelfUpdateOperations with packageRoot = real global install path) that check() returns current/available. Report output.
5. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; CHANGELOG under Unreleased/Fixed referencing #70.

## Execution
Sonnet 5.5 / high. Conventional commits (fix/test), NO Co-Authored-By or any attribution lines. Report: .isswf/initiatives/I0015/jobs/J001/A001.md (sections: Skills applied and evidence, Deviations, Changes, Results).

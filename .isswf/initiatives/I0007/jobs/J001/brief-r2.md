# Job brief I0007/J001 r2 (correction cycle 1 of 2)

Same authorization and execution as r1. Read V001.md in this folder.
1. F1: `import` "Applying import" (src/profile-cli.ts:77) must use `{ mayPrompt: true }` when confirmed (simplest: always when confirmed). Add a cli-progress test importing a git-Source Skill (stub the refresh) that asserts the step is static/prompting, not animated.
2. F3: wrap Package `planLifecycle` calls that refresh Sources (src/package-cli.ts ~:73, ~:82; src/cli.ts ~:1113) with a static `mayPrompt` step, e.g. `Refreshing Source for Package <sel>`; keep stdout identical.
3. Re-audit: grep every call path from a wrapped animated step to `gitAccess.refresh`/`refreshProjectSource`/`refreshSourceFor`; list them in A002 with proof each is either mayPrompt or unreachable.
4. Re-run typecheck, lint, test, test:e2e. One commit `fix(cli): ...`, no attribution lines. Report to A002.md.

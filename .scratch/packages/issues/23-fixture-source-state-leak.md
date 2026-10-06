# Fixture Source escaped test isolation

Status: fixed in code, real-state cleanup awaiting user authorization.

The user found `git:4adb644c0af552dcf61d79e0`, pointing to
`https://github.com/example/pstack.git`, in the real Source catalog.
Parent confirmed that entry in `~/.local/state/agent-depot/sources.json`.

## Cause and evidence

The focused Package-owned Skill test called `createSourceOperations` with a
fixture home but without an explicit state path. The documented XDG state root
has precedence over an injected home. Parent reproduced the escaped write with
the compiled API using only temporary directories. No real user state was
changed by that reproduction.

The scoped worker transcript records two `npx tsx --test
tests/package-owned-skills.test.ts` commands at 2026-10-06T08:47:56Z and
08:48:01Z, without the isolation preload. The shell inherits an absolute
`XDG_STATE_HOME`. These executions are the likely origin of the real entry;
the precise first write was not logged, so attribution is inferred.

Normal `pnpm test` imports the isolation module. The unsafe direct invocation
bypassed that guard.

## Fix

Commit `2279d6a` imports the isolation module from the focused test itself and
provides an explicit fixture Source state path. Production XDG behavior stays
unchanged. Commit `d9588c4` adds a child-process regression that intentionally
omits the preload and requires an inherited temporary user-state sentinel to
remain empty. It also requires the focused tests to succeed.

Parent independently verified 972 tests, type checking, lint, dead-code audit,
whitespace checks, and the packed artifact smoke test. The real fixture Source
has not been deleted. No npm publication or deployment has occurred.

# Global unmanaged skills

Goal: Display installed but untracked user-global skills separately from managed update statuses and allow individually selected permanent removal. No project inventory, automatic repository search, or implicit Source attribution.

Approved deletion policy: permanent after exact-path preview and explicit --yes; warn that recovery via Agent Depot requires a resolvable Source and is not guaranteed. Do not touch live global skills while implementing or testing.
TDD: not explicitly enabled; ordinary focused/full pnpm checks.
Delivery: user accepted one large review unit after the >400-line workload was disclosed; branch feat/global-unmanaged-skills. No commit/push authorized yet. Non-cooperating filesystem writers remain an unavoidable non-atomic race.

- [x] Task 1 (delegated writer): Scan supported global skill directories safely; classify managed vs unmanaged without duplicates or counting backups/unsafe symlinks; tests. Evidence: focused inventory tests 6/6 and typecheck passed; no commit yet.
- [x] Task 2 (delegated writer): Add `Unmanaged (N)` list to user-global `update check` only; retain managed Updateable/Current/Unknown semantics and project behavior; tests/docs. Evidence: CLI tests 54, inventory tests 6, typecheck passed; no commit yet.
- [x] Task 3 (delegated writer): Add selective permanent deletion for explicit unmanaged global skill path with preview, --yes, identity/content recheck and race/symlink protections; existing `uninstall --skills` unchanged; tests/docs. Evidence: independent verifier `pnpm test` 195/195, `pnpm typecheck`, `pnpm lint`, `git diff --check` passed. Real read-only global update check: Current (31), Unmanaged (79), Unknown (0). No real skill deletion or commit.

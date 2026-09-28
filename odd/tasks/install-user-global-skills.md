# Install user-global skills

Ticket: `.scratch/agent-depot/issues/05-install-user-global-skills.md`

- [x] Extend shared per-user state with independent user-global installation records and backwards-compatible loading.
- [x] Route explicit user-global CLI installation through the existing safe installer and adoption behavior, with preview and confirmation.
- [x] Add focused tests and documentation; run typecheck and full suite.

Verification: `pnpm typecheck`, `pnpm test` (85 passed), `git diff --check`. Review pending.

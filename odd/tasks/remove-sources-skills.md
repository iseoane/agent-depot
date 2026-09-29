# Remove Sources and Skills safely

Ticket: `.scratch/agent-depot/issues/08-remove-sources-and-skills.md`

Scope: user-global installations only; project manifests are independent and not inventoried. Removal defaults to keeping dependent selections. Uninstall of adopted or modified content requires explicit confirmation with warning. No cache deletion. Source URL replacement requires a new identity and explicit selection migration.

- [ ] Implement preview and safe removal of registered Git Sources and selected user-global Skills, with focused tests and CLI documentation. Commit: pending.
- [ ] Implement explicit migration of user-global selections to a newly added Source without silent identity rewrites, with focused tests and documentation. Commit: pending.
- [ ] Run typecheck, focused and full tests, perform standards/spec code review, resolve findings. Commit: pending.

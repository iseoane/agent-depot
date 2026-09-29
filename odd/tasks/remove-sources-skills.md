# Remove Sources and Skills safely

Ticket: `.scratch/agent-depot/issues/08-remove-sources-and-skills.md`

Scope: user-global installations only; project manifests are independent and not inventoried. Removal defaults to keeping dependent selections. Uninstall of adopted or modified content requires explicit confirmation with warning. No cache deletion. Source URL replacement requires a new identity and explicit selection migration.

- [x] Implement preview and safe removal of registered Git Sources and selected user-global Skills, with focused tests and CLI documentation. Commit: c301d91. Focused tests: sources 19 passed; CLI 38 passed; typecheck passed.
- [x] Implement explicit migration of user-global selections to a newly added Source without silent identity rewrites, with focused tests and documentation. Commit: 0f851ff. Focused tests: sources 20 passed; CLI 40 passed; typecheck passed.
- [x] Run typecheck, focused and full tests, perform standards/spec code review, resolve findings. Commit: d34deef (selection fixes). Final verification: typecheck passed; 142/142 tests passed; diff check passed. Standards review found and fixed ambiguous flags and numeric path precedence; spec review passed within agreed user-global scope.

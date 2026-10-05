# 10: package-cli.ts grammar and previews

**What to build:** The thin CLI shell, per section 5 of
`.scratch/packages/design.md` and the ADR 0006 shared-core rule. Every behavior
lives in `package-flow.ts`.

- `agent-depot package list`, `discover <source-id>`,
  `inspect <source-id>::<bundle-path> --host <host>`,
  `approve <selection> --host <host>`,
  `install|update|uninstall <selection> --host <host> [--yes]`,
  `forget <selection> --host <host> --yes`.
- Previews show the resolved origin and commit, the descriptor, the component
  inventory with ownership and effect, every argv with its resolved executable,
  the declared blast radius, the working directory and environment, and any
  warning.
- `--yes` confirms execution only. Approval is a separate command.
- Add `package` to `COMMANDS` and the usage text in `src/cli.ts`.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] Every subcommand parses, rejects an unknown host, and prints a preview before any execution.
- [ ] A run without `--yes` runs nothing and exits non-zero.
- [ ] An unapproved declaration prints the needs-approval state and runs nothing.
- [ ] `forget` runs no host command.
- [ ] The CLI and the future TUI call the same `PackageOperations`.

## Verification

- `tests/package-cli.test.ts` over a fake `PackageOperations`, plus a `tests/cli-options.test.ts` case for the new subcommand family.

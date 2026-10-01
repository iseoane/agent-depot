# 11: TUI: App recipes section in Sources

**What to build:** The Sources view gains an "App recipes" section below the Git Sources, to see every recipe in the per-user `apps/` directory, preview and approve them, and get a simple guide to add a new one. Lifecycle actions (install, update, setup) stay in Installations and Updates, unchanged. No new tab.

- The section header shows the `apps/` directory path for this environment.
- Rows list every recipe file: approved, needs approval, invalid recipe (with reason), and not applicable (other platform).
- Keys in the section, consistent with Sources: `n` opens the add guide, Enter previews (every argv, platform, file path, status) and asks y/n to approve (`n`/Esc closes without approving), `r` reloads. Git Source keys and behaviour are unchanged.
- Add guide (`n`), two options only:
  1. **With the AI skill:** if `agent-depot-apprecipe` is not installed, offer to install it from the TUI (reusing the existing Catalog install flow, with its preview and confirmation); then show the prompt to paste into the agent, e.g. "Use the agent-depot-apprecipe skill to create the recipe for <app>".
  2. **Manual:** show the `apps/` directory path and point to `agent-depot app schema`.

**Blocked by:** 01–10.

**Status:** completed

- [x] The App recipes section lists every recipe with its status, including invalid and not-applicable ones, and shows the `apps/` path.
- [x] Enter previews a recipe and approves it only after y; approval reuses the shared core and the existing preview panel.
- [x] `n` shows the two-option guide; option 1 installs the skill through the existing install flow when missing and then shows the prompt; option 2 shows the path and `app schema`.
- [x] Git Sources keys and behaviour are unchanged; Catalog, Installations and Updates are unchanged.
- [x] The spec and ADR 0007 record that Sources now hosts App recipe management.

## Comments

Implemented on `feat/tui-app-recipes`. Tab switches between Git Sources and App
recipes; Git Source movement, marks and actions retain their existing behavior.
The guide delegates Skill installation to the existing Catalog flow, including
Host/scope/version selection, preview and confirmation. Sources listing/reload
uses cached inspection only, never version/latest execution.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` (646 passed), and
`pnpm test:e2e` (3 passed). Focused recipe tests: 6 passed, including real
built-in Skill installation on a temporary home and shell key capture.
Standards and spec review against starting commit
`dbb079a6d055cab45cc4e7389bdb5e80b7a12211`: no unresolved findings.
Review was performed directly; no sub-agent execution tool was available.
Rollback boundary: remove the Sources recipe hook and its view/environment
wiring, shared preview formatter export and core directory exposure, together
with the ticket tests and recipe-management documentation. Existing App
lifecycle operations and Catalog installation behavior remain unchanged.

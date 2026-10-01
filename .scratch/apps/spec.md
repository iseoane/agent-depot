# Apps: user-declared recipes for agent applications

Status: needs-triage

## Problem Statement

Some coding-agent capabilities are not portable skills but applications: a CLI or binary that, once installed, wires itself into one or more Hosts. It can add MCP servers, plugins, hooks, skills, or instruction blocks. Examples are Engram, CodeGraph, and GitNexus. Users install, update, wire, and uninstall each of them by hand, through a different channel (Homebrew, npm, release binaries, install scripts) and a different setup command. Nothing records which apps a user has, which version is installed, or whether a newer one exists.

Agent Depot currently manages only portable skills; CLI applications are a deferred category (`SPEC.md`, `CONTEXT.md`). Apps also interfere with skill management. GitNexus, for example, writes its own skills into `~/.claude/skills` and `~/.agents/skills`, and Agent Depot then reports them as unmanaged skills and offers to adopt or remove them.

## Solution

Add an **App** resource whose lifecycle is delegated to the app's own commands through a **user-declared recipe**.

Agent Depot does not install apps by itself. For each lifecycle step it runs the command declared in the recipe, or shows it to the user when it cannot run it. It previews every command and requires confirmation. It then records which apps are installed and at which version.

Agent Depot deliberately does **not** track or verify what an app writes where. The app's own install, setup, and uninstall commands own those artifacts.

Agent Depot does not clone app repositories. Recipes are plain JSON files written by the user, either by hand or with the help of an AI agent through the built-in `agent-depot-apprecipe` skill. Agent Depot ships no built-in recipes.

Apps are integrated into the existing TUI and CLI. The TUI gains no new tab, top-level mode, or screen.

## Recipe model

- **One recipe per file.** Each recipe is a JSON file in an `apps/` directory inside Agent Depot's per-user directory for the current environment. Linux/WSL and Windows each have their own directory, next to `sources.json` in the existing environment-local state directory.
- **Identity.** `name` is the App identity. The file name is free, for example `codegraph.json` or `codegraph-linux.json`.
- **Platform.** The optional `platform` field takes `linux`, `windows`, or `darwin`; WSL counts as `linux`.
  - A recipe without `platform` applies to every platform.
  - Several files may share a `name` with different `platform` values. In each environment only the matching recipe applies, and the TUI shows a single App.
  - Two applicable recipes with the same `name` are a validation error.
- **Steps.** `install`, `update`, `uninstall`, and optional per-Host `setup` and `teardown` steps. Each step is one of:
  - `{ "argv": [...] }`: Agent Depot runs it, without a shell. It follows the existing user-method rules: a bare executable name, no shell interpreters, no shell syntax, and no credentials.
  - `{ "manual": "<command text>" }`: Agent Depot shows the command for the user to run and never executes it.
  - `{ "argv": [...], "manual": "..." }`: Agent Depot runs `argv`. If the process cannot be spawned, it falls back to showing `manual`.
- **Version.** `version` is `{ "argv": [...], "pattern": "<regex with one capture group>" }`. It is the only signal that an App is installed and at which version.
- **Latest version.** `latest` is one of `{ "github": "owner/repo" }` (GitHub Releases API), `{ "npm": "<package>" }` (npm registry), or `{ "argv": [...], "pattern": "..." }`. If `latest` is absent or cannot be resolved, the latest version is unknown and the App is not offered as an update.
- **Owned skills.** `skills` is an optional list of skill names or globs, such as `gitnexus-*`, that the App installs itself. They are labelled as belonging to the App and excluded from the unmanaged-skill adopt and remove flows. This is a declarative filter; Agent Depot verifies nothing about those paths.
- **Homepage.** `homepage` is optional and informational.

Example:

```json
{
  "name": "codegraph",
  "platform": "linux",
  "homepage": "https://github.com/colbymchenry/codegraph",
  "install":   { "argv": ["npm", "i", "-g", "@colbymchenry/codegraph"] },
  "update":    { "argv": ["codegraph", "upgrade"] },
  "uninstall": { "argv": ["codegraph", "uninstall", "-y"] },
  "version":   { "argv": ["codegraph", "--version"], "pattern": "(\\d+\\.\\d+\\.\\d+)" },
  "latest":    { "npm": "@colbymchenry/codegraph" },
  "setup":     { "claude": { "argv": ["codegraph", "install", "-t", "claude", "-l", "global", "-y"] } },
  "skills":    []
}
```

## Execution rules

- Every step is previewed (exact argv or manual text, environment, App, step) and requires explicit confirmation. This is the same safety contract as user-provided skill methods.
- **Recipe approval.** Agent Depot runs `version` and `latest.argv` without a per-run prompt: in the TUI, in `app list`, in `app validate`, and in update checks. It cannot know that those commands are read-only. The argv rules would accept `"version": {"argv": ["npm", "i", "-g", "x"]}`, and recipes are often written by an AI agent from third-party READMEs. Before Agent Depot runs any command from a recipe, the user must therefore approve that recipe once:
  - Approval is keyed on the canonical recipe file path and a hash of its exact content, stored atomically in sibling `app-approvals/`.
  - The approval preview shows every argv in the recipe.
  - A new or changed recipe is shown as "needs approval", and none of its commands run until the user approves it.
  - Install, update, uninstall, setup, and teardown still need their own per-step confirmation.
- **Resolved executable.** Previews and `app list` show the absolute path that the step's executable resolves to.
- **WSL PATH isolation.** WSL appends Windows directories to `PATH`, for example `%APPDATA%\npm` and `%LOCALAPPDATA%\pnpm`. Those directories hold extensionless npm shims that Linux can resolve. Observed on the author's machine: `/mnt/c/Users/<user>/AppData/Roaming/npm/codegraph` and `.../gitnexus` are on the WSL `PATH`.
  - On WSL, a PATH candidate whose realpath is under `/mnt/<drive>/` belongs to Windows and is skipped while looking for a Linux candidate. If no Linux candidate exists, it is treated as "not installed in this environment" and never run. The PATH candidate, not its realpath, is spawned to preserve shim/multicall behavior.
  - Without this rule, a Windows install could make `version` report a false "installed" on Linux, and a Linux uninstall could never be confirmed.
- **Manual fallback.** It applies only when the process cannot be spawned (for example the executable is missing, or Windows cannot launch a `.cmd` shim without a shell). A command that starts and exits non-zero is reported as a failure with its output. It never falls back to `manual`.
- **After a manual step**, the user confirms that it is done. Agent Depot then runs `version`:
  - After install or update, the App is recorded as installed only if `version` succeeds.
  - After uninstall, it stops tracking the App only if `version` no longer succeeds, or if the user explicitly forgets it.
- App steps run with the user's home directory as their working directory. Skill methods are confined to the project root; apps are not.
- Apps are user-global only in this iteration.
- A failure in one App during a batch does not stop the remaining selected Apps; the outcome is summarised per App.

## CLI

- `agent-depot app list` lists recipes that apply to this environment, with installed version, latest version, and status. It also lists invalid recipes with the reason.
- `agent-depot app install|update|uninstall <name> [--yes]`, and `agent-depot app setup|teardown <name> --host <host>... [--yes]`.
- `agent-depot app schema` prints the recipe JSON Schema.
- `agent-depot app approve <name> [--yes]` previews one applicable recipe and every argv; only `--yes` records approval.
- `agent-depot app validate <file>...` validates recipes and does not accept `--yes` or record approval.
  - For matching, already-approved recipes it runs `version`. Unapproved recipes only show the argv preview and needs-approval state; approve by name separately. Agent Depot cannot know that the command is read-only.
  - It reports recipes for other platforms as not applicable here, so they never seem to disappear.
- App updates also appear in `agent-depot update check` / `update apply` alongside skills.

## TUI (no new screens)

- **Installations tree.** Add a new root group, "Apps (user-global)", next to the existing Managed and Unmanaged roots.
  - An App row shows its name, its installed version or "not installed", and an "invalid recipe: <reason>" state.
  - Keys are existing ones: `i` install (as in Catalog), `u` uninstall, `h` setup per Host (reuses `HostChecklist`), and space/`a` to mark Apps for bulk actions (reuses `runBatch`).
- **Updates.** App rows join the same batch as skills, with the same statuses (update available / up to date / cannot be checked). `r` re-checks, and Enter previews and confirms.
- **Recipe approval.** A "needs approval" App row is approved with Enter. Approval reuses the preview panel, which lists every argv in the recipe, and the existing y/n confirmation.
- **Teardown.** Host teardown is reached from the same `h` Host checklist by deselecting a Host. Whether `u` also offers teardown first is Open Question 4.
- **Manual steps.** They reuse the existing preview panel and the y/n confirmation. The panel shows the command for the user to run; `y` means "done, check now" and runs `version`.
- **Version checks.** Running `version` for each App is lazy or cached so TUI start-up stays fast. The `latest` network lookup runs only in Updates.
- Sources and Catalog are unchanged.

## AI-assisted recipes: `agent-depot-apprecipe` skill

This is a built-in skill in `builtin:agent-depot`, installed through the normal skill flow. It guides an AI agent to produce recipes for an App:

1. **Research without cloning.** Read the README, install docs, and releases through the GitHub API or the web.
2. **Be platform-aware.**
   - Identify per-OS instructions: `install.sh` vs `install.ps1`; brew vs scoop/winget; release asset names per OS and architecture; explicit "Windows: use WSL" or "unsupported" notes.
   - Emit one recipe without `platform` when the steps are identical everywhere. Emit one recipe per platform when they differ.
   - Report unsupported platforms instead of inventing steps.
3. **Detect the actual install channel** on this machine before filling `update` and `uninstall`.
   - Use `brew list`, `npm ls -g`, or every `PATH` match of the binary (`which -a` / `whence -a`).
   - When there are several installs, report all of them and let the user choose. Example: CodeGraph was found both in `~/.local/bin` (bundle) and in `~/.npm-global/bin` (npm), plus a Windows shim seen from WSL.
   - If it cannot tell, it asks the user. A recipe must match how the App is really installed.
4. **Derive update and uninstall from the channel.**
   - brew uses `brew upgrade` / `brew uninstall`. `npm i -g` uses `npm uninstall -g`. pipx uses `pipx upgrade` / `pipx uninstall`.
   - `go install` and release binaries need a `manual` step that removes the binary.
   - Prefer the App's own uninstall command when it exists, because it also undoes its setup.
5. **Separate install from Host wiring.**
   - The App's setup command for each Host goes into `setup`.
   - Optional `teardown` steps, usually `manual`, undo wiring that a channel uninstall leaves behind, for example `claude mcp remove engram --scope user`.
6. **Respect the argv rules.**
   - Prefer non-shell channels (npm, brew, release binaries).
   - When the only official path is a script (`curl | sh`, `irm ... | iex`, `.ps1`, `.cmd`), emit a `manual` step.
7. **Validate.** Run `agent-depot app validate` on recipes for the current platform. Mark recipes for other platforms as unverified.
8. **Report.**
   - Which recipes it produced and for which platforms, and which were verified.
   - What it left empty because it does not exist.
   - Anything the user should know: license, telemetry or update checks, and duplicate install routes that conflict (for example a plugin-marketplace route plus a setup command).

## User Stories

1. As a user, I can declare an App with a recipe file so that Agent Depot knows how to install, update, and uninstall it, without Agent Depot cloning its repository.
2. As a user, I can ask an AI agent with the `agent-depot-apprecipe` skill to research an App and write its recipe, then validate it with `agent-depot app validate`.
3. As a user on WSL and Windows, I can keep `codegraph-linux.json` and `codegraph-windows.json` side by side, and each environment uses only its matching recipe.
4. As a user, I can see my Apps, their installed versions, and invalid recipes in the existing Installations view.
5. As a user, I can install, uninstall, and run per-Host setup for an App from the TUI with the same keys used for skills.
6. As a user, I can see App updates in the same update batch as skills, and apply all or a subset.
7. As a user, when Agent Depot cannot run a step (Windows scripts, `curl | sh`), I am shown the exact command to run myself, and Agent Depot then checks that it worked.
8. As a user, skills that an App installs itself are not offered for adoption or removal as unmanaged skills.
9. As a user, I am never told an App is installed or updated unless its `version` command confirms it.

## Implementation Decisions

- The App is a new resource category, enabled by a SPEC scope change and an ADR. Add an **App** / **App recipe** term to `CONTEXT.md`, replacing the deferred "CLI application" wording.
- No generic plugin framework. Recipe parsing, step execution, and the version/latest lookup are explicit modules behind the existing injectable command runner (`process-runner.ts`).
- The recipe argv validation reuses the user-method rules in `parsePortableInstallationMethod`. Two differences apply: a `manual` text is free-form but is never executed, and the cwd is the user's home.
- The installed-App records live in the per-user state (`sources.json`) or a sibling file. Recipes stay user-owned files that Agent Depot never rewrites.
- The TUI changes extend existing discriminated unions:
  - `NodeData` in `installations-tree.ts`, and the `Entry` / `UpdateRow` kinds in Updates.
  - `ManageMode` / `MANAGE_KINDS` for the App confirm kinds, and `BulkTarget` for bulk App actions.
  - An optional App operation on the TUI operations/environment seam, for tests.
- The unmanaged-skill inventory filters out names matching any applicable recipe's `skills` list.

## Testing Decisions

- Recipe parsing and validation: platform selection, duplicate names, the step forms, the argv rule rejections, and the `version` pattern.
- Recipe approval:
  - No command from an unapproved or changed recipe runs.
  - Approval is invalidated when the recipe content changes.
- WSL resolution: an executable under `/mnt/<drive>/` is treated as not installed in this environment.
- Step execution with the injectable runner:
  - Spawn failure falls back to manual; a non-zero exit is a failure, not a fallback.
  - The post-manual `version` check decides the recorded state.
- `latest` resolution with stubbed GitHub and npm responses. When the latest version cannot be resolved, the status is unknown and the App is not offered as an update.
- TUI tests:
  - The Apps group renders.
  - The keys `i`, `u` and `h` reach the preview and confirm flow.
  - The manual step flow works.
  - App rows appear in the update batch.
  - Owned skills are excluded from the Unmanaged group.

## Out of Scope

- Agent Depot editing Host configuration files (`~/.claude.json`, `config.toml`, `opencode.json`, settings, instruction files) on an App's behalf.
- Tracking, snapshotting, or verifying what an App writes.
- Built-in recipes shipped by Agent Depot, and recipes declared by Sources.
- Cloning App repositories.
- Project-scoped Apps and per-project steps such as `codegraph init` or `gitnexus analyze`, deferred to a later iteration.
- Executing shell strings. `manual` steps are shown, never run.

## Open Questions

1. **Resolved:** User-edited recipes live in `apps/` beside `sources.json` in the existing per-environment state directory, not a new config root.
2. Whether a bare `npm` resolves to a launchable executable on Windows with `shell: false`. If it does not, the `argv` + `manual` form covers it.
3. Exact CLI grammar, and whether `update apply` selects Apps by name, by index, or both.
4. **Resolved:** `teardown` stays separate; uninstall never implicitly executes another step.
5. **Resolved:** One-time approval uses the canonical file path and exact content hash, with private atomic receipts in sibling `app-approvals/`. CLI approval is only `app approve <name> --yes`; `app validate` never approves. Changed bytes require renewed approval; restoring approved bytes restores approval.
6. **Resolved:** WSL manages Linux only. Windows PATH hits are skipped in favor of Linux candidates; there is no cross-environment view or Windows execution.

## Further Notes

These notes come from the four candidate apps reviewed during exploration on 2026-09-30:

- **Engram:**
  - `engram setup <host>` handles Host wiring, and `engram doctor --json` is a read-only diagnostic.
  - The binary has no uninstall subcommand; the channel's own uninstall applies, such as `brew uninstall engram`.
  - Its Claude Code setup installs both a plugin and an MCP entry by design.
- **CodeGraph:**
  - Provides `install`, `upgrade`, `uninstall` and `status -j`.
  - It has no Pi target, and per-project `codegraph init` is required.
- **GitNexus:**
  - Distributed through npm. It provides `setup`, `update`, and `uninstall`, which is a dry-run unless run with `--force`.
  - It writes skill copies into the Host skill roots, which is the motivation for `skills`.
  - Licensed under PolyForm Noncommercial.
- **Archify:** a plain `SKILL.md` directory, already covered by the skill flow. It is not an App.

### Ticket 03 lifecycle decisions

- Installed-App records use sibling `app-installations/`, one atomic JSON record per hashed App name containing name, canonical recipe file and verified installed version. Independent App writes do not read-modify-write a shared file; existing `sources.json` remains unchanged.
- CLI follows the existing non-interactive preview/rerun convention. `--yes` confirms execution only; `--manual-done --yes` explicitly attests completed manual work and checks version without rerunning argv. `app uninstall <name> --forget --yes` explicitly drops tracking without executing the recipe.
- Open Question 4 resolved: teardown remains a separate action, never implicitly executed by uninstall. Each lifecycle step requires its own preview/confirmation.
- Manual completion rechecks approval, but permits executable resolution to change as a consequence of installation/removal. Automated execution requires the previewed executable to remain unchanged.

### Ticket 04 Host lifecycle decisions

- Setup/teardown reuse lifecycle plans and execution, with repeated `--host <host>` selections. Duplicate, unknown or undeclared Hosts are rejected before execution. Every selected Host is previewed; independent execution failures are reported per Host and do not stop remaining selections.
- Host actions do not persist wiring state or change installed-App records. Automated success means only that the delegated command succeeded. Manual completion uses `--manual-done --yes` and requires a successful version check, which does not verify Host wiring (including teardown).

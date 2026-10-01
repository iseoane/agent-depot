# 02: App recipes: load, validate, approve, and list via CLI

**What to build:** A user drops recipe JSON files into the per-user `apps/` directory. Agent Depot provides:
- `agent-depot app schema` prints the recipe JSON Schema.
- `agent-depot app validate <file>...` validates recipes.
- `agent-depot app list` shows the recipes that apply to this environment: installed version, resolved executable path, needs-approval or invalid state.
- Approving a recipe once, keyed on a hash of its content, permits its `version` command to run.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Recipes are selected by `platform` (WSL counts as linux). A recipe without `platform` applies everywhere. Two applicable recipes with the same `name` are an error.
- [ ] Each step is `argv`, `manual`, or both. `argv` follows the existing no-shell user-method rules. `manual` text is never executed.
- [ ] No command from an unapproved or changed recipe runs. The approval preview lists every argv in the recipe.
- [ ] `version` uses its pattern to extract the installed version. An unresolvable version means "not installed".
- [ ] On WSL, an executable that resolves under `/mnt/<drive>/` is treated as not installed and is never run.
- [ ] `validate` reports recipes for other platforms as not applicable here.

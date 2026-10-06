# 15: A fixed-version Claude selection cannot be delegated

**What is wrong:** `claude plugin install <plugin>@<marketplace>` installs the
plugin at whatever version its marketplace entry declares. The verified verb
surface in `.scratch/packages/arena/host-cli-verbs.md` records no pin slot for
`claude plugin install`, `claude plugin marketplace add`, or
`claude plugin update`. A `PackageSelection` with `{ policy: "fixed" }` therefore
cannot be encoded in Claude argv.

**What ships now:** `planHostSteps` fails closed for `install` and `update` with
`A fixed-version Claude selection cannot be delegated ... cannot carry the pin`,
so a plan never claims a pin the host would ignore. `uninstall` still works,
because it names only the plugin and marketplace.

**What is open:** whether a supported form exists. Candidates to verify against
the installed CLI before any change: a ref on the marketplace source
(`claude plugin marketplace add <url>@<ref>`), a marketplace entry `ref` the
marketplace add honors, or `claude plugin install` accepting a version suffix.
Until one is verified, the refusal stays.

**Status:** ready-for-agent

- [ ] Each candidate form is run against the installed Claude CLI and its actual behavior recorded in `host-cli-verbs.md`.
- [ ] If a pin form exists, `HOST_STEP_TEMPLATES.claude.install` uses it and the refusal narrows to the forms that stay unencodable.
- [ ] If none exists, `PackageSelection` for Claude rejects `fixed` at the boundary instead of at plan time.

## Comments

- 2026-10-06 (docs closure, HEAD 414b005): stays open. `planHostSteps` refuses a fixed-version Claude install and update, and no supported Claude pin form has been verified against the installed CLI, so the three candidates in this issue remain unverified.

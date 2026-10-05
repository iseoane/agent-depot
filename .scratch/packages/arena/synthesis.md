# Arena synthesis: the Package category

## Base

**candidate-2.** It is the only candidate that gets both hard divergences right at
the same time. It reads installed state from the host's own files, which is what
makes the hand-delegated App-recipe case honest, and it keys approval on a digest
of the derived declaration (source, ref, bundle path, manifest digest, exact
argv) rather than on a declaration file hash. It also honors the DESIGN.md veto on
a generic plugin framework by using frozen argv templates instead of an adapter
interface every host must fill, and it reuses the existing seams by name, the
owned-skill guard included.

The cross-judge scored it strong on five of the six rubric criteria and adequate
on interface depth. That one weak point is one graft away.

## Grafts

**From candidate-3.**

- `PackageCoordinates`, the host-discriminated identity union. A Claude selection
  must name `marketplaceRoot` and `pluginName` together, so it cannot name a
  plugin without its marketplace, and a Pi selection has no marketplace slot to
  leave empty.
- `plan.affects` and the adapter's `affectedBy`. Pi's update is host-wide
  (`pi update --extensions`), so a per-bundle plan cannot honestly claim to touch
  one bundle. The plan declares which recorded coordinates the host may move, and
  `recordOutcome` re-observes all of them.
- The branded `HostInstallSpec` and the `PackageSourceView` port with no
  filesystem path field. This makes "never hand a host CLI a bare-mirror path" a
  type rather than a comment.
- `PackageComponent` with `ownership` and `effect`, which carries more than a flat
  kind list and drives the risk line in the preview.
- The refusal of a bundle-declared `command` marketplace source, and the import
  graph assertion that no `package-*` module reaches the Skill install engine.

**From candidate-1.**

- The delegation-only source tier, where a source the host alone can fetch has no
  component inventory rather than a guessed one. V1 ships the tier in the type and
  defers npm-sourced Pi packages.
- `knownMarketplaces`-driven marketplace-add idempotency, which is finer than
  candidate-2's whole-action skip. The `add marketplace` step is omitted when the
  host already knows it, while the other steps still run.

## Divergences and the resolution

| Question | Resolution | Why |
|---|---|---|
| Approval receipt | Keep it, keyed on the derived declaration digest | A Package installs foreign executable content. The selection and the ref are user-authored, and the ref can move, so one-time consent on exactly what will run is warranted. candidate-3's argument that nothing user-authored reaches the runner is true but incomplete. |
| Installed version source | Read the host's own state files | The grounding documents `settings.json` `packages` and `installed_plugins.json` `version`. candidate-3's record-only model goes stale on any out-of-band change and cannot describe a hand-delegated install. |
| Host polymorphism | Frozen argv tables | DESIGN.md vetoes a generic plugin framework, and the hosts converge on nothing except that skills are directories with `SKILL.md`. |
| Pi update | `pi update --extensions`, honestly host-wide | Only that verb is grounded. `pi update <source>` and re-running `pi install` are guesses. The plan carries `affects`. |

## Rejections

- **Package as a generated App recipe.** It exposes the command string the
  category exists to hide, and it makes Agent Depot a recipe author, which ADR 0007
  forbids.
- **Host-neutral Package identity.** It hides nothing and invents an identity that
  fights each host's own dedup rule.
- **Materialize the bundle.** It creates a second managed copy of the bundle's
  skills, which the canonical-location constraint forbids, and it cannot load
  extensions, hooks, or agents at all.
- **Read `pi list` prose.** candidate-1 rejected it too. Host CLI output is
  unstable, so the state files win.
- **A generic manifest parser.** The two formats disagree structurally, so it
  collapses into a host switch inside one module.

## Convergence

All three candidates independently agreed that a Package is per-host, that
manifests are parsed into domain types at the boundary, that lifecycle is
delegated to the host CLI through the injectable no-shell runner with commands
derived rather than pasted, that a bundle never creates a second managed copy of
its skills, that agent definitions and MCP servers stay deferred and are reported
rather than managed, and that version evidence must be able to say `unknown`.
That convergence is the strongest signal in the run and it carries into the
synthesized design unchanged.

## Verification

The synthesized design is checked against the rubric in
`.scratch/packages/design.md` and against the frame's six hard constraints. The
first implementation unit, the manifest parser and discovery over the
pstack-shaped fixture, is the cheapest place to find a wrong assumption, and it
runs with no seams beyond pure functions.

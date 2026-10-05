# Package category arena: frame

## Artifact

Each candidate produces one design package for a new **Package** resource category
in Agent Depot, shaped per
`/home/iseoane/.pi/agent/git/github.com/michael-denyer/pstack-claude/plugins/pstack/skills/architect/references/rationale-template.md`.

A design package is the caller's usage written first, then the type sketch,
function and method signatures, a module map, and the one-page rationale. Bodies
are `not implemented` with `// TODO` pseudocode for anything tricky. There is no
working implementation in this round.

The category must handle at least two host-native bundle formats through one
surface: a Pi package and a Claude Code plugin, including the case where one
repository is both.

## Grounding the candidates read

- `.scratch/packages/grounding/hosts.md`, the primary-source facts for both
  formats and what Agent Depot accepts today.
- `.scratch/packages/grounding/apps.md`, the App recipe lifecycle.
- `.scratch/packages/grounding/skills.md`, the Skill lifecycle and Host exposure.
- `.scratch/packages/grounding/sources.md`, Sources, discovery, version evidence,
  and persistence.

The repository is indexed by CodeGraph. `codegraph explore "<question>"` and
`codegraph node <symbol>` return verbatim source plus callers and are faster than
reading whole files.

## Contradiction to resolve

SPEC.md and DESIGN.md defer plugins and extensions as an independently managed
category. The user chose to build it. The design must state what changes in
SPEC.md, CONTEXT.md, DESIGN.md, and whether a new ADR is required. It must also
state which neighbouring deferred categories stay deferred, meaning agent
definitions and MCP servers, and how a bundle that carries them is handled without
silently managing them.

## Hard constraints

- The user has already delegated bundle lifecycle to the host CLI by hand through
  App recipes. The Package category must interoperate with that, not fight it.
- Agent Depot never clones App repositories and ships no built-in recipes. A
  Package is not an App, and the design must say why they are separate categories
  or why they are not.
- `.agents/skills` and `~/.agents/skills` stay the canonical Skill location, and
  Claude stays a symlink. A Package that also installs Skills must not create a
  second managed copy of those Skills.
- Every external command goes through the injectable command runner, without a
  shell. Approval and preview rules follow the App recipe model.
- Linux and Windows are both supported. Darwin is not a V1 target.

## Rubric

Grade each candidate on these criteria. The picker uses this rubric.

1. **Interface depth.** The public surface for managing a Package is small, and
   manifest parsing, per-host loading, and version resolution sit behind it.
   Callers do not learn Pi or Claude manifest shapes to manage a Package.
2. **Domain model fit.** Package identity, host, bundle source, version evidence,
   component inventory, and lifecycle state are typed so invalid combinations
   cannot be represented. One owner per piece of state. No hand-synced lists.
3. **Integration with existing seams.** Reuses Source identity and Git access,
   the Skill install and Host exposure model, App recipe approval and argv safety,
   atomic file persistence, and the profile export rules. Names each reuse and
   each deliberate non-reuse.
4. **Boundary discipline.** External manifests are parsed into domain types at the
   boundary. Host CLI calls go through the command runner. Business logic stays
   pure and testable without a real host CLI.
5. **Verifiability.** Each proposed verifiable unit names the surface that proves
   it, with a fake host CLI and a fixture repository per format. No claim rests on
   a proxy.
6. **Scope honesty.** States what stays deferred, what the category does not do,
   and what breaks in the existing docs.

## Runners

| Seat | Model | Output |
|---|---|---|
| candidate-1 | `opus` | `.scratch/packages/arena/candidate-1/` |
| candidate-2 | `fable` | `.scratch/packages/arena/candidate-2/` |
| candidate-3 | `sonnet` | `.scratch/packages/arena/candidate-3/` |

Each candidate writes `design.md` (usage, types, signatures, module map) and
`rationale.md` (the rationale template) into its own directory. Candidates do not
edit anything outside their directory and do not modify `src/` or `tests/`.

## Cross-judge

One readonly judge on a model family different from the parent picks a base from
the three candidates against this rubric, and reports per-criterion scores with a
rationale. Cross-judge pool is `opus`, `fable`, `sonnet`.

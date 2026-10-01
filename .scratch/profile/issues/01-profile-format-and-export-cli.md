# 01: Profile format and `agent-depot export`

**What to build:** The versioned `agent-depot-profile/v1` format (strict parser and serializer in a core module) and `agent-depot export [--out <file>]` with filters (`--no-sources`, `--no-skills`, `--no-apps`, repeatable `--source/--skill/--app`), as defined in `.scratch/profile/spec.md`. Record the profile feature and the new TUI tab in an ADR.

**Blocked by:** None.

**Status:** completed

- [x] The profile contains Git Sources, user-global Skill selections (Source identity, path, version policy, Hosts, methods) and App recipe contents, and nothing machine-specific.
- [x] Local-path Sources, the built-in Source, unmanaged and App-owned Skills, approvals and installed state are excluded; the preview says why.
- [x] The parser rejects unknown versions, unknown fields, local paths and invalid recipes with field paths.
- [x] Export round-trips: parsing an exported profile yields the same content.

## Implementation evidence

- Core format/parser/serializer: `src/profile.ts`; read-only export plan:
  `src/profile-export.ts`; CLI filters/output: `src/profile-cli.ts`.
- Tests use public core and CLI seams with temporary state/recipe directories.
  TDD red runs covered the missing format/core, CLI dispatch, portability and
  credential/identity checks; `pnpm test:single tests/profile.test.ts`: 9 passed.
- `pnpm test:single tests/cli.test.ts`: 70 passed; version/help suite: 8 passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: passed (668 tests).
- Built CLI runtime harness: isolated HOME/XDG state, `node dist/src/cli.js export`,
  parsed stdout as an empty v1 profile and observed exclusion preview on stderr.
- ADR 0008 records the portable boundary, add-only import, machine-local approvals
  and approved fifth tab. Import/TUI/E2E remain tickets 02–04.
- Rollback boundary: remove the profile modules/tests and export CLI dispatch/help,
  shared credential helper, ADR 0008 and associated profile docs; no existing
  persistence schemas or installations were changed.

## Review

Reviewed `git diff c800aad...4761cde` against repository guidance and this ticket.
The environment exposes no sub-agent facility, so Standards and Spec were checked
locally, not as independent parallel reviews.

- **Standards:** no documented-standard violations. One advisory possible
  Duplicated Code smell: export wraps each candidate in the same minimal profile
  envelope to reuse validation. Retained as explicit validation rather than adding
  a generic abstraction.
- **Spec:** found root-only POSIX and root-relative Windows command paths bypassed
  free-text portability checks. Added a failing public-parser regression, fixed
  using Node path predicates, and reran all checks (668 tests passed). No remaining
  ticket-01 requirement gaps found. Import and the TUI are intentionally deferred.

### External review feedback applied

All should-fix items and nits from `p01-review.md` are addressed:
field-path Skill errors, prefix-free exclusion reasons, query credential keys
(including encoded/non-HTTP URLs), portable home-relative manual guidance and
regex patterns, existing-output protection/guidance, missing credential/version/
name-filter tests, and explicit CLI inclusion documentation. Canonical ordering,
missing-Source warnings, actual-only exclusions with named unmanaged Skills,
CLI help/import placement, test whitespace and `validateOne` are also corrected.

- TDD: new diagnostic, query credential, false-positive, existing-output,
  canonical-order and exclusion regressions failed before their fixes.
- `pnpm test:single tests/profile.test.ts`: 19 passed; CLI suite: 70 passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: passed (678 tests).
- Built CLI runtime harness: isolated HOME/XDG state reports `unmanaged-tool` by
  name; exporting again to an existing file exits 1, gives choose-another-path
  guidance and leaves the file byte-identical.
- Rollback boundary for review corrections: profile validation/diagnostics,
  canonicalization and export previews/tests/docs only; no persistence schemas,
  approvals, Skill contents or Host wiring changed.

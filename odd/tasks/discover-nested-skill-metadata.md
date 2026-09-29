# Discover skills with optional nested metadata

Goal: Recognize portable skill candidates with required top-level `name` and `description` plus optional nested frontmatter metadata, without weakening malformed required-field checks.
Source: user-approved correction after cached Matt Pocock `skills/engineering/pr/SKILL.md` was skipped.
TDD: not explicitly enabled; ordinary focused and full tests via pnpm.
Delivery: ask-on-risk; branch fix/discover-nested-skill-metadata; forecast under 150 authored lines.

- [x] Task 1 (delegated writer): Fix frontmatter parser with focused regression tests (nested optional metadata, malformed required values and indentation); verify cached `pr` discovery after build. Evidence: independent verifier `pnpm test` 159/159, `pnpm typecheck`, `pnpm lint`, `git diff --check` passed. Built CLI discovers `skills/engineering/pr`, raising Source candidate count from 30 to 31. Commit: pending.

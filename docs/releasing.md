# Releasing to npm

Agent Depot publishes `@iseoane/agent-depot` through GitHub Actions trusted publishing. The workflow does not store an npm token and does not change `package.json`. After npm reports the version as `latest`, it creates the annotated Git tag `v<version>` on the published commit and a GitHub Release for that tag, using the version's `CHANGELOG.md` section as its notes. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers) for the current registry requirements.

## Configure npm trusted publishing

In npmjs.com, open `@iseoane/agent-depot` settings and add a GitHub Actions trusted publisher with these exact values:

- Owner: `iseoane`
- Repository: `agent-depot`
- Workflow filename: `publish.yml`
- Environment name: leave empty
- Allow direct `npm publish`: enabled
- Allow `npm dist-tag`: disabled

Keep the package setting that requires two-factor authentication and disallows token-based publishing. Trusted publishing uses short-lived OIDC credentials and does not need `NODE_AUTH_TOKEN`.

A new trusted-publisher configuration expires unless its first successful publish completes within two days. The verification job does not exercise the npm publisher. The workflow publishes automatically after verification succeeds, so run it for the intended release within the two-day window. Do not use a test package version to validate OIDC.

The package's `repository.url` must continue to point to `https://github.com/iseoane/agent-depot`. npm uses that value to verify the repository identity.

## Prepare a release locally

Update `package.json` to the intended stable version and add the matching
changelog entry in the reviewed release change. Do not update dependencies to
prepare a patch release. From that checkout, run the same checks used by the
publish workflow:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm audit:dead-code
node --test scripts/release-artifact.test.mjs
node --test scripts/release-notes.test.mjs
pnpm test:skills
pnpm test:pack
```

`pnpm test:skills` runs each bundled skill's Python tests in a separate process
and disables bytecode writes. Check the compiled CLI version with
`pnpm build && node dist/src/cli.js --version`. It must print the version in
`package.json`. `pnpm test:pack` builds and smoke-tests the packed package. These
checks do not publish, tag, push, or dispatch the workflow.

After review, merge the release change to `main`. Only then follow [Publish a release](#publish-a-release) to manually dispatch the trusted-publishing workflow from `main`.

## Publish a release

1. Merge the release changes to `main`. Set `package.json` to the intended stable SemVer in a reviewed change. The release workflow never bumps the version.
2. In GitHub Actions, select **Publish to npm**, choose **Run workflow**, select `main`, and enter the exact `package.json` version, without a leading `v`.
3. Review the run. The verify job runs type checks, lint, unit tests, the TUI
   end-to-end tests, both Python doctor test suites, the dead-code audit,
   release-artifact tests and package smoke checks. The doctor test suites run
   in separate Python processes with bytecode writes disabled. The job packs and
   checks package identity, refuses a version already present on npm, and passes
   that exact tarball and its checksums to the publish job.
4. The publish job confirms the artifact came from the dispatched commit, checks the npm registry again, and publishes the tarball. It checks up to 48 times for npm to report the requested version as `latest` with the exact tarball integrity, waiting ten seconds between checks. Each registry request times out after 30 seconds, and GitHub ends the publish job after fifteen minutes.
5. After publication is verified, the tag job creates the annotated tag `v<version>` on the dispatched commit. It succeeds if that tag already points at the commit and refuses to move a tag that points elsewhere. It then creates the GitHub Release `v<version>`, titled `Agent Depot <version>` and marked latest, with the `## [<version>]` section of `CHANGELOG.md` as notes. An existing release is left unchanged, and a missing changelog section fails the job.

The workflow runs only when dispatched from `main`. It serializes releases without cancelling an active publish. A registry network error or unexpected HTTP response stops the run instead of treating the version as available. A post-publish timeout means publication may have succeeded; check npm before retrying. If the version is on npm but the run failed before tagging, create the annotated tag `v<version>` on the dispatched commit by hand. If it failed after tagging, create the release by hand with `gh release create v<version> --verify-tag --latest --title "Agent Depot <version>" --notes-file <notes>`.

The workflow uses Node 24 and npm 12.2.0. Trusted publishing requires npm 11.5.1 or later and Node 22.14.0 or later. npm 12.2.0 requires Node `^22.22.2`, `^24.15.0`, or `>=26.0.0`; `setup-node` resolves `24` to the latest Node 24 release. The workflow grants `id-token: write` only to the publish job and `contents: write` only to the tag job. It uses GitHub-hosted runners and does not set or consume `NODE_AUTH_TOKEN`.

# Releasing to npm

Agent Depot publishes `@iseoane/agent-depot` through GitHub Actions trusted publishing. The workflow does not store an npm token and does not change `package.json` or create a Git tag. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers) for the current registry requirements.

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

## Publish a release

1. Merge the release changes to `main`. Set `package.json` to the intended stable SemVer in a reviewed change. The release workflow never bumps the version.
2. In GitHub Actions, select **Publish to npm**, choose **Run workflow**, select `main`, and enter the exact `package.json` version, without a leading `v`.
3. Review the run. The verify job runs type checks, lint, tests, both Python doctor test suites, the dead-code audit, and package smoke checks. It packs and checks the package identity, refuses a version already present on npm, and passes that exact tarball and its checksums to the publish job.
4. The publish job confirms the artifact came from the dispatched commit, checks the npm registry again, and publishes the tarball. It checks up to 24 times for npm to report the requested version as `latest` with the exact tarball integrity, waiting five seconds between checks. Each registry request times out after 30 seconds, and GitHub ends the publish job after ten minutes.

The workflow runs only when dispatched from `main`. It serializes releases without cancelling an active publish. A registry network error or unexpected HTTP response stops the run instead of treating the version as available. A post-publish timeout means publication may have succeeded; check npm before retrying.

The workflow uses Node 24 and npm 12.2.0. Trusted publishing requires npm 11.5.1 or later and Node 22.14.0 or later. npm 12.2.0 requires Node `^22.22.2`, `^24.15.0`, or `>=26.0.0`; `setup-node` resolves `24` to the latest Node 24 release. The workflow grants `id-token: write` only to the publish job. It uses GitHub-hosted runners and does not set or consume `NODE_AUTH_TOKEN`.

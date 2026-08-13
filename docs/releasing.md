# Release Runbook

Novamira HQ releases are one serialized transaction in
`.github/workflows/release.yml`. A release tag is accepted only when its commit
is contained in `main`, its version equals `package.json`, and package acceptance
passes on that exact commit on Linux, macOS, and Windows. Prereleases publish
under `next`; only stable versions publish under `latest`.

## Repository Setup

Before creating a release tag:

1. Make this a public repository. npm provenance and the raw installer URLs both
   depend on public GitHub data.
2. Protect `main` and require the package workflow before merge.
3. Create the GitHub `npm-release` environment, restrict it to release tags, and
   require an approving reviewer.
4. After the package exists, configure npm trusted publishing for
   `use-novamira/novamira-hq`, workflow `release.yml`, environment `npm-release`.
5. Keep publication credentials and provider credentials out of repository and
   workflow variables. Normal releases authenticate only through GitHub OIDC.

All third-party actions in the publication workflow are pinned to reviewed
commit SHAs. Update those SHAs deliberately rather than replacing them with
movable major tags.

## First Publication

npm cannot configure a trusted publisher before `@novamira/hq` exists. The first
publication therefore uses one temporary, tightly scoped bootstrap token:

1. Create an npm granular access token for the Ovation publisher account with
   the minimum available package-creation scope and a short expiration.
2. Add it as the `NPM_BOOTSTRAP_TOKEN` secret on the protected `npm-release`
   environment. Do not add it as a repository or organization secret.
3. Create and push the reviewed release tag on the current `main` commit.
4. Cancel the automatic tag-triggered run before it enters the protected
   environment; without the bootstrap input it is intentionally unable to use
   the token.
5. Manually dispatch `Publish public package` for that existing tag with
   `bootstrap` enabled. Approve the environment only after checking the tag and
   commit shown by the run.
6. Confirm npm shows the exact version and provenance, and GitHub has the release
   with both installer assets.
7. Configure the npm trusted publisher as described above.
8. Delete `NPM_BOOTSTRAP_TOKEN` from GitHub and revoke the token at npm.

Never enable bootstrap for an existing package. The workflow refuses to replace
an exact version whose tarball integrity differs from the tagged commit.

## Normal Release

1. Confirm the package workflow passed on the exact current `main` commit.
2. Create and push `v<package version>` at that commit.
3. Approve the `npm-release` environment after the workflow's three-platform
   acceptance job passes.
4. Confirm the exact npm version, provenance, dist-tag, and GitHub installer
   assets.

Rerunning the workflow is safe after a partial failure. If npm already holds the
exact candidate integrity, publication is skipped and verification, installed
package acceptance, and GitHub release creation continue. A different integrity
fails closed. Serialization and the dist-tag monotonicity check prevent an older
run from moving `latest` or `next` backward.

## Accepted Risks

- Installer and launcher behavior remains primarily statically tested; package
  installation and executable acceptance do run on all three target systems.
- Windows ACL and doctor-repair behavior is not covered by the full POSIX-heavy
  contract suite.
- README installer URLs follow mutable `main` rather than a release asset.
- Runtime dependency ranges can resolve newer compatible dependency graphs than
  the release lockfile.

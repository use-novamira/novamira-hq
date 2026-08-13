# Novamira HQ Release Defects

Review date: 2026-08-13

Status: release blocked

This document records defects found during a release-candidate review of the
current `main` branch. The review covered the CLI, configuration and credential
storage, hosting clients, provisioning, dashboard, site CLI integration,
self-update, installers, packaging, and release workflows.

## Verification Baseline

- `bun run check`: passed, 945 tests.
- `bun run pack:inspect`: passed, 507 files and 2.74 MB unpacked.
- `bun run package:acceptance`: passed on Linux.
- The npm registry returned 404 for `@novamira/hq` at review time.
- No live provider API calls were made.
- Windows and macOS installer execution was not available from the Linux review
  environment.

A green baseline does not clear the release: several tests currently omit the
failing scenario, and some tests enforce behavior that conflicts with the
repository's governing boundary rules.

## Release Blockers

### DEF-001: Initial npm publication cannot use the configured OIDC workflow

Severity: critical

References: `.github/workflows/release.yml:21-45`, `package.json:39-42`

The release workflow relies exclusively on npm trusted publishing. The package
does not yet exist in the public registry, but npm trusted-publisher settings
cannot be configured until after a package exists. The first tag therefore
cannot be published by the current workflow.

Impact: the first public release fails at `npm publish`.

Required resolution: bootstrap the package manually or with a tightly scoped
token, then configure the repository, workflow, and `npm-release` environment as
the trusted publisher before using the OIDC-only workflow.

### DEF-002: Compatibility probing violates the site-request boundary

Severity: critical

References: `src/provisioning/compatibility.ts:614-707`,
`src/provisioning/compatibility.ts:820-846`,
`test/provisioning-contract.test.mjs:674-824`, `AGENTS.md`

The governing boundary permits one unauthenticated GET to
`{siteUrl}/.well-known/oauth-protected-resource`. The implementation follows up
to three same-origin redirects and retries transport errors, 404, 408, 429, and
5xx responses. One setup can therefore issue multiple requests and can request
paths other than the permitted well-known path.

Impact: HQ exceeds its explicitly bounded WordPress-site access and can contact
site URLs it is forbidden to request.

Test gap: current compatibility tests affirmatively require redirects and
retries, so they encode behavior that conflicts with the boundary rule.

### DEF-003: macOS stored credentials are exposed in process arguments

Severity: high

References: `src/credentials/keychain-backends.ts:198-225`

The macOS keychain backend invokes `security add-generic-password` with the
serialized provider credential as the value following `-w`. The secret is
therefore present in the child process's argv.

Impact: same-user process inspection, endpoint monitoring, crash collection, or
command auditing can capture provider credentials. This contradicts the rule
that provider secrets never appear in argv.

Test gap: credential tests do not assert the arguments used by
`MacOsKeychainBackend.replace`.

### DEF-004: Windows self-update cannot execute npm

Severity: high

References: `src/update/install.ts:81-126`,
`test/update-contract.test.mjs:256-261`

Windows selects `npm.cmd`, then `SpawnInstallRunner` invokes it with
`shell: false`. Windows `.cmd` files are not directly executable this way;
Node.js requires `cmd.exe`, a shell, or the underlying JavaScript entry point.

Impact: both `novamira-hq update` and the dashboard update action fail on
Windows before npm starts.

Test gap: the update test checks only the generated command name and uses a fake
runner. It never executes the production runner on Windows.

### DEF-005: Carriage returns permit SSE framing injection

Severity: high

References: `src/web/html.ts:157-183`, `src/web/sse.ts:119-127`,
`node_modules/@starfederation/datastar-sdk/esm/abstractServerSentEventGenerator.js:54-68`

HTML escaping leaves carriage return characters unchanged. The Datastar SDK
splits element markup only on line feed before prefixing SSE data lines, while
browsers treat carriage return as an SSE line delimiter. Provider- or site
CLI-controlled display text can therefore introduce additional SSE fields and
Datastar events.

Impact: malicious remote text can select and replace or remove arbitrary
dashboard DOM targets. Direct script injection was not established, but the
dashboard's intended output boundary is bypassed.

Test gap: SSE tests cover normal text and line feeds, but not CR or CRLF input
from provider-controlled fields.

### DEF-006: Concurrent setup requests can provision one environment twice

Severity: high

References: `src/web/services/setup-jobs.ts:245-303`,
`test/web-setup-contract.test.mjs:463-482`

`start()` checks for a running target before awaiting
`hosting.clientFromProfile()`. Two requests can both observe no existing job,
await client creation, then register different jobs and launch two detached
`provisionNovamira()` runs against the same environment.

Impact: plugin installation, activation, option writes, provider operations,
and compatibility checks can race on one site. A double click can trigger the
condition.

Test gap: the existing test starts its second request only after the first job
has already been registered.

### DEF-007: Unsafe config files can redirect provider credentials

Severity: high

References: `src/config/profiles.ts:133-173`,
`src/config/schema.ts:380-389`, `src/hosting/factory.ts:137-169`,
`src/hosting/http-client.ts:376-389`

Normal config loading does not verify ownership, permissions, or parent
directory safety. A local principal able to modify `config.json` can retain an
existing credential reference while changing `apiBaseUrl` to an
attacker-controlled HTTP or HTTPS origin. The next provider command resolves
the credential and sends it to that origin.

Impact: provider credential exfiltration.

Test gap: doctor detects unsafe permissions, but no test proves ordinary
commands fail closed when config storage is unsafe.

### DEF-008: Release workflow cannot recover from partial publication

Severity: high

References: `.github/workflows/release.yml:42-80`

The workflow publishes to npm before registry propagation checks, installed
package acceptance, and GitHub release creation. If a post-publication step
fails, npm retains the immutable version and the GitHub release is skipped. A
workflow rerun attempts to publish the same version and fails before it can
repair the missing release.

Impact: npm can contain a version with no corresponding GitHub release or
installer assets, with no normal rerun path to complete the release.

Required resolution: make publication idempotent by detecting and verifying an
already-published exact version, or create a draft GitHub release before npm
publication and finalize it after acceptance.

### DEF-009: Stale-lock recovery can create multiple lock owners

Severity: high

References: `src/config/lock.ts:86-131`, `src/config/lock.ts:146-168`

Two processes can inspect the same stale lock. Process A can delete it and
acquire a new lock before process B executes its already-decided unlink. Process
B then deletes A's new lock and acquires another one. Both processes believe
they own the lock.

Impact: concurrent config read-modify-write operations can lose updates, and
credential/config transactions can become inconsistent.

Test gap: existing concurrency tests cover in-process queuing, not stale-lock
recovery across independent lock managers.

### DEF-010: Secret-bearing provider payloads can be returned unredacted

Severity: high

References: `src/cli/payloads.ts:173-225`,
`src/hosting/providers/kinsta.ts:728-742`,
`src/hosting/types.ts:304-313`, `src/output/render.ts:173-210`

Commands send values such as WordPress admin passwords, SFTP passwords, and
private SSL keys. Several clients register only the provider authentication
credential as a known secret. Successful provider data is serialized through
`ActionResult.raw` without universal secret-key redaction. Error messages are
also redacted only against registered secrets.

Impact: a provider or proxy that echoes a request secret can expose it in JSON
stdout, human output, or an error.

Test gap: affected provider fixtures do not echo request secrets in successful
or failed responses.

## High-Priority Defects

### DEF-011: Warm-cache site lookup ignores profile ownership

Severity: high

References: `src/web/services/sites.ts:531-547`

When profile-specific cache lookup misses, `resolveSite()` scans the all-profile
cache without checking `group.profile === profile`. Provider-scoped site IDs are
not guaranteed to be globally unique.

Impact: a deploy-path form can show and persist environments belonging to a
different provider profile while retaining the requested profile name.

### DEF-012: Environment display lookup ignores profile and site ownership

Severity: high

References: `src/web/services/sites.ts:511-528`,
`src/web/server.ts:537-549`, `src/web/views/types.ts:303-331`

`envResolver()` creates one map keyed only by environment ID. A later provider
with the same environment ID silently replaces an earlier entry. Deploy paths
carry profile and site ownership, but that ownership is not part of lookup.

Impact: existing deploy paths can display another provider's environment name
or domain, and ambiguous IDs can contribute to operations targeting unintended
resources.

### DEF-013: Cache invalidation can be undone by an older in-flight load

Severity: medium

References: `src/web/services/sites.ts:328-351`,
`src/web/services/sites.ts:389-419`, `src/web/services/sites.ts:501-507`

`invalidate()` clears current cache state but does not version outstanding
`fill()` or `refreshInventory()` operations. An operation started before
invalidation can complete afterward and repopulate stale inventory or profile
links.

Impact: a removed or edited provider profile can remain visible and usable from
warm state for another cache lifetime.

### DEF-014: Global `--timeout` is ignored by provider HTTP requests

Severity: medium

References: `src/cli/program.ts:21-52`,
`src/cli/hosting-command.ts:100-108`, `src/main.ts:201-217`

Commander parses and forwards the global timeout, but the hosting factory is
created with fixed HTTP defaults and `runHostingCommand()` does not apply the
requested value.

Impact: hosting commands can run far beyond an explicitly requested timeout,
making automation deadlines unreliable.

Test gap: tests verify that handler options receive the value, not that HTTP
requests honor it.

### DEF-015: Plugin source network operations are unbounded

Severity: medium

References: `src/provisioning/plugin.ts:142-181`,
`src/provisioning/plugin.ts:207-231`

Latest-release resolution and remote-source HEAD validation have no total
deadline, body ceiling, or explicit redirect policy. `response.json()` buffers
the complete release response.

Impact: plugin installation can hang indefinitely, follow unwanted redirects,
or consume excessive memory before any provider operation starts.

### DEF-016: Operation polling can succeed after its deadline

Severity: medium

References: `src/hosting/operations.ts:44-76`

Polling checks `status.done` and `status.failed` before checking elapsed time.
It also sleeps the full interval without clamping it to the remaining budget and
can start another provider request after the deadline.

Impact: `--timeout-seconds` is not an upper bound and can report success for an
operation that completed after the requested budget.

### DEF-017: HTTP total timeout can be lengthened unexpectedly

Severity: low

References: `src/hosting/http-client.ts:360-374`

The deadline uses `Math.max(timeoutMs, totalTimeoutMs)`. A requested total
timeout shorter than the per-attempt timeout is therefore ignored.

Impact: callers cannot enforce a total request budget shorter than one attempt.

### DEF-018: Integration timeouts do not terminate descendant processes

Severity: medium

References: `src/integration/spawn.ts:132-217`

Timeout and abort handling signal only the direct child. Descendants that keep
inherited stdout or stderr pipes open can prevent the `close` event and keep the
promise pending after the direct child is killed.

Impact: site CLI operations can exceed their documented timeout indefinitely.

### DEF-019: Active setup jobs survive dashboard shutdown

Severity: medium

References: `src/web/services/setup-jobs.ts:279-303`,
`src/web/server.ts:930-941`, `src/provisioning/setup.ts:137-149`

Detached setup jobs have no shutdown method or abort controller. Closing the
dashboard server does not cancel or await active provisioning.

Impact: provider and site mutations can continue invisibly after the operator
believes HQ has stopped, and active handles can delay process termination.

### DEF-020: Setup-job capacity is not enforced for running jobs

Severity: medium

References: `src/web/services/setup-jobs.ts:204-215`,
`src/web/services/setup-jobs.ts:264-277`

Eviction refuses to remove running jobs. If all retained jobs are running,
`evict()` returns without making room and `start()` inserts another job anyway.

Impact: the documented process-lifetime bound can be exceeded without limit,
along with provider requests, timers, sockets, and event logs.

### DEF-021: Private secret output is not atomic or symlink-safe

Severity: medium

References: `src/cli/inputs.ts:119-130`,
`src/cli/hosting/access.ts:268-283`

Secret output opens the destination directly with `"w"`, follows an existing
symlink, and tightens permissions only after writing. An existing permissive
file can expose the new secret during the write.

Impact: generated SSH or SFTP credentials can be disclosed, overwrite a symlink
target, or remain partially written after interruption.

### DEF-022: CLI secret input is unbounded and does not verify source safety

Severity: medium

References: `src/cli/inputs.ts:88-117`, `src/cli/inputs.ts:286-349`

The CLI drains all stdin or reads a complete named file without the credential
API's 64 KiB ceiling. Named secret files are consumed without owner or
permission verification.

Impact: a mistaken or hostile input can exhaust memory, and HQ can persist a
secret read from unsafe local storage.

### DEF-023: Secret-bearing URLs can appear in failure messages

Severity: medium

References: `src/provisioning/plugin.ts:207-230`,
`src/provisioning/compatibility.ts:600-609`,
`src/output/render.ts:130-145`, `src/output/render.ts:205-210`

Plugin source and metadata URLs are interpolated into `CliError.message`.
Failure rendering redacts `details` but emits messages unchanged.

Impact: signed URL query parameters or URL userinfo can be written to stdout,
stderr, CI logs, and agent transcripts.

### DEF-024: Malformed stale locks are never recovered

Severity: medium

References: `src/config/lock.ts:146-168`

If a process dies after creating a lock but before writing valid JSON, later
acquisitions receive a parse error. `isRecoverable()` treats only `ENOENT` as
recoverable in that path, regardless of file age.

Impact: config, credentials, deploy paths, or update state can remain blocked
until the lock file is manually removed.

### DEF-025: Installer smoke tests accept a failed doctor report

Severity: medium

References: `install.sh:158-160`, `install.ps1:89-90`,
`src/doctor/engine.ts:37-42`

Doctor intentionally exits zero whenever it produces a report, including when
the overall status is `fail`. Both installers check only the process exit code.

Impact: installation can be announced as successful despite failed integrity,
storage, or configuration checks.

### DEF-026: Doctor can report `fixed: true` when repair did not succeed

Severity: medium

References: `src/doctor/checks.ts:352-408`,
`src/doctor/checks.ts:423-464`

The permissions check marks `fixed` after attempting repairs even if
reinspection still fails. The atomic-storage check reports `fixed: true`
whenever `--fix` was supplied, including when no state changed.

Impact: operators and JSON consumers receive false evidence that a repair was
performed successfully.

## Release and Contract Defects

### DEF-027: Package version conflicts with the normative v1 contract

Severity: high

References: `package.json:2-3`, `src/version.ts:17-18`,
`docs/v1-contract.md:1-13`

The package and executable report `0.1.0`, while the normative document freezes
behavior for major version 1 and says every section is implemented.

Impact: the first public SemVer identity contradicts its compatibility promise.
The release must either be `1.0.0` or explicitly redefine the contract as
pre-1.0.

### DEF-028: Site-profile architecture has two conflicting definitions

Severity: high

References: `AGENTS.md`, `src/web/routes.ts:249-258`,
`src/web/views/pages.ts:34-40`, `docs/v1-contract.md:894-970`

`AGENTS.md` requires `/site-profiles` as a separate page with an independent
`#cli-sites` fragment. The implementation and v1 contract instead combine site
CLI profiles into `/sites`; `/site-profiles` returns 404. Source comments still
describe the separate page in places.

Impact: the repository has incompatible authoritative descriptions of the
shipped dashboard surface. One design must be selected and the code, tests,
contract, and repository instructions aligned before release.

### DEF-029: Prerelease tags are published as `latest`

Severity: medium

References: `.github/workflows/release.yml:10-13`,
`.github/workflows/release.yml:44-45`

Every `v*` tag is published with `--tag latest`, including versions such as
`v1.1.0-rc.1`. There is also no release concurrency or monotonic-version check.

Impact: stable users can be directed to a prerelease, and concurrent workflows
can move `latest` backward.

### DEF-030: Release publication is not gated by cross-platform acceptance

Severity: medium

References: `.github/workflows/package.yml:10-69`,
`.github/workflows/release.yml:10-41`

The Linux/macOS/Windows package matrix runs on branch pushes and pull requests,
not release tags. The release workflow accepts any `v*` tag and reruns checks
only on Ubuntu.

Impact: npm can receive a tag that is not on protected `main` or has not passed
the current Windows and macOS package matrix.

### DEF-031: Release documentation still describes an unreleased package

Severity: medium

References: `README.md:16-21`, `README.md:46-49`, `CHANGELOG.md:3-7`

The README says no release has been published and uses future-tense installation
wording. The changelog contains only an `Unreleased` section.

Impact: the npm package and source repository would immediately contain false
release-state documentation.

### DEF-032: README dashboard page count conflicts with the contract

Severity: low

References: `README.md:29-32`, `docs/v1-contract.md:3-8`

The README claims eight dashboard pages, while the normative contract declares
seven shipped pages.

## Lower-Priority Defects

### DEF-033: Malformed bracketed Host authorities can pass validation

Severity: low

Reference: `src/web/server.ts:586-629`

A bracketed Host with an invalid suffix can be interpreted as a loopback host
without a port instead of being rejected as malformed.

Impact: the loopback authority parser does not fully fail closed. Standard
browsers do not normally generate this form, so practical exploitability was
not established.

### DEF-034: Site CLI profile names are not validated when parsing listings

Severity: low

References: `src/integration/site-cli.ts:284-301`,
`src/integration/connection.ts:374-407`,
`src/integration/profiles.ts:299-315`

User action inputs are validated, but names returned by `sites list` are
accepted when merely non-empty and later reused as the argument to `--site`.

Impact: malformed or incompatible site CLI output can alter command parsing
instead of being classified as malformed output. No shell injection occurs.

### DEF-035: Persisted stored credential IDs use weaker validation

Severity: low

References: `src/config/schema.ts:425-435`,
`src/credentials/store.ts:24-25`, `src/credentials/store.ts:106-113`

Config parsing accepts any control-free stored ID up to 256 characters, while
the credential store requires a 64-character lowercase hexadecimal ID.

Impact: invalid persisted configuration passes schema validation and fails only
when the credential is used, with less useful error classification.

## Additional Release Risks

These items are not proven application defects but should be resolved or
explicitly accepted before release.

- The repository must be public before tagging if npm provenance and the raw
  installer URLs are expected to work.
- Installer and launcher creation is checked mostly through static assertions;
  the scripts are not executed end to end on each target platform in CI.
- Windows ACL creation, verification, and doctor repair are not exercised by
  the full contract suite.
- GitHub Actions in publication-authorized workflows use movable major tags
  rather than reviewed commit SHAs.
- The documented installer URLs point at mutable `main` files rather than
  release-bound assets.
- Runtime dependency ranges and the third-party skills CLI's transitive ranges
  allow users to install dependency graphs different from the graph tested for
  this release.

## Recommended Release Gate

Do not tag a release until all release blockers are closed, focused regression
tests cover their failing scenarios, the package version and contract agree,
the first-publication procedure is rehearsed, and the Linux/macOS/Windows
package matrix passes on the exact release commit.

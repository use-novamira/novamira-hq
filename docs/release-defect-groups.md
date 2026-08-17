# Release Defect Implementation Groups

This document groups the defects in `docs/release-defects.md` into practical
agent sessions. Each defect is assigned to exactly one session. The groups favor
shared implementation context and shared regression tests over severity alone.

The final group intentionally combines unrelated fixes because each is small,
localized, and independently testable.

## Suggested Order

1. Resolve Session 1's site-profile architecture decision before changing the
   affected dashboard surface.
2. Resolve Session 2's release identity before finalizing publication and
   release documentation in Sessions 3 and 4.
3. Run Sessions 5 and 6 serially because both can change provisioning errors and
   tests.
4. Run Sessions 10 and 17 serially because both can touch dashboard server
   tests.
5. The other implementation sessions can generally proceed in parallel, subject
   to normal file-conflict coordination.
6. Run the full release gate after all sessions have merged.

## Session 1: Site-Profile Architecture (Done)

Defects: **DEF-028**

Decision: keep the implemented combined `/sites` surface as the v1 architecture.
Hosting environments and site-CLI profiles form one inventory; matched profiles
appear on their hosting-environment rows and unmatched profiles appear in the
CLI-only group. There is no `/site-profiles` page. The
`/_dashboard/site-profiles/*` paths remain action routes for profiles owned by
the site CLI, not page routes or profiles stored by HQ.

Completed by aligning the repository instructions and source comments and by
removing dead separate-page fragment, back-link, and cache-inversion artifacts.

## Session 2: Release Identity (Done)

Defects: **DEF-027**

Decision: the first stable public release is `1.0.0`, and release candidates use
the `1.0.0-rcN` line. The current package and executable version is
`1.0.0-rc1`. These candidates implement the normative v1 contract; they do not
redefine it as a pre-1.0 contract.

Completed by aligning the package version, executable version, contract
language, and direct version assertion. Publication workflows must preserve
this identity, publish release candidates under a prerelease dist-tag, and
reserve `latest` for stable releases.

## Session 3: Publication Workflow Safety (Done)

Defects: **DEF-001, DEF-008, DEF-029, DEF-030**

These defects describe one release transaction and should be designed together:

- Provide and document a safe first-publication bootstrap path before OIDC-only
  trusted publishing can work.
- Make reruns recover from an exact version that reached npm before later steps
  failed.
- Publish prereleases under an appropriate dist-tag and prevent concurrent or
  older releases from moving `latest` backward.
- Gate publication on the exact release commit and the Linux, macOS, and Windows
  package acceptance matrix.

Completed with a serialized, exact-commit release transaction that gates npm on
Linux, macOS, and Windows acceptance, selects monotonic `next` or `latest`
dist-tags, verifies an existing exact tarball on reruns, and repairs an existing
GitHub release. A tested metadata gate, SHA-pinned actions, and a release runbook
cover the one-time protected token bootstrap, trusted-publisher handoff,
repository visibility, and explicitly accepted residual risks.

## Session 4: Release-State Documentation (Done)

Defects: **DEF-031**

Completed by identifying `1.0.0-rc1` as the current v1 release candidate in the
README, changing installation language from future to present tense, and moving
the initial package notes under a dated `1.0.0-rc1` changelog heading while
retaining `Unreleased` for subsequent changes.

## Session 5: Provisioning Network Boundaries (Done)

Defects: **DEF-002, DEF-015**

Both defects govern outbound HTTP performed before or during provisioning.
Implement one explicit network policy covering deadlines, response-size limits,
and redirects:

- Compatibility probing must perform only the single permitted unauthenticated
  GET to the exact well-known URL, with no retry or redirect follow-up.
- Plugin release lookup and remote-source validation need bounded time and body
  consumption plus an explicit redirect policy.

Replace tests that currently require compatibility retries and redirects with
boundary-enforcing regression tests. Keep provider API behavior outside this
session.

Completed with a single-request compatibility probe that never retries or
follows redirects, while retaining its total deadline and streamed body limit.
Plugin release lookup and remote-source validation now use explicit deadlines
and manual redirects; release metadata is streamed with a fixed size ceiling.

## Session 6: Secret-Safe Provider Output (Done)

Defects: **DEF-010, DEF-023**

Treat request secrets and secret-bearing URLs as sensitive across both success
and failure output. The fix should establish a single understandable redaction
path rather than adding provider-specific string replacements:

- Register or structurally redact sensitive action inputs before serializing
  `ActionResult.raw` or provider errors.
- Ensure error messages as well as error details cannot expose URL userinfo or
  query secrets.
- Add fixtures in which providers echo request secrets in successful and failed
  responses.

This session may touch provisioning files also used by Session 5, so the two
should be performed serially.

Completed with provider-neutral sensitive-value tracking across request bodies,
provider responses, asynchronous operations, raw reads, semantic errors, and
setup results. The shared output redactor now removes known literals,
secret-shaped fields, URL userinfo, and encoded signed-query values from both
success and failure surfaces. Provider fixtures cover successful and failed
secret echoes without changing the values sent on the wire.

## Session 7: Local Secret I/O (Done)

Defects: **DEF-003, DEF-021, DEF-022**

These defects all concern moving secrets across local process and filesystem
boundaries:

- Feed macOS keychain values without placing them in child argv.
- Write private secret output atomically, without following symlinks, and with
  owner-only permissions in force before content is exposed.
- Bound stdin and named-file reads to the credential size ceiling and reject
  unsafe named secret files.

Use shared secure-file primitives where they already exist instead of creating a
second permissions or atomic-write implementation. Add focused runner and file
safety tests, with platform-specific behavior injected where necessary.

Completed with a fixed macOS Security.framework bridge that sends credential
content over stdin, bounded stdin and owner-only regular-file secret reads that
reject symlinks, and atomic private output whose temporary file is secured
before content is written. Regression tests cover argv isolation, size and file
safety boundaries, symlink replacement, and pre-write permissions.

## Session 8: Config Trust Boundary (Done)

Defects: **DEF-007**

Make ordinary config consumers fail closed before resolving credentials when the
config file or its parent storage is unsafe. This needs a deliberate policy for
ownership, permissions, symlinks, missing paths, and platform behavior, followed
through config loading, hosting client creation, doctor reporting, and contract
tests.

Keep this high-impact change isolated: an overly broad check could make all
commands unusable, while an incomplete check leaves credential redirection
possible.

Completed with fail-closed checks on the config file and its immediate parent
before reads and replacements. Existing storage must be owner-only, owned by the
current user, and have the expected regular file or directory type; symlinks and
verification failures are refused on Unix and Windows. Missing storage remains
an empty configuration and is created securely on first write. Regression tests
prove an unsafe attacker-controlled API origin is rejected before credential
resolution, doctor reports and repairs unsafe storage, and dashboard fixtures
exercise the production private-write path.

## Session 9: Lock Recovery Correctness (Done)

Defects: **DEF-009, DEF-024**

Redesign stale-lock recovery as one concurrency problem:

- A recovery attempt must not unlink a replacement lock created after the stale
  lock was inspected.
- An old malformed or partially written lock must be recoverable without making
  a fresh malformed lock unsafe to steal.

Regression tests should use independent lock managers and controlled
interleavings, not only in-process queueing. Both defects must be fixed under the
same ownership protocol so malformed-lock handling does not reintroduce the
multiple-owner race.

Completed with unique owner tokens, atomically published recovery claims tied to
the inspected filesystem identity, and ownership verification before entering
or releasing a critical section. Old malformed locks and abandoned recovery
claims are recoverable while fresh or live claims remain protected. Controlled
independent-manager tests cover concurrent stale recovery, malformed lock age,
replacement races, and obsolete releases.

## Session 10: Setup-Job Concurrency and Lifecycle (Done)

Defects: **DEF-006, DEF-019, DEF-020**

Treat setup jobs as one bounded registry with atomic target reservation,
capacity enforcement, and shutdown ownership:

- Reserve a target before the first asynchronous client-creation step so two
  requests cannot launch duplicate provisioning.
- Reject or queue new work when all capacity is occupied by running jobs; never
  exceed the configured bound.
- Give active jobs cancellation and shutdown semantics, and make dashboard
  shutdown cancel and await them appropriately.

Tests should cover concurrent starts before client resolution, all-running
capacity, cancellation, and server shutdown. Preserve the rule that the service
calls `provisionNovamira` whole rather than copying its sequence.

Completed with synchronous target and capacity reservations, bounded running
work, and an idempotent registry shutdown that cancels and awaits both pending
client resolution and active provisioning. Cancellation now reaches plugin and
compatibility HTTP, provider-operation polling, and every boundary between
WP-CLI actions. Dashboard shutdown owns that lifecycle even without a listener,
and regression tests cover pre-resolution duplicate starts, saturated capacity,
late client resolution, history retention, polling cancellation, and server
shutdown.

## Session 11: Dashboard Cache Identity and Generations

Defects: **DEF-011, DEF-012, DEF-013**

Fix cache keys and invalidation together because both determine whether a warm
entry still represents the requested resource:

- Key site and environment resolution by the full provider profile, site, and
  environment ownership needed by deploy paths.
- Remove fallback lookup that crosses profile ownership.
- Add a generation or equivalent commit guard so work started before
  invalidation cannot repopulate current cache state or profile links.

Use fixtures with duplicate provider-scoped IDs and delayed loads that complete
after invalidation. Do not add another domain-origin matching implementation.

## Session 12: Hosting Timeout Semantics

Defects: **DEF-014, DEF-016, DEF-017**

Define and enforce one end-to-end timeout budget for hosting commands:

- Propagate the global CLI `--timeout` into provider HTTP behavior.
- Make operation polling check and clamp against the remaining budget before
  sleeping or starting another request.
- Honor a total timeout shorter than the per-attempt timeout rather than
  extending it with `Math.max`.

Use fake clocks and injected HTTP behavior to test exact deadline edges without
live provider calls. The tests should demonstrate that no request starts after
the deadline and no completion after the deadline is reported as in-budget.

## Session 13: Site CLI Process-Tree Timeouts

Defects: **DEF-018**

Update the integration spawn seam so timeout and abort handling terminate the
owned process tree and settle even when descendants retain inherited pipes.
Preserve argv arrays, `shell: false`, bounded output, and the existing
classification behavior.

This deserves a focused session because process-group behavior differs across
Unix and Windows and an incorrect fix can leak children or kill unrelated
processes.

## Session 14: Windows npm Self-Update

Defects: **DEF-004**

Provide a Windows-compatible way for the production update runner to invoke npm
without weakening argument safety on other platforms. Test the actual runner
construction or an equivalent executable seam, not only the command name handed
to a fake runner. Preserve the rule that installer output does not cross into
CLI or dashboard output.

Keep this separate from release publication: it concerns the installed
application's updater, not the GitHub Actions publishing path.

## Session 15: Doctor and Installer Verification

Defects: **DEF-025, DEF-026**

Make repair reporting truthful first, then make both installers inspect the
doctor report rather than treating every produced report as healthy:

- Set `fixed: true` only when a requested repair changed state and reinspection
  proves the relevant condition now passes.
- Preserve doctor's contract that a produced report exits zero.
- Have installer smoke tests request machine-readable output and reject an
  overall `fail` status while allowing `warn`.

Update shell and PowerShell tests together so the two installers retain matching
acceptance behavior.

## Session 16: SSE Framing Safety

Defects: **DEF-005**

Normalize or reject every SSE line delimiter before provider- or site
CLI-controlled text reaches the Datastar SDK. Cover lone carriage returns,
carriage-return/line-feed pairs, and line feeds in rendered fragments, and prove
that each emitted line remains an SSE `data` line rather than becoming an
attacker-selected field or event.

Keep this as a focused security session because the escaping and framing layers
must agree on where normalization occurs, and a broad HTML escaping change could
alter non-SSE rendering.

## Session 17: Quick, Unrelated Fixes

Defects: **DEF-032, DEF-033, DEF-034, DEF-035**

These fixes do not share a subsystem, but each is narrow enough to complete and
verify in one agent session:

- **DEF-032:** correct the README dashboard page count after Session 1 settles
  the shipped page architecture.
- **DEF-033:** reject malformed suffixes on bracketed Host authorities and add
  parser cases for valid and invalid bracket/port combinations.
- **DEF-034:** validate profile names returned by `sites list` before reusing
  them in `--site` argv, classifying invalid names as malformed CLI output.
- **DEF-035:** make persisted stored-credential ID validation match the store's
  64-character lowercase hexadecimal grammar.

Keep each fix as a separate commit or clearly separated patch within the agent
session so one can be reverted without coupling unrelated behavior.

## Coverage Check

The sessions assign all 35 recorded defects exactly once:

`DEF-001` through `DEF-035`, with no omissions or duplicate ownership.

After the focused tests for each session pass, run `bun run check`. Also run
`bun run pack:inspect` and `bun run package:acceptance` for Sessions 2, 3, 4,
14, 15, and 17 when their changes affect package contents, installers, or
release-facing documentation.

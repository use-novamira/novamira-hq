# Desktop-only distribution and local agent setup

## Goal

Ship Novamira HQ only as a desktop application. The installed application also
provides a supported, headless CLI and MCP server for local agents. There is no
separately published HQ npm package and no external Node, npm, or Deno runtime
requirement for end users.

This plan is split into four sequential implementation sessions. Each session
should read this document and `AGENTS.md`, inspect the current implementation,
and record its completed work, verification, and remaining decisions in the
handoff section below. Do not assume findings from this plan replace inspection.

## Agreed product direction

- One desktop installation supplies the UI, `novamira-hq` CLI, MCP, and the
  pinned public Novamira site CLI. CLI and MCP work with the window closed.
- `novamira-hq site-cli <arguments...>` is the supported shell entry point to
  the bundled site CLI. Preserve arguments, streams, cancellation, and exit codes.
- Register the terminal command automatically where the installation method
  supports it; otherwise offer registration on first launch. Settings exposes
  status and repair. Registration must tolerate app relocation and upgrades.
- A “Connect your agents” flow enables command access and installs lightweight
  hosting and site entry-point skills for user-selected agents at user scope.
- Prefer bundling the existing skill registrar over implementing agent-specific
  skill directory conventions in HQ. Validate that approach first.
- Detailed hosting guidance comes from HQ; detailed site guidance remains owned
  by the bundled site CLI. Entry-point skills load version-matched guidance at
  runtime rather than duplicating extensive documentation.
- Desktop releases become the single HQ update source. Building a complete
  automatic desktop updater is outside this plan; see
  `pending-desktop-updates.md` for that separate decision.

## Existing starting points

- `desktop/main.ts` already provides window, `--serve`, `--cli`, `--mcp`, and
  embedded `--site-cli` roles. Reuse the existing composition and child-process
  seams rather than creating another implementation of the commands.
- `skills/novamira-hq/SKILL.md` is a small entry-point skill that loads
  `novamira-hq skills get core`.
- `install.sh` currently installs the HQ skill through pinned
  `skills@1.5.18`, invoked with `npx`, using the npm-installed HQ package as the
  source. Inspect `install.ps1` for equivalent behavior.
- `package.json`, release workflows, installers, documentation, and acceptance
  scripts currently support public HQ npm distribution.
- Existing repository rules assign skill registration to `npx skills add`, keep
  `src/skills/` read-only, and restrict runtime dependencies. Revise those rules
  explicitly where the approved bundled registrar requires it; retain the
  architectural boundaries and keep installation orchestration outside the
  read-only skill guidance module.

## Session 1 — Validate and bundle the skill registrar

**Outcome:** a compiled desktop executable can register a bundled skill without
external Node/npm/Deno or dependency caches.

### Work

- Inspect the pinned `skills` package: supported programmatic or CLI entry
  points, runtime assumptions, subprocesses, agent selection, local sources,
  copy/symlink behavior, telemetry, update checks, and install/remove semantics.
- Inspect the bundled site CLI's entry-point skill and guidance commands. Decide
  how to preserve its ownership while making all executable examples work via
  `novamira-hq site-cli`. Do not assume its current guidance supports a command
  prefix without verifying it.
- Prototype an isolated embedded registrar role using the desktop runtime and
  a pinned dependency. Reuse child-process lifecycle patterns: bounded capture,
  cancellation, timeout, and whole-process-tree termination where applicable.
- Register from local, version-matched skill assets. Avoid downloads at setup
  time and disable registrar telemetry/update checks. Account for assets embedded
  in the compiled filesystem: materialize private staging files if needed and
  ensure installed skills do not depend on a temporary directory or app location.
- Pin the registrar and required assets, update integrity locks and legal notices,
  and define the narrow adapter API that the desktop setup service will use.
- Establish the supported agent list from registrar capabilities rather than
  inventing directory mappings in HQ.
- Record the chosen site-skill strategy and any upstream work required. If a
  reliable self-contained registrar is not feasible, document the concrete
  blocker and return to the user before adopting a different installation model.

### Acceptance and handoff

- Exercise the compiled role in an isolated home, with external runtimes absent
  from PATH and caches isolated. Registration from local assets works offline.
- Verify installed skills remain readable after staging cleanup and that a
  registrar failure produces an actionable result without breaking HQ startup.
- Cover the new adapter's meaningful failure/cancellation behavior and run
  desktop checks and compiled smoke tests.
- Hand off the registrar API, asset layout, supported agents, site-skill decision,
  dependency/license changes, and exact validation commands/results.

## Session 2 — Reliable terminal command registration

**Outcome:** agents can invoke `novamira-hq` from the installed app, including
after updates and supported relocation scenarios.

### Work

- Define platform-specific command registration for macOS, Windows, and Linux,
  aligned with the actual release/install formats. Use user-writable locations
  where practical and report any required PATH refresh or terminal restart.
- Install a launcher that forwards to the desktop executable's `--cli` role.
  A bare symlink alone is insufficient with the current default-window entry
  point. Preserve argument boundaries, stdin/stdout/stderr, and exit codes.
- Resolve the installed app location rather than assuming a permanent absolute
  path. On macOS, try the recorded location, standard application directories,
  and bundle-identifier discovery. Define deterministic behavior for multiple
  copies; never arbitrarily select a stale or unrelated executable.
- For Windows and Linux, specify supported relocation detection and repair
  behavior according to their install formats. A missing app must produce a
  useful error instead of opening a window or silently invoking another CLI.
- Refresh registration when a moved app is opened. Keep stable launcher/state
  locations outside the movable app, resolving HQ-owned state through the shared
  path module. Ensure updates in place retain command access.
- Add registration status, enable, repair, and owned-artifact removal services.
  Preserve pre-existing user commands and configuration on name conflicts.
- Review generated MCP configurations: use a stable launch target where possible
  or explicitly provide regeneration/repair after relocation. CLI relocation
  support alone does not fix existing absolute-path MCP configurations.
- Keep the signed app executable as the process that invokes the macOS credential
  helper, preserving existing caller authorization and storage boundaries.

### Acceptance and handoff

- Verify invocation with spaces and special characters in paths/arguments,
  piped input, JSON output, nonzero exit codes, and no open desktop window.
- Verify update-in-place, app relocation, multiple copies, missing app, repeated
  registration, command conflicts, and repair/removal ownership behavior.
- Smoke-test hosting help/doctor, `site-cli --help`, and MCP startup through the
  installed launch paths without external runtimes.
- Hand off registration APIs, platform behavior, MCP relocation decisions, and
  validation results for use by the onboarding UI.

## Session 3 — Connect agents from onboarding and Settings

**Outcome:** users can enable shell access and install both entry-point skills
from the desktop UI without a separate toolchain.

### Work

- Add a “Connect your agents” experience on first launch, also accessible from
  Settings. Show command status, supported agent choices, and per-agent skill
  installation status. Selection is explicit; setup should remain revisitable.
- Wire command registration from session 2 and the embedded registrar from
  session 1 through structural service dependencies and existing job/patch
  patterns. Declare routes in the normative contract and route conventions test.
- Install two distinctly named, lightweight entry-point skills: HQ hosting and
  Novamira site operations. Prevent ambiguous triggers and command names.
- Hosting instructions use `novamira-hq ...`; site instructions use
  `novamira-hq site-cli ...` and load guidance owned by the bundled site CLI.
  Address any upstream guidance-prefix limitation found in session 1 before
  presenting this as working support.
- Retain on-demand loading of detailed, version-matched guidance so app updates
  generally do not require skill reinstallation. Define versioning/repair for
  the cases where the small entry-point instructions themselves change.
- Track artifacts installed by HQ so status, repair, and removal affect only
  owned installations. Detect existing/manual skills and surface conflicts;
  avoid silently replacing user-edited instructions.
- Keep installed skill files independent of the app location. Surface restart
  requirements for agents that cache skill discovery or PATH.
- Expose actionable per-agent results, including partial failures and retry.
  Preserve the existing MCP guide-based experience for users without skills.

### Acceptance and handoff

- Exercise first setup, repeat setup, adding another agent, cancellation, partial
  failure, repair, and removal using temporary agent homes and mocked seams.
- Verify that both installed entry points lead to usable guidance and working
  commands against the compiled app; do not call live hosting providers.
- Validate UI behavior and repository web conventions, then record supported
  agents, exact installed artifacts, ownership rules, and verification results.

## Session 4 — Desktop-only releases, updates, and final acceptance

**Outcome:** public installation, release automation, documentation, and checks
consistently describe and verify one desktop distribution.

### Work

- Make the repository package private; remove public npm publishing configuration
  and HQ npm-release jobs. Retain internal Node/Bun build and test infrastructure
  where useful, and retain the pinned public site CLI dependency.
- Decouple desktop build/sign/release jobs from HQ npm publication. Preserve
  macOS signing/notarization, credential-helper packaging, release metadata,
  checksums, legal assets, and platform artifacts needed by desktop installs.
- Resolve the old `install.sh` / `install.ps1` entry points explicitly: replace
  their npm flow with supported desktop installation or clear desktop-download
  guidance. They must no longer install HQ or a separate site CLI globally via npm.
- Replace npm-package-specific acceptance with desktop artifact acceptance,
  retaining useful internal build checks. Update CI, contribution guidance, and
  `AGENTS.md` so required checks match the new distribution.
- Remove HQ npm self-install behavior, registry settings, and npm update notices.
  Define `update` / `update --check` for the desktop distribution in the contract:
  report desktop release availability and guide users through supported download
  or update actions; do not claim automatic replacement is implemented.
- Preserve update-check opt-out, cache behavior, and suppression for scripted,
  piped, JSON, quiet, and offline invocations. Do not replace background checks
  with unexpected network activity in agent commands.
- Revise README, release documentation, contract, environment-variable reference,
  and skill guidance to describe desktop installation plus supported CLI/MCP
  access. Remove claims that end users need Node/npm or a standalone site CLI.
- Audit remaining references to HQ npm publication and distinguish obsolete
  public-distribution behavior from legitimate development dependencies.

### Acceptance and handoff

- Run `bun run check` and `bun run desktop:check`.
- Run the packaging checks required by `AGENTS.md` until this session explicitly
  replaces them with documented desktop equivalents. Run those replacements
  against actual release artifacts and use `scripts/desktop-smoke.mjs` for
  compiled-executable tests that need to preserve server stdin lifetime.
- Verify a clean installation path on every supported OS: desktop startup,
  command registration, agent skills, headless HQ CLI, bundled site CLI, MCP,
  relocation/repair, and upgrade-in-place behavior. Use platform CI for checks
  unavailable locally and report any remaining unverified platform behavior.
- Validate operation without external runtimes/caches and offline skill setup.
  Provider tests remain mocked or explicitly gated; workflows carry no provider
  credentials.
- Record final results and any outstanding release prerequisites. Do not mark
  the plan complete while registrar portability or a supported platform's
  installation path remains unresolved.

## Session handoffs

Update this section at the end of each implementation session with changed paths,
decisions, commands/results, and concrete remaining work.

- **Session 1 (2026-09-22):** Embedded registrar prototype implemented and
  validated on Linux x86_64. Detailed inspection, API, asset layout, upstream
  limitations and site-skill decision are in
  [`embedded-skill-registrar.md`](embedded-skill-registrar.md).
  - Added isolated `--skill-registrar` role in `desktop/main.ts` and
    `desktop/registrar.ts`, pinned `skills@1.5.18` plus integrity-locked
    `yaml@2.9.1` in `desktop/deno.json` / `desktop/deno.lock`. Network and
    subprocess permissions are revoked in the child; telemetry is disabled.
  - Added `createSkillRegistrar` in `src/agent-setup/registrar.ts`: explicit
    single-agent `installHosting(agent, signal)`, bounded/cancellable shared
    process seam, private local staging, copy mode, inventory/byte verification,
    cleanup and actionable failure results. Uses the embedded
    `skills/novamira-hq/SKILL.md`; its digest is pinned in the legal manifest.
    Supported prototype agents: **Claude Code and Windsurf**. Directory rules
    remain in the registrar. Shared-directory agents are excluded pending the
    upstream inventory issues described in the inspection report.
  - Added `desktop/registrar-acceptance.ts`, compiled and run by the existing
    desktop build/smoke scripts; added focused adapter contracts and updated the
    desktop dependency convention test. Updated `AGENTS.md` for the desktop-only
    registrar exception and `legal/manifest.json` / `legal/licenses/` for MIT,
    ISC and Apache-2.0 notices, including omissions from upstream's notice file.
  - Validation: `bun run check` passed (1,279 passed, one skipped, zero failed);
    `bun run desktop:check`, `bun run desktop:build`,
    `node scripts/desktop-smoke.mjs`, `bun run pack:inspect`, and
    `bun run package:acceptance` passed. Compiled smoke used isolated homes and
    caches with external runtimes absent from PATH. Both skills survived staging
    cleanup; repeat conflicts and launch failure were exercised, followed by
    successful HQ dashboard, bundled site CLI and MCP startup. Real child
    cancellation and process-tree cleanup passed as well.
  - Site decision: public CLI 1.3.0 hard-codes `novamira` and standalone npm
    installation guidance; no command-prefix support was found. Keep detailed
    guidance upstream. A prefix-aware managed guidance release is required
    before session 3 installs `novamira-site`; no site skill is exposed yet.
  - Remaining: platform CI must validate macOS/Windows. Session 3 must add
    exact-target inventory, owned-artifact tracking and conflict-safe preflight
    (including malformed/manual skills) before UI wiring. Upstream's CLI can
    overwrite targets, combines inventory paths, and reports some copy failures
    with exit zero; this is a fresh-install prototype, not the finished setup
    service. Full shared-directory agent support and existing desktop legal
    release prerequisites remain open. Session 2 can proceed independently.
- **Session 2:** Not started.
- **Session 3:** Not started.
- **Session 4:** Not started.

# AGENTS.md

## Repository overview

Novamira HQ (`@novamira/hq`, executable `novamira-hq`) is the hosting-side
command-line tool and local dashboard for Novamira. It manages hosting-provider
profiles and provider API credentials, operates provider resources across eight
hosting providers, and provisions the Novamira plugin so a site becomes ready
for the site CLI.

The runtime is Node.js 22+ ESM, written in strict TypeScript and built with Bun.
Start with `README.md` for user-facing behavior and `docs/v1-contract.md` for the
normative output, configuration, and security contract. HQ is a TypeScript port
of the Go `novamira-hub`; `typescript-migration-plan.md` records how it was
executed. The port is complete — every module named below exists — so treat
`docs/v1-contract.md` as describing shipped behavior rather than intent.

## Boundary rule

> HQ never holds a WordPress site token, never calls a WordPress REST route on a
> configured site's behalf, and never proxies an Ability.

HQ's job ends at provisioning: create and operate hosting resources, install and
configure the plugin, then hand off. There is no `site/` package, no Application
Passwords, and no `site_profiles` in the schema. Do not add a code path that
reintroduces site access.

The one exception is bounded: `hosting novamira setup` issues a single
`GET {siteUrl}/.well-known/oauth-protected-resource`, the public unauthenticated
compatibility metadata, carrying `Accept` and `User-Agent` and no `Authorization`
header, ever. No other URL on a configured site may be requested.

## Storage namespace

HQ's namespace is disjoint from the site CLI's, and `NOVAMIRA_HOME` is never
read or interpreted.

- override root `NOVAMIRA_HQ_HOME`, explicit config override `NOVAMIRA_HQ_CONFIG`
- Linux `novamira-hq` below the XDG config/state/cache roots
- macOS `Novamira HQ` below Application Support and Caches
- Windows `Novamira HQ` below `APPDATA` / `LOCALAPPDATA`
- keychain service `ai.novamira.hq`, never `ai.novamira.cli`

Resolve every path through `src/config/paths.ts` and never join a namespace
segment by hand.

## Site CLI integration

`@novamira/cli` is an optional integration, never a runtime, package, or peer
dependency. Hosting inventory, actions, provisioning, and plugin-installed
status must work with `novamira` absent. Doctor warns and the dashboard disables
connected-state detection with an install hint; nothing else degrades. HQ never
reads the site CLI's config or credential storage and couples only to its public
v1 command grammar and JSON output.

## Provider API calls

Live provider API calls stay explicitly gated behind an environment variable
that is unset in CI, and never run as part of `bun run check` or any workflow
job. No workflow may carry provider credentials. Tests point the HTTP client at
a local mock server or inject `fetch`; never run inventory or mutating provider
calls just to test.

## Orientation

- `src/errors.ts` is the single source of the `CliError` code and exit taxonomy.
- `src/skills/` is a **leaf**: it reads the packaged `skills/` directory at the
  repository root (`novamira-hq`, `core`, `hosting`) and hands the markdown to
  `src/cli/skills.ts` and to the doctor's `skills.bundled` check. It imports
  `node:` builtins and `../errors.js` and nothing else, and it **writes nothing,
  anywhere** — there is no `skills install` and no `setup` command, because
  registering a skill with an agent is `npx skills add`'s job. There is no `site`
  bundle: site guidance ships with `@novamira/cli`, and the hosting bundle's
  prose must never describe site access — it names `novamira auth login` as the
  step after provisioning and stops. `package.json`'s `files` ships `skills/`;
  `scripts/copy-static.mjs` must not be taught about it, because that script
  exists only for assets that live _inside_ `src/`.
- `src/doctor/` is the local installation report: `engine.ts` holds the
  `pass`/`warn`/`fail` record shape and the sequential runner that isolates a
  throwing check, `checks.ts` the frozen check ids in their frozen order. It may
  import `src/config/`, `src/credentials/`, `src/skills/`, `src/integration/`
  and `src/update/`, and may import neither `src/cli/` nor `src/web/` — both of
  those call _it_. Four rules are contract, not preference: a produced report is
  a successful invocation whatever its status; `profile.credentials`,
  `integration.site_cli` and `update.available` can never be `fail`, because one
  bad credential reference, a missing `@novamira/cli` and an out-of-date install
  are all normal; `--fix` may only repair private-path permissions and create
  the state directory; and `--offline` **removes** `update.available` from the
  list rather than running it and recording a skip.
- `src/update/` is the npm-only self-update: `registry.ts`'s anonymous dist-tag
  read, `install.ts`'s package-manager command and spawn seam, `notifier.ts`'s
  cached record and background notice. It may import `src/config/` (atomic
  write, file security, the lock manager), `src/semver.ts` and `src/errors.js`,
  and must import none of `src/cli/`, `src/web/`, `src/doctor/`. Go's
  release-archive download, checksum verification and in-place executable
  replacement are deleted, not ported, and HQ makes no request to GitHub. The
  registry `fetch` and the installer runner are both injectable, and every test
  supplies both — no test in this repository reaches the npm registry or spawns
  a package manager. The state record lives at `<stateDir>/update-check.json`,
  resolved through `src/config/paths.ts`; `NOVAMIRA_HOME`,
  `NOVAMIRA_UPDATE_CHECK` and `NOVAMIRA_REGISTRY` are never read, and the
  opt-out and override are `NOVAMIRA_HQ_UPDATE_CHECK` and `NOVAMIRA_HQ_REGISTRY`.
  The background notice is suppressed _before_ the request, never after it: a
  scripted, piped, `--json`, `--quiet`, `dashboard` or `doctor --offline`
  invocation performs no registry read and writes no state.
- `src/semver.ts` is a leaf holding `Semver`, `parseSemver`, `compareSemver`,
  `compareSemverStrings` and `isSemver`. It used to live in
  `src/provisioning/compatibility.ts`, which now re-exports it so existing
  callers and `test/provisioning-contract.test.mjs` are unchanged; it moved so
  `src/update/` could compare versions without importing `src/provisioning/`.
- `src/connection-state.ts` is the shared connected-state vocabulary — the
  four-state union, `ConnectionQuery`/`ConnectionSnapshot`/`ConnectOutcome`, and
  the fixed hint per `UnavailableReason`. It sits at the root, beside
  `errors.ts` and `json.ts`, and imports nothing, because `src/integration/`
  computes those values and `src/web/` renders them and the two are peers that
  may share only a root module.
- `src/site-profiles.ts` is the second root module of that kind, and answers a
  different question: not "is this hosting environment connected?" but "what
  does the operator's `novamira` hold, and what can be done to it?". It declares
  `SiteProfileState` / `SiteProfileSummary` / `SiteProfileListing` /
  `SiteProfileOutcome` and the site CLI's own profile-name grammar, and imports
  exactly one thing, `UnavailableReason`. The grammar is not politeness: a
  profile name becomes an argv element of `sites remove <name>` and of
  `--site <name>`, so an unchecked leading `-` would run a different command
  than the one HQ meant. Nothing on these types can hold a credential;
  `expiresAt` is a time, carried because it is what an operator needs in order
  to decide whether to reconnect.
- `src/output/` renders the success/failure envelope and redacts diagnostics.
- `src/config/` resolves HQ paths and owns locks, atomic writes, owner-only file
  security, the `config.json` v1 schema, and the config store.
- `src/credentials/` resolves env/file/stored credential references and backs
  `stored` with the OS keychain plus an owner-only file fallback.
- `src/hosting/` holds the shared HTTP client, provider-neutral types, the
  `ProviderClient` request unions, the profile-to-client factory, and the eight
  provider clients under `src/hosting/providers/`. `shell.ts` builds WP-CLI
  command lines (refusing rather than escaping anything that changes a command's
  meaning) and `operations.ts` polls long-running provider operations; both sit
  below the CLI so provisioning can use them. `src/json.ts` holds `asRecord` and
  the RFC 6901 pointer lookup, for the same reason.
- `src/provisioning/` installs and configures the Novamira plugin over provider
  WP-CLI, checks the site against HQ's own copy of the site CLI's v1
  compatibility matrix, and emits the `novamira auth login` handoff. It is the
  layer Phase 6's dashboard calls directly, so it must never import from
  `src/cli/`; `src/cli/` imports from it.
- `src/web/` is the local dashboard: `html.ts`'s branded tagged template and
  `Attr`/`Url` constructors, `expr.ts` and `datastar.ts` (one helper per
  Datastar attribute — a hand-written `data-…` string is a review failure),
  `signals.ts`'s one root signal object, `patches.ts`'s SSE fragment catalog,
  `sse.ts` (the only module that may import `@starfederation/datastar-sdk`),
  `request.ts`/`responses.ts`/`routes.ts`/`static.ts`, `server.ts` with the
  loopback bind guard and the per-process mutation token, and `views/`.
  `signals-input.ts` is the only place a posted signal record is narrowed, and
  `patch.ts` is the one page-repaint patch sequence (signals, `#main`, `#nav`,
  `#toast` — in that order). `views/pages.ts` is the exhaustive page-body
  dispatcher every batch adds one `case` arm to; a page's view model lives in
  its own view module, never in `views/types.ts`. `services/` holds the
  dashboard's own mutable state and its read/write paths — it may import
  `src/config/`, `src/credentials/`, `src/hosting/`, `src/provisioning/`,
  `src/connection-state.ts` and `src/integration/`'s public surface, and may not
  import `src/web/views/` or `src/web/handlers/`. `services/sites.ts` owns the
  five-minute provider-listing cache and the single `connectionStates` round per
  listing; it also keeps that round's `profiles` inverted as `siteProfileLinks`,
  which is how `/site-profiles` draws its back-links to hosting environments
  without comparing a domain itself — both directions of that cross-link are the
  _one_ origin match `src/integration/` already made, and `src/web/` must never
  grow a second. The deploy-path pages and `siteProfileLinks` read the cache
  **warm only** and must never
  trigger a provider call, and `/_dashboard/connect` spawns
  `novamira auth login <url>` through `src/integration/` and renders no child
  output, ever. `views/site-profiles.ts` and `handlers/site-profiles.ts` are the
  `/site-profiles` page and its `#cli-sites` fragment: what the **site CLI**
  holds, as opposed to what the hosting providers report. It is a page and not a
  panel on `/sites` — it was one briefly, and the two listings share nothing but
  the word "site": different subject, different cost, different refresh
  lifetime. Its four routes are the only ones that manage a site profile, they
  reach `src/integration/` and never a provider API, and each ends by re-listing
  and patching `#cli-sites` (outer) and `#toast` (outer) — never `#main`, which
  carries the page's own Refresh button. Do not confuse them with Go's deleted
  `/_dashboard/sites/{save,remove}`, which wrote HQ's own site profiles; the
  route conventions test still asserts those two paths appear nowhere.
  `services/setup-jobs.ts` is the Novamira-setup job registry: it
  calls `provisionNovamira` from `src/provisioning/` **whole** — no second copy
  of the sequence, no Application Password, no site-profile write — runs it
  detached from the request, and bounds both the registry and each job's event
  log. `handlers/setup.ts`'s progress stream is the one looping handler in the
  dashboard and must honour `request.signal`. `handlers/diagnostics.ts` answers
  the two `/_dashboard/diagnostics/*` routes; nothing under `src/web/` imports
  `src/doctor/` — `DashboardDoctor` is declared structurally on
  `DashboardServerDependencies`, exactly as `DashboardIntegration` is, and
  `src/cli/dashboard.ts` supplies the real runner bound to
  `{ offline: true, fix: false }`. `handlers/updates.ts` answers the two
  `/_dashboard/updates/*` routes the same way, through the structurally-declared
  `DashboardUpdates`; nothing under `src/web/` imports `src/update/` either, and
  the installer's output never crosses that boundary. `handlers/` is one module per
  route group, mirroring `src/cli/hosting/`'s shape; a handler is a pure
  `(request) => DashboardResponse` and every SSE handler catches its own errors
  and turns them into a notice patch, because an escaping throw would answer an
  SSE route with a JSON envelope. It is a **peer of `src/cli/`, never a
  consumer**: nothing under `src/web/` may import `src/cli/`, and
  `src/cli/dashboard.ts` imports `src/web/index.ts`.
- `src/integration/` is the site CLI connected-state service and the **only**
  place HQ runs `novamira` — `probe.ts`'s `--version` probe for the doctor
  included: an injectable spawn seam (`shell: false`, an argv
  array, bounded output, a per-child timeout plus a shared refresh deadline),
  executable resolution, total origin normalization, and the two-stage
  `sites list` then `auth status` algorithm behind the four states
  `not_configured` / `connected` / `reconnect_required` / `unavailable`, plus
  `connect.ts`'s Connect action (`novamira auth login <url>`, the non-secret URL
  as its only argument) and `classify.ts`, the child-outcome classification both
  share. `profiles.ts` is the site-profile management service the dashboard's
  panel calls — `sites list`, `auth status --site`, `auth logout --site` and
  `sites remove` — and it is composed into `SiteCliIntegration` rather than
  constructed separately, so there is one spawn seam and one resolver.
  `verdict.ts` and `pool.ts` are the two leaves `connection.ts` and
  `profiles.ts` share: the reading of a single `auth status` answer, and bounded
  concurrency. A second copy of either is how the connection cell and the panel
  would end up disagreeing about the same profile on the same page. Every
  failure mode is a state, never a hosting error — the one exception is a
  profile name the site CLI's grammar cannot represent, which throws
  `usage_error` before anything is spawned, because that is a caller bug and not
  an unreachable CLI. `@novamira/cli` is never
  imported and never a dependency of any kind; the site CLI's config,
  credential storage and `NOVAMIRA_HOME` are never read; child output is never
  persisted or logged. Adding a fifth command means adding an argv builder to
  `site-cli.ts` and a method to `profiles.ts` — never a spawn anywhere else. It
  is a peer of `src/web/` and `src/cli/` and imports neither.
- `src/index.ts`, `src/main.ts`, and `src/cli/` are the entry point, the
  composition root, and the commander program plus its handlers.
- `src/cli/hosting/` is one module per command group; `src/cli/hosting/index.ts`
  composes them into the `hosting` tree and extends the existing `config`
  command. `program.ts` owns the grammar and the globals, `commands.ts` builds
  every handler from `CommandDependencies`. A global option name is reserved
  across the whole tree, because a parent command consumes a matching option
  anywhere in argv.
- `test/*-contract.test.mjs` runs offline against `dist/`; every suite isolates
  itself under `NOVAMIRA_HQ_HOME` in a temporary directory.
- `scripts/` and `.github/workflows/` cover SPDX headers, packaging, and
  releases.
- `src/web/static/` holds the nine browser assets, copied verbatim from the Go
  program: a vendored MIT Datastar build, two SIL OFL fonts with their licence
  texts, and three files of ours. They are excluded from ESLint, Prettier and
  the SPDX header script, and `scripts/copy-static.mjs` copies them into
  `dist/` as part of `bun run build`. Do not reformat them.
- `install.sh` and `install.ps1` live at the repository root and are **not** in
  `package.json`'s `files`: an installer inside the package it installs is
  circular. They are served from the repository's raw URL and attached to each
  GitHub release. They install the package with `--ignore-scripts`, smoke-test it
  with `novamira-hq doctor --offline` — which is why a `warn` report must exit 0
  — and then register the bundled skill with an exactly pinned `skills@x.y.z`.
  `scripts/package-acceptance.mjs` packs the tarball, installs it into a
  throwaway prefix and drives the installed executable; `bun run
package:acceptance` runs it, and all three packaging jobs plus the release job
  do too.
- Nothing is left deferred. `routes.ts`'s `DEFERRED_ROUTES` is **empty**, the
  `patches.ts` catalog is closed, and every page, route and fragment the contract
  names is shipped. The mechanism stays for a future phase to declare intent
  with; the route conventions test pins the shipped table's exact method-and-path
  surface, so a new route has to be declared in `docs/v1-contract.md` and in that
  test before it can ship.

## Making changes

- Edit `src/`, tests, and documentation; `dist/` is generated and ignored.
- Keep `.js` extensions in relative TypeScript imports and retain SPDX headers.
- Prefer discriminated unions over class hierarchies, and exhaustive `switch`
  with a `never` default.
- Runtime dependencies are exactly `commander` and `@starfederation/datastar-sdk`;
  everything else must be a `node:` builtin. Do not use `console.*` in `src/`.
- Add or update a focused contract test for behavior changes.
- Run `bun install` when needed and `bun run check` before handoff. Run
  `bun run pack:inspect` and `bun run package:acceptance` for packaging,
  installer or release changes.
- Never expose provider secrets in config JSON, argv, output, errors, logs,
  tests, or docs; keep JSON stdout machine-parseable and diagnostics redacted.

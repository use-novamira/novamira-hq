# AGENTS.md

Novamira HQ (`novamira-hq`) is the hosting CLI and local dashboard for Novamira.
It uses Node.js 22+, ESM, strict TypeScript, and Bun tooling.
See `README.md` for product usage. Shipped behavior, output, configuration, and
security boundaries are enforced by the focused contract tests in `test/`.

## Product boundaries

- HQ owns hosting resources and plugin provisioning. WordPress authentication,
  site HTTP, and site profiles belong to the site CLI. Delegate through
  `src/integration/`; never read its config/credentials or store site tokens in HQ.
  The sole direct site request allowed is setup's unauthenticated
  `GET {siteUrl}/.well-known/oauth-protected-resource`, with `Accept` and
  `User-Agent` but never `Authorization`.
- No site deletion/reset, environment/backup/domain deletion, DNS-record mutation,
  or SSH/SFTP access management on any surface. Expose capabilities only through
  the positive allowlist in `src/hosting/capabilities.ts`.
- Environment push requires explicit positive scope, distinct source/target,
  and provider support. Execute and wait for the native push only. Restore
  verifies the backup in the target environment's catalog; CLI requires `--yes`
  and full-content acknowledgement.
  Neither operation creates a separate backup automatically.
- MCP exposes typed tools, no generic argv bridge or access presets. Push and
  restore use plan/apply with short-lived, session-local, one-use confirmation IDs;
  neither CLI nor MCP restore accepts provider-native JSON.
- Resolve HQ storage through `src/config/paths.ts`. Use `NOVAMIRA_HQ_HOME` /
  `NOVAMIRA_HQ_CONFIG`, never `NOVAMIRA_HOME`; keychain service is `ai.novamira.hq`.
  Stored credentials use the OS service with no automatic file fallback.
  macOS caller authorization belongs to `native/macos/keychain.swift`: only a live
  HQ parent signed by the helper's Developer ID team gets silent authorization;
  interpreted callers require per-operation consent.

## Architecture constraints

- `src/cli/` is the composition layer. `src/web/`, `src/integration/`, and
  `src/provisioning/` must not import it. Integration also must not import web.
  Shared connection/profile types live in root modules.
- Web receives doctor/update services through structural dependency interfaces,
  not imports from `src/doctor/` or `src/update/`. Neither service imports CLI/web;
  update also must not import doctor. Web services must not import views/handlers.
- Run site commands only through integration's shared resolver and child-process
  seam, never in HQ's parent process. Prefer the packaged CLI; honor
  `NOVAMIRA_HQ_SITE_CLI` without a silent PATH fallback. Preserve cancellation,
  bounded capture, timeouts, and whole-process-tree termination. Never persist or
  log child output. Site-CLI failures must not disable hosting operations.
- `site-cli <arguments...>` preserves child flags, streams, and exit codes.
  Managed CLI invocations suppress update notices and independent self-update.
  Source builds and desktop must use the same exact public CLI release and required data;
  desktop uses its embedded `--site-cli` role, not an assumed Node executable.
  The current bundled release is `@novamira/cli@1.3.1`; update the npm and Deno
  pins and integrity locks together. Only integration's child entry and desktop's
  site-CLI role may import the public `@novamira/cli/entry` export.
- `src/skills/` is read-only and imports only Node builtins and `errors.js`.
  Desktop skill registration uses the isolated, pinned `skills@1.5.18` role
  through `src/agent-setup/`; its Deno-only dependency is an explicit exception
  to the runtime dependency allowlist. Use local assets, copy mode, explicit
  agents, and disabled network/telemetry. Site guidance belongs to the
  site CLI. Exact-target metadata for the two reviewed registrar agents lives
  only in `desktop/registrar.ts` and is checked against real upstream copies;
  never use merged upstream inventory as an ownership record. The registrar
  writes only inside private staging homes; HQ publishes verified entry copies
  and tracks digests for conflict-safe repair/removal. Detailed guidance remains
  read-only. Site instructions use the upstream managed command-prefix option.
  Hosting skill guidance stops at `novamira-hq site-cli auth login`.
- A completed doctor report exits successfully regardless of report status.
  `profile.credentials`, `integration.site_cli`, and `update.available` cannot
  fail. `--fix` only repairs private-path permissions and creates the state
  directory; `--offline` omits the update check entirely.
- HQ is desktop-only; the repository package is private. CLI update reports
  GitHub desktop release/download URLs and never installs or replaces files.
  The desktop dashboard checks GitHub releases on
  launch (24-hour cache, opt-out via `NOVAMIRA_HQ_UPDATE_CHECK=0`) and offers
  platform downloads. Scripted, piped, JSON, quiet, source-dashboard, and offline-doctor
  invocations must suppress CLI background checks before any request or state write.

## Dashboard conventions

- Use `html.ts`'s branded templates and `Attr`/`Url`, and `datastar.ts` helpers
  rather than handwritten Datastar attributes. Only `sse.ts` imports the SDK.
- Narrow posted signals in `signals-input.ts`; repaint through `patch.ts`
  (signals, `#main`, `#nav`, `#toast`). SSE handlers catch errors as notice patches.
- Push pages and post-profile-action repaints use warm inventory only; they must
  not trigger provider calls. Setup jobs call `provisionNovamira` as a whole.
- Declare new routes in the route conventions test.

## Development and verification

- Keep `.js` extensions in relative TypeScript imports and SPDX headers.
  Runtime dependencies are limited to `commander`, `@starfederation/datastar-sdk`,
  the pinned `@novamira/cli`, and Node builtins. No `console.*` in `src/`.
- Commander global option names are reserved throughout the command tree.
- `dist/` is generated. Do not reformat `src/web/static/`. Deno-specific code
  belongs in `desktop/`, whose dependency pins must match `package.json`.
- Contract tests run against `dist/`, isolated under temporary `NOVAMIRA_HQ_HOME`.
  Add focused contract coverage for behavior changes. Mock provider HTTP and
  desktop release-catalog seams. Live provider calls require an explicit env
  gate and must never run in checks or CI. No workflow may carry provider credentials.
- Run `bun run check` before handoff. For packaging, installer, or release changes,
  build the platform artifact and run `bun run desktop:acceptance` (pass the
  signed DMG path on macOS). This replaces npm pack/package acceptance.
  Use `bun run desktop:check` for desktop changes and
  `scripts/desktop-smoke.mjs` for compiled-executable smoke tests (it preserves the
  server's stdin lifetime). Desktop bundles must work offline without external
  runtimes/caches; installers must not separately install a global site CLI.

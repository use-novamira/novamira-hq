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
of the Go `novamira-hub`; `typescript-migration-plan.md` is the authoritative
plan and is still being executed, so parts of the layout below do not exist yet.

## Boundary rule

> HQ never holds a WordPress site token, never calls a WordPress REST route on a
> configured site's behalf, and never proxies an Ability.

HQ's job ends at provisioning: create and operate hosting resources, install and
configure the plugin, then hand off. There is no `site/` package, no Application
Passwords, and no `site_profiles` in the schema. Do not add a code path that
reintroduces site access; the plugin compatibility preflight is public
unauthenticated metadata only.

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
- `src/output/` renders the success/failure envelope and redacts diagnostics.
- `src/config/` resolves HQ paths and owns locks, atomic writes, owner-only file
  security, the `config.json` v1 schema, and the config store.
- `src/credentials/` resolves env/file/stored credential references and backs
  `stored` with the OS keychain plus an owner-only file fallback.
- `src/hosting/` holds the shared HTTP client, provider-neutral types, the
  `ProviderClient` request unions, the profile-to-client factory, and the eight
  provider clients under `src/hosting/providers/`.
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
- Still to land per the plan: `src/provisioning/`, `src/web/`, `src/skills/`,
  `src/doctor/`, and `src/update/`.

## Making changes

- Edit `src/`, tests, and documentation; `dist/` is generated and ignored.
- Keep `.js` extensions in relative TypeScript imports and retain SPDX headers.
- Prefer discriminated unions over class hierarchies, and exhaustive `switch`
  with a `never` default.
- Runtime dependencies are exactly `commander` and `@starfederation/datastar-sdk`;
  everything else must be a `node:` builtin. Do not use `console.*` in `src/`.
- Add or update a focused contract test for behavior changes.
- Run `bun install` when needed and `bun run check` before handoff. Run
  `bun run pack:inspect` for packaging or release changes.
- Never expose provider secrets in config JSON, argv, output, errors, logs,
  tests, or docs; keep JSON stdout machine-parseable and diagnostics redacted.

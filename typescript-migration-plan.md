We are migrating ../novamira-hub Go code to type script.
We'll write the new code here in a new repo. Novamira cli code is in ../novamira-cli.
The following doc clarifies everything

# Novamira HQ — TypeScript Migration Plan

Status: architecture decisions resolved; ready for implementation planning
Date: 2026-07-30

## 1. Why

Three decisions land at once:

1. **`@novamira/cli` shipped as a separate product.** It owns the site-level
   relationship: OAuth (PKCE), keychain-backed credentials, profiles, Ability
   discovery/execution, site skills, upload, doctor. HQ's `internal/site`
   package predates it and uses Application Passwords over Basic auth — a
   different, now-obsolete auth model.
2. **HQ stops proxying sites.** HQ's job ends at _provisioning_: create and
   operate hosting resources, install and configure the Novamira plugin so a
   site becomes CLI-ready. Agents then talk to the site through `novamira`
   directly. HQ is never in that path.
3. **HQ drops the desktop shell and moves to TypeScript**, adopting
   novamira-cli's stack and conventions.

## 2. Target shape

|             | Today (Go)                                             | After                                                         |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Language    | Go 1.26                                                | TypeScript (strict), Node 22+ ESM, Bun toolchain              |
| Repo        | `use-novamira/novamira-hub`                            | new `use-novamira/novamira-hq`                                |
| Surfaces    | CLI + local web dashboard + Wails desktop              | CLI + local web dashboard                                     |
| Site access | `internal/site` (Application Password, Basic auth)     | **removed** — `@novamira/cli` owns it                         |
| Config      | `config.toml` (hosting + site profiles + deploy paths) | HQ-namespaced `config.json` (hosting profiles + deploy paths) |
| Packaging   | goreleaser: npm, Homebrew, DMG, deb, Windows installer | npm only + `install.sh` / `install.ps1`                       |
| Skills      | `core`, `hosting`, `site`                              | `core`, `hosting`                                             |

The rewrite follows **novamira-cli's architecture and practices wherever they
apply**, not HQ's — it is the better-considered codebase and the one already in
the target language.

### Boundary rule

> HQ never holds a site token, never calls a WordPress REST route on a
> configured site's behalf, and never proxies an Ability.

Everything below follows from that rule.

## 3. What is deleted outright

| Removed                                                                        | Lines (src+test) | Reason                                   |
| ------------------------------------------------------------------------------ | ---------------- | ---------------------------------------- |
| `internal/site/`                                                               | 209              | Superseded by `@novamira/cli`            |
| `internal/cli/site.go` + `payloads.go` site paths                              | ~400             | No `site` subcommand                     |
| `internal/desktop/` (4 files, Wails)                                           | ~200             | No GUI app                               |
| `internal/cli/desktop.go`                                                      | 36               | ditto                                    |
| `packaging/macos`, `windows`, `linux`, `homebrew`                              | —                | npm-only distribution                    |
| `.goreleaser.yaml`, 3 workflows (release, Windows installer, macOS test build) | —                | Replaced by npm publish workflow         |
| `internal/skills/data/skills/site/`                                            | —                | Site guidance ships with the CLI         |
| `site_profiles` in config                                                      | —                | Schema drops it                          |
| `kinsta-openapi.yaml` (260 KB)                                                 | —                | Reference-only, keep out of the new repo |

That removes about 1,000 of 18,550 Go source lines (~6%), plus all desktop,
packaging, and release infrastructure, before a line is ported.

## 4. What is ported

| Area                                                                                                          | Go LOC (src) | Notes                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------- |
| `internal/providers/` (8 providers + neutral types)                                                           | ~7,300       | Largest chunk; mechanical but wide                       |
| `internal/cli/hosting*.go`, `access.go`, `flagtypes.go`, `helpers.go`, `payloads.go`, `print.go`, `output.go` | ~4,200       | ~110 subcommands → commander                             |
| `internal/dashboard/` (server + views + types)                                                                | ~3,850       | Datastar/SSE preserved; renderer swapped                 |
| `internal/config/`                                                                                            | 412          | TOML → JSON, drop site profiles                          |
| `internal/update/`, `doctor/`, `setup/`, `skills/`, `phpcompat/`, `jsonutil/`                                 | ~1,100       | Update logic largely replaced by CLI's `update/` modules |
| Static assets (`datastar.js`, `app.css`, `relative-time.js`, `sites-filter.js`, logo, 2 fonts)                | —            | Copied verbatim                                          |

Go tests total ~6,400 lines. They are the specification for the port.
CLI-facing tests become `node:test` contract tests against compiled `dist/`,
following novamira-cli's `test/*-contract.test.mjs` convention. The
`httptest`-mocked provider tests instead port as module-level tests that import
from `dist/` and point the client at a local mock HTTP server — spawning the
binary for those adds nothing.

## 5. Architecture decisions

### 5.1 Repo and package identity

Mirror novamira-cli exactly: Bun 1.2+ with `bun.lock`, Node 22+ ESM, strict
TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`,
`.js` extensions on relative imports, SPDX headers on every file,
AGPL-3.0-or-later, ESLint `strictTypeChecked` + `stylisticTypeChecked` with
`no-console: error`, Prettier, npm trusted publishing with provenance,
`docs/v1-contract.md` as the normative contract, `AGENTS.md` with `CLAUDE.md`
symlinked to it.

Identity:

- npm package `@novamira/hq`, executable `novamira-hq`
- repo `github.com/use-novamira/novamira-hq`

### 5.2 Layout

```
src/
  main.ts               # composition root, mirrors novamira-cli/src/main.ts
  errors.ts             # CliError + code taxonomy
  cli/
    program.ts          # commander definition, typed handler interface
    commands.ts         # handler wiring
  config/
    paths.ts lock.ts file-security.ts atomic-write.ts profiles.ts
                        # adapted from novamira-cli with an HQ-only namespace
    schema.ts           # hosting profiles + deploy paths
  credentials/          # provider API keys: env/file refs + keychain-backed stored refs
  hosting/
    types.ts            # HostingSite, HostingEnvironment, ActionResult, ...
    client.ts           # ProviderClient interface + request unions
    providers/          # kinsta.ts instawp.ts pantheon.ts pressable.ts
                        # wpengine.ts rocketnet.ts hostinger.ts cloudways.ts
  provisioning/
    plugin.ts           # install/activate Novamira over provider WP-CLI
    phpcompat.ts
    handoff.ts          # emit the `novamira auth login` handoff
  web/
    server.ts routes.ts sse.ts
    views/              # port of dashboard/views.go
    static/             # copied assets
  skills/               # core + hosting bundles
  doctor/ update/ output/
test/*.test.mjs
```

### 5.3 Provider clients

Go's sealed-interface `ReadRequest` / `ActionRequest` pattern
(`internal/providers/providers.go`) exists to emulate a sum type. TypeScript has
them natively: discriminated unions on a `kind` field, with `switch` exhaustiveness
enforced by `noFallthroughCasesInSwitch` plus a `never` default. This is one of
the few places the port should _improve_ on the Go rather than transliterate it.

Each provider is an independent, separately reviewable unit of work. Port with
its Go tests converted first, then the implementation. Live provider calls stay
explicitly gated and never run in CI (carry the existing rule forward into the
new `AGENTS.md`).

### 5.4 Web UI

Keep Datastar. The `data-*` attributes, the SSE patch protocol, the CSS, and the
JS in `internal/dashboard/static/` all carry over unchanged; only the server-side
renderer changes.

- **Rendering**: replace gomponents with a typed `html` tagged template that
  escapes interpolations by default, plus Datastar attribute helpers mirroring
  the current `data` alias convention. The existing
  `gomponents_conventions_test.go` (378 lines) becomes the conventions test for
  those helpers. Alternative considered: JSX with a custom factory — more
  familiar, but adds a transform to a project that otherwise compiles with plain
  `tsc`.
- **HTTP**: `node:http` with a small route table, preserving
  `RequireLocalAddress` (loopback-only bind) and the per-process mutation token.
  This avoids adding a web-framework dependency; HQ's other runtime
  dependencies are Commander, the Datastar SDK, and whatever the OS-keychain
  adapters need — verify during Phase 1 whether novamira-cli's adapters shell
  out to `security`/`secret-tool`/PowerShell (no dependency) or use a native
  module, and mirror its approach. Hono is the alternative if the 2,000-line
  `server.go` port proves painful — decide during Phase 5, not before.
- **SSE**: use the official `@starfederation/datastar-sdk` Node adapter. Its
  stable 1.x release is dependency-free and implements the shared Datastar SDK
  specification, so HQ should not own a second implementation of the wire
  format. Wrap it behind a small local interface so views and routes do not
  depend directly on SDK types. Confirm the adapter's 1.x/dependency-free
  status when Phase 0 pins dependencies.

### 5.5 Config and credentials

Adapt novamira-cli's storage primitives — `atomic-write`, `file-security`
(0600 / Windows ACL), and `lock` (cross-process profile lock). Do **not** copy
its path namespace: the site CLI already owns `NOVAMIRA_HOME`,
`~/.config/novamira/config.json`, the corresponding macOS/Windows `Novamira`
directories, and its `state`, `cache`, and `credentials` trees.

HQ uses an entirely separate namespace:

- override root: `NOVAMIRA_HQ_HOME`
- explicit config override: `NOVAMIRA_HQ_CONFIG`
- Linux: `novamira-hq` below the XDG config/state/cache roots
- macOS: `Novamira HQ` below Application Support and Caches
- Windows: `Novamira HQ` below `APPDATA` / `LOCALAPPDATA`
- keychain service: `ai.novamira.hq` (never `ai.novamira.cli`)

`NOVAMIRA_HOME` is ignored by HQ. Its config, locks, update state, cache,
credential fallback files, and keychain records must never collide with the
site CLI. Contract tests run both path resolvers against the same fake home on
Linux, macOS, and Windows and assert that every resulting path and credential
service is distinct.

Schema (`config.json`, version 1):

```jsonc
{
  "version": 1,
  "hostingProfiles": { "<name>": { "provider": "kinsta", "credential": {...},
                                   "companyId": "...", "apiBaseUrl": "..." } },
  "pushes":          { "<name>": { ... } }
}
```

`credential` keeps a tagged shape, with these final semantics:

- `env`: the config stores only the environment-variable name.
- `file`: the config stores only the file path.
- `stored`: the config stores an opaque credential ID; the secret is stored
  through HQ's OS-keychain adapters under service `ai.novamira.hq`.

The stored fallback is an owner-only file below HQ's credential directory,
using the same fail-closed Unix mode and Windows ACL rules as the site CLI.
Keychain accounts are derived from provider kind, hosting-profile name, and
credential field, so replacing or deleting a profile deterministically replaces
or deletes its secret. Config writes and credential writes are performed under
the hosting-profile lock; before replacement, the prior record is retained in
memory so a failed config save can restore it. Provider secrets never appear in
config JSON, argv, output, errors, logs, tests, or docs. Dashboard secret fields
pass values in the local HTTP request body and directly to the credential
store. CLI input uses an environment reference, file reference, or stdin where
necessary — never a secret-valued option.

### 5.6 No legacy config import

The Go predecessor was never released: npm publishing was deliberately
deferred (`fbbe764 Defer npm publishing until public release`), and the
`v0.1.x` GitHub releases and Homebrew tap were never announced or distributed.
There are no external users and therefore no migration feature. Internal
`config.toml` files (the team's own) are migrated by hand or with a throwaway
script — not by shipped, tested product code.

Note the legacy TOML stores `stored` credentials as plaintext inline values,
so those files should be securely archived or deleted once their hosting
profiles are recreated in HQ. Site profiles and their Application Passwords
have no destination at all: the new schema simply has no place for them.

### 5.7 CLI output contract

HQ currently prints ad-hoc JSON per command. Adopt novamira-cli's envelope so an
agent sees one shape across both tools:

```json
{"ok":true,"data":{},"meta":{"requestId":"..."}}
{"ok":false,"error":{"code":"...","message":"...","retryable":false}}
```

With no released predecessor there is nothing to break; the new
`docs/v1-contract.md` simply documents this envelope as the format from day
one. Match the CLI's global options where they mean the same thing (`--json`,
`--quiet`, `--verbose`, `--no-color`, `--yes`, `--timeout`) and its exit-code
mapping.

## 6. The provisioning handoff — the one genuinely new design

`hosting novamira setup` today (`internal/cli/hosting_novamira.go`, 451 lines +
the dashboard's job runner) does:

1. PHP version preflight → 2. install + activate the plugin over provider WP-CLI
   → 3. `wp option update novamira_ai_abilities_enabled 1` and `..._domain <host>`
   → 4. **`wp user application-password create <user> "Novamira CLI" --porcelain`**
   → 5. write a `site_profiles` entry in HQ's config.

Steps 4 and 5 are deleted. The new flow ends at step 3 and emits a handoff:

```
✓ Novamira 1.11.2 installed and activated on https://example.com
  Connect your agent:  novamira auth login https://example.com
```

with the JSON equivalent under `data`. HQ writes no credential, stores no
profile, and creates no WordPress user.

**Preflight addition**: the current setup checks PHP compatibility. It should
also verify the installed plugin satisfies the CLI's v1 compatibility matrix
(WordPress ≥ 6.9, Novamira ≥ 1.11.1, `rest_api_version` 1, all required feature
flags) — otherwise HQ reports success on a site where `novamira auth login`
will immediately fail `server_unsupported`. That check is a public, unauthenticated
metadata read, so it does not violate the boundary rule. Confirm before Phase 5
starts that the plugin actually exposes every required field (version,
`rest_api_version`, feature flags) without authentication; any field that turns
out to need auth must be dropped from the preflight rather than fetched.

**Dashboard "connected" state**: the sites page currently marks an environment
connected by matching its host against a `site_profiles` entry
(`novamiraLinkedToEnv`). A profile alone is not a connection: `novamira auth
logout` intentionally removes credentials without removing the profile.

Replace the boolean with separate states:

- **not configured**: no origin-matching profile from `novamira sites list`;
- **connected**: an origin-matching profile has `credentialState` `fresh` or
  `near_expiry` and `restReachable: true` from `novamira auth status`;
- **reconnect required**: every matching profile reports `absent`, `invalid`,
  `expired`, or an authentication error;
- **unavailable**: the CLI is missing/incompatible, a child times out, output is
  malformed, or reachability cannot be established because of a network/server
  failure.

First run `novamira --json --timeout <ms> sites list` and match normalized
origins from its successful response to hosting environments. For matched
candidates only, run
`novamira --json --timeout <ms> --site <name> auth status` with bounded
concurrency. A site is connected if any matching profile is connected. These
commands are part of the CLI's frozen v1 grammar. Before Phase 6 begins, the
site CLI's `docs/v1-contract.md` must also explicitly freeze the already-shipped
JSON data used here:

- `sites list`: an array containing `name`, `siteUrl`, and normalized `origin`;
- `auth status`: `site`, `siteUrl`, `credentialState`, `restReachable`,
  optional `expiresAt`, and optional `restError`, including the existing enum
  values.

This is a documentation/contract clarification of current behavior, not a
schema change. HQ's integration fixtures are copied from that public contract
and reject missing or invalid required fields while ignoring additional
non-conflicting fields.

Run the executable directly with an argv array (never through a shell), apply a
short timeout to each child plus an overall refresh deadline, cap captured
stdout/stderr, and never persist child output. Treat integration failures as
"connection state unavailable", not as a hosting error. HQ must not read the
CLI's config or credential storage. The dashboard independently shows
plugin-installed state when connection state is unavailable.

The generated handoff and the dashboard Connect action invoke
`novamira auth login <url>` without `--name`, leaving valid,
collision-resistant profile naming to the site CLI. HQ does not synthesize or
pass a profile name. After success, refresh both `sites list` and `auth status`;
on failure, show a bounded diagnostic and keep the copyable command as fallback.

## 7. Sequencing

Each phase leaves the repo green and shippable. Providers and views are the two
wide phases and parallelize across contributors.

| #   | Phase        | Content                                                                                                                                          | Rough size |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 0   | Bootstrap    | New repo, package.json, tsconfig, eslint, prettier, CI, AGENTS.md, LICENSE, SPDX script, `docs/v1-contract.md` skeleton                          | small      |
| 1   | Foundations  | `errors`, `output/`, HQ-namespaced `config/*`, config schema, keychain-backed provider credentials, HTTP client with retry/diagnostics           | medium     |
| 2   | Hosting core | Neutral types, `ProviderClient` interface, request unions, `ClientFromProfile`                                                                   | small      |
| 3   | Providers    | 8 clients, tests first, one PR each                                                                                                              | **large**  |
| 4   | CLI          | commander program, ~110 hosting subcommands, payload/flag helpers, output envelope                                                               | large      |
| 5   | Provisioning | plugin install, phpcompat, compatibility preflight, handoff                                                                                      | medium     |
| 6   | Web          | server, routes, SSE, token/loopback guards, views port, static assets                                                                            | **large**  |
| 7   | Periphery    | skills (core+hosting), doctor (incl. "is `novamira` installed?"), update, `install.sh`/`install.ps1`, npm release workflow, README, contract doc | medium     |

Phases 3 and 4 can overlap per provider. Phase 6 depends on Phases 1–3 and the
provisioning service from Phase 5.

## 8. Resolved decisions

1. **Package and binary name:** publish `@novamira/hq`, install the
   `novamira-hq` executable, and use `github.com/use-novamira/novamira-hq` for
   the new repository. "HQ" is the product name; `novamira-hq` avoids colliding
   with the shipped `novamira` site CLI. Do not carry the `hub` name forward.
2. **Connected-state detection:** invoke `novamira --json --timeout <ms>
sites list` to find origin-matching profiles, then
   `novamira --json --timeout <ms> --site <name> auth status` for matched
   candidates, as specified in §6. Profile presence means
   configured, not connected. This couples HQ only to the CLI's public v1
   contract rather than its private on-disk schema.
3. **Connect action:** offer an explicit **Connect** action in the local
   dashboard. It spawns
   `novamira auth login <url>` directly, with no shell, after the dashboard's
   existing loopback and mutation-token checks. The non-secret URL is the only
   argument; HQ leaves profile naming to the site CLI. The child CLI owns browser
   launch, OAuth callback, and credential writes; HQ monitors process
   completion, does not persist its output, and refreshes connected state after
   success. The CLI command remains visible as a copyable fallback.
4. **CLI prerequisite:** `@novamira/cli` is an optional integration, not a
   package or peer dependency. Hosting inventory, actions, provisioning, and
   plugin-installed status must work without it. Documentation names it as the
   next step, while doctor reports a warning and the dashboard disables
   Connect/connected-state detection with an install hint when `novamira` is
   absent or incompatible. A peer dependency would not reliably validate a
   globally installed executable and would unnecessarily couple installations.
5. **Datastar SSE:** use the official `@starfederation/datastar-sdk` Node
   adapter behind a narrow local wrapper. Do not hand-roll the protocol.
6. **Deploy paths:** retain them in HQ. They describe provider environment to
   provider environment operations and do not cross the site-access boundary.
7. **Go repository:** keep `novamira-hub` available but maintenance-only while
   the TypeScript port is in progress. Archive it only after the new repository
   passes ported contract tests, provider parity checks, dashboard acceptance,
   and a release smoke test; do not run two active implementations after
   parity. Delete the unannounced `v0.1.x` GitHub releases and the Homebrew
   tap assets at archival — nothing consumes them.
8. **Storage namespace:** HQ uses `NOVAMIRA_HQ_HOME`,
   `NOVAMIRA_HQ_CONFIG`, `novamira-hq` platform directories, and keychain
   service `ai.novamira.hq`. It never uses or interprets the site CLI's
   `NOVAMIRA_HOME`, config, state, cache, credentials, or keychain namespace.
9. **Provider secret storage:** `stored` always means HQ-keychain-backed with an
   owner-only file fallback; plaintext stored secrets are never written to
   `config.json`.
10. **Legacy state:** none ships. The Go product was never released, so there
    is no import command; internal `config.toml` files are migrated by hand
    (§5.6). Site profiles and Application Passwords are never carried over —
    the new schema has no place for them.

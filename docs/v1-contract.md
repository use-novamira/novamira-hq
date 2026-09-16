# Novamira HQ v1 Contract

Status: every section of this document is normative and implemented. One
narrower reservation remains, stated where it applies: the dashboard's **view
surface beyond the app shell and the seven shipped pages** is not frozen — the
markup inside a page may change without a major version, while its routes, its
SSE fragments, its security model and what each page may and may not do are
frozen here.

This document is normative for HQ major version 1. It fixes the values consumed
by HQ's CLI, dashboard, and provider implementations. There is no released
predecessor: the Go `novamira-hub` was never published, so v1 has nothing to
remain backward compatible with and ships no legacy import.

## Package and release identity

| Item | v1 decision |
| --- | --- |
| npm package | `@novamira/hq` in the Ovation S.r.l.-controlled `@novamira` organization |
| executable | `novamira-hq` |
| public repository | <https://github.com/use-novamira/novamira-hq> |
| package manager | Bun 1.2+ |
| lockfile | `bun.lock` |
| runtime | Node.js 22+; CI and package acceptance run Node 22 and Node 24 |
| modules | ESM only |
| build output | compiled JavaScript in `dist/`, with a Node shebang |
| lint / format | ESLint / Prettier |
| license | AGPL-3.0-or-later |
| release owner | Ovation S.r.l. through reviewed `use-novamira` GitHub workflows and npm trusted publishing with provenance |
| runtime dependencies | exactly `commander` and `@starfederation/datastar-sdk` |
| bundled data | the published tarball contains `dist/` and `skills/` (`novamira-hq`, `core`, `hosting`) |
| installers | `install.sh` and `install.ps1`, published as GitHub release assets and served from the repository's raw URL; **not** inside the npm tarball |
| distribution | npm only: no Homebrew formula, no `.deb`, no DMG, no Windows installer, no release-archive download |
| release line | release candidates use `1.0.0-rcN`; the first stable public release is `1.0.0` |
| package acceptance | `bun run package:acceptance` packs the tarball, installs it into a throwaway prefix, and exercises the installed executable offline; it runs in CI on Linux, macOS and Windows, and again in the release job against the published version |

The package has no lifecycle setup, downloaded runtime, required native
executable or addon, and no native keychain module: OS credential storage uses
inbox platform commands. `@novamira/cli` is an optional integration and is never
a runtime, package, or peer dependency.

The `1.0.0-rcN` packages are prereleases of this normative v1 contract, not a
pre-1.0 compatibility line. Stable v1 begins at `1.0.0`; release-candidate tags
must not become npm's `latest` dist-tag.

The installers do install `@novamira/cli` by default, as a **separate global npm
package** installed after HQ itself. That is an install-step convenience and
changes no other rule in this document: HQ never imports it, it appears in no
dependency field of `package.json`, and every runtime behavior below that is
specified to work with `novamira` absent still does. The step is skipped when
`NOVAMIRA_HQ_SKIP_SITE_CLI` is set, its failure is reported and never fatal —
HQ is installed and smoke-tested before it runs — and the installers never
invoke the `novamira` executable.

The installers add an operating-system application launcher without privilege
escalation. On macOS the shell installer creates `/Applications/Novamira HQ.app`
when `/Applications` is writable, falling back to
`~/Applications/Novamira HQ.app`. On Linux it installs the freedesktop entry
`ai.novamira.hq.dashboard.desktop` under
`${XDG_DATA_HOME:-~/.local/share}/applications`. On Windows the PowerShell
installer creates `Novamira HQ.lnk` in the current user's Start Menu Programs
directory. Every launcher runs the exact installed HQ entry point and Node.js
executable with `dashboard --open`, so the loopback dashboard starts and its URL
opens in the default browser even when a desktop process does not inherit the
user's shell `PATH`.

## Boundary

HQ never holds a WordPress site token, never calls a WordPress REST route on a
configured site's behalf directly. Typed WordPress MCP tools delegate only to
the optional site CLI through `src/integration/`; that child owns site HTTP and
authentication. The v1 schema has no
site profiles, HQ issues no Application Password, and HQ never reads the site
CLI's configuration or credential storage.

The only site-directed request v1 permits is one
`GET {siteUrl}/.well-known/oauth-protected-resource` per `hosting novamira
setup` invocation: the public, unauthenticated plugin compatibility metadata the
provisioning preflight reads. It carries `Accept` and `User-Agent` and nothing
else — **no `Authorization` header, ever**, and no `Cookie`. No other URL on a
configured site is requested, and a metadata field that turns out to require
authentication is dropped from the preflight rather than fetched.

## Global options

Settings uses three URL-addressable tabs on the existing `/settings` route:
`tab=general` (the default and fallback), `tab=updates`, and `tab=uninstall`.
Only the Updates tab renders the update card and its automatic check. General
shows local configuration information; Uninstalling shows instructions only.

Global options are `--profile <name>`, `--json`, `--quiet`, `--verbose`,
`--no-color`, `--yes`, `--timeout <ms>`, `--version`, and `--help`. `NO_COLOR`
has the same color-disabling effect as `--no-color`.

Every other option in the surface is command-local, and no command declares one
whose name is a reserved global: `doctor` declares `--offline` and `--fix`,
`update` declares `--check`, `dashboard` declares `--listen` and `--open`, and
the three `skills` subcommands declare none at all.

`--profile` selects the hosting profile. A profile is never inferred: a command
that needs one and is given none fails `usage_error` with the configured profile
names in `details.profiles`. No command accepts a secret-valued option.

A global option name is reserved across the whole command tree, so no subcommand
may declare one. `doctor --offline` and `doctor --fix` are command-local and free
against that set; the `skills` subcommands declare no options at all. `doctor` is
the one command that accepts `--profile` without requiring it: the flag narrows
one check and changes nothing else.

## Output and errors

stdout contains only requested output. stderr contains redacted diagnostics,
warnings, progress, and prompts. JSON mode emits exactly one JSON object on
stdout, never prompts, and emits no ANSI or spinner output.

Success envelope:

```json
{"ok":true,"data":{},"meta":{"requestId":"local-request-id"}}
```

Failure envelope:

```json
{"ok":false,"error":{"code":"provider_error","message":"The Kinsta API request failed with HTTP 500.","retryable":true}}
```

`meta` may additionally carry `profile`, `provider`, and `warnings`. Warnings are
records of `{ "code": string, "message": string }` with optional safe `details`.
The failure body may carry `remoteCode` (the provider's own code) and safe
`details`. Result data, including a scalar or null result, is unchanged under
`data`.

Stable code and exit mapping:

| Exit | Codes |
| --- | --- |
| 0 | success only |
| 1 | `internal_error` |
| 2 | `usage_error`, `config_error`, `profile_not_found` |
| 3 | `credential_missing`, `credential_invalid` |
| 4 | `provider_unsupported`, `provider_error`, `network_error`, `timeout`, `rate_limited`, `not_found`, `conflict`, `integration_unavailable`, `server_unsupported` |
| 5 | `schema_validation_failed` |
| 6 | `confirmation_required` |

Exit 0 always has `ok: true`; nonzero exits always have `ok: false`. Code
meanings are fixed: `profile_not_found` is a missing local hosting profile or
saved push, `not_found` is a missing remote provider resource,
`credential_invalid` covers provider 401/403 and unusable local credential
records, `provider_unsupported` is an operation a provider deliberately does not
implement, `integration_unavailable` is the optional `novamira` CLI being
absent, incompatible, or unusable, and `server_unsupported` is the provisioning
preflight's verdict that the site itself cannot run the Novamira plugin — its
PHP version, its WordPress version, the installed plugin's version, its REST
contract, its feature flags, or its published compatibility document — so
`novamira auth login` would fail.

A request ID is a fresh lowercase UUID generated locally once per invocation and
is safe to print. Secret values and secret-looking keys are redacted before
envelope or diagnostic formatting; the same envelope helpers serve the local
dashboard's JSON responses, so both surfaces emit the identical shape.

## Configuration

The configuration file is a single JSON document, format version 1. Version 1 is
the only accepted version: there is no migration path, no legacy TOML import, and
an unknown version is a `config_error`. Unknown object members are ignored on
read and dropped on the next write. Keys are serialized in a stable order with
sorted map keys and a trailing newline.

```jsonc
{
  "version": 1,
  "hostingProfiles": {
    "<name>": {
      "provider": "kinsta",
      "credential": { "type": "env", "name": "KINSTA_API_KEY" },
      "companyId": "...",   // optional
      "apiBaseUrl": "..."   // optional, absolute http(s) URL
    }
  },
  "pushes": {
    "<name>": {
      "name": "<name>",
      "hostingProfile": "<hosting profile name>",
      "siteId": "...", "siteLabel": "...",
      "sourceEnvId": "...", "sourceEnvName": "...",
      "targetEnvId": "...", "targetEnvName": "...",
      "pushDb": false, "pushFiles": false, "searchReplace": false
    }
  }
}
```

Names — map keys, hosting profile names, and push names — match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a violation is a `usage_error`. A structural
problem is a `config_error`; a field problem is a `schema_validation_failed`
carrying the exact dotted path. A push's `sourceEnvId` must differ from
its `targetEnvId`; its `hostingProfile` need not already exist. A missing
configuration file loads as an empty version-1 document.

Before every read or replacement, HQ verifies that an existing configuration
file is a regular owner-only file and that its immediate parent is a regular
owner-only directory. Symlinks, unexpected file types, ownership mismatches,
unsafe POSIX modes, unsafe Windows ACLs, and verification failures are
`config_error`; no credential reference is resolved from such a file. A missing
file or parent still represents the empty document, and the first write creates
both with owner-only security.

`provider` is one of the fixed kinds below. `apiBaseUrl` defaults to the
provider's base URL; a credential omitted at profile creation defaults to an
`env` reference naming the provider's credential variable. The identity variable
is the non-secret half of a two-part credential and is never a secret.

| Provider | Default API base URL | Credential variable | Identity variable |
| --- | --- | --- | --- |
| `kinsta` | `https://api.kinsta.com/v2` | `KINSTA_API_KEY` | — |
| `instawp` | `https://app.instawp.io/api/v2` | `INSTAWP_API_KEY` | — |
| `pantheon` | `https://api.pantheon.io` | `PANTHEON_MACHINE_TOKEN` | — |
| `pressable` | `https://my.pressable.com/v1` | `PRESSABLE_CLIENT_SECRET` | `PRESSABLE_CLIENT_ID` |
| `wpengine` | `https://api.wpengineapi.com/v1` | `WPE_API_PASSWORD` | `WPE_API_USER_ID` |
| `rocketnet` | `https://api.rocket.net` | `ROCKETNET_PASSWORD` | `ROCKETNET_USERNAME` |
| `hostinger` | Hostinger public API | `HOSTINGER_API_TOKEN` | — |
| `cloudways` | Cloudways public API | `CLOUDWAYS_API_KEY` | `CLOUDWAYS_EMAIL` |

Configuration is non-secret by construction and is safe to print unredacted.

## Credential references

`credential` is a tagged object with exactly three variants. A `value` member is
rejected, not ignored, so an inline plaintext secret can never be silently
accepted or persisted.

| Variant | Stored in `config.json` | Secret location |
| --- | --- | --- |
| `{ "type": "env", "name": "..." }` | the variable name only | the process environment |
| `{ "type": "file", "path": "..." }` | the file path only | an owner-only file the user controls |
| `{ "type": "stored", "id": "..." }` | an opaque id only | the OS keychain, or HQ's owner-only credential file fallback |

**`stored` never means plaintext.** It always resolves through HQ's keychain
adapters under service `ai.novamira.hq`, with an owner-only file below HQ's
credential directory as the only fallback; a plaintext secret is never written to
`config.json`. The id is the SHA-256 hex digest of the provider kind, a NUL
separator, the hosting-profile name, a NUL separator, and the credential field,
so replacing or deleting a profile deterministically replaces or deletes its
secret. An id that is not 64 lowercase hex characters is rejected.

A credential reference renders for output as `env:NAME`, `file:PATH`, or
`stored:ID`; that rendering is never secret and is the only description of where
a secret lives. A `file` reference must be owner-only — on Unix any group or
other permission bit rejects it, on Windows the ACL must name only the current
SID — and is rejected above 64 KiB; a trailing newline is trimmed. Resolution
fails closed: an absent secret is `credential_missing`, an unusable or
unverifiable one is `credential_invalid`.

Configuration writes and credential writes for a hosting profile are one
critical section under that profile's lock. The prior credential record is
retained in memory before replacement, so a failed configuration save restores
it and rethrows the original error; a rollback failure is reported as a warning
and never swallowed. A rollback deletes a record only when the pre-mutation read
positively observed its absence: a record whose prior state could not be read —
unsafe fallback permissions, a locked or unresponsive keychain — is left in
place and reported as a rollback failure. A keychain command that is killed by
its timeout or output ceiling is `integration_unavailable`, never a missing
credential.

Provider secrets never appear in `config.json`, argv, stdout, stderr, errors,
logs, tests, or docs. CLI secret input is an environment reference, a file
reference, or standard input. Dashboard secret fields pass values in the local
HTTP request body directly to the credential store.

## Storage namespace

HQ's storage is disjoint from the site CLI's at every path and in the keychain.
`NOVAMIRA_HOME` is never read or interpreted by HQ.

| Platform | Config | State (locks, credential fallback) | Cache |
| --- | --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/novamira-hq/config.json` | `$XDG_STATE_HOME/novamira-hq` | `$XDG_CACHE_HOME/novamira-hq` |
| macOS | `~/Library/Application Support/Novamira HQ/config.json` | `~/Library/Application Support/Novamira HQ/State` | `~/Library/Caches/Novamira HQ` |
| Windows | `%APPDATA%\Novamira HQ\config.json` | `%LOCALAPPDATA%\Novamira HQ\State` | `%LOCALAPPDATA%\Novamira HQ\Cache` |

The Linux XDG variables fall back to `~/.config`, `~/.local/state`, and
`~/.cache`. Credential fallback files live below the state directory on Linux, in
`Novamira HQ/Credentials` on macOS, and in `%LOCALAPPDATA%\Novamira HQ\Credentials`
on Windows.

Precedence is `NOVAMIRA_HQ_CONFIG` (the configuration file only), then
`NOVAMIRA_HQ_HOME` (an isolation root containing `config.json`, `state/`,
`cache/`, and `credentials/` directly), then the platform defaults. An
empty-string override is treated as unset.

The OS credential service is `ai.novamira.hq` and never `ai.novamira.cli`;
Windows Credential Manager targets are `ai.novamira.hq/<id>`. Backends are inbox
platform commands invoked without a shell — macOS `security` for reads and
deletes plus an `osascript` Security.framework bridge for stdin-only writes,
Linux `secret-tool`, Windows Credential Manager through PowerShell `Add-Type`
P/Invoke of Advapi32 — with an explicit owner-only file fallback under
`credentials/v1/<id>.json` selected only when the platform command is
unavailable or is explicitly requested. The file fallback is not OS-backed
encryption and warns on first use.

The state directory additionally holds `update-check.json`, the background
release notice's cache. Its record is
`{ "version": 1, "registry": string, "latest": string|null, "checkedAt": string }`,
where `registry` is the consulted registry reduced to origin plus path and
`latest: null` records a check that failed. It is written atomically with
owner-only permissions under the shared lock key `__update_check__`, which is
held across the registry request as well as the write so that two concurrent HQ
invocations make at most one request per interval. A record whose permissions do
not verify is deleted and treated as absent; a record whose `registry` does not
match the one in use is ignored.

All writes use a cross-process lock, an owner-only temporary file, and atomic
replacement. Unix directories and files are verified `0700` and `0600` with the
current UID; Windows verifies a protected ACL owned by the current SID with a
single full-control allow rule for that SID. Contract tests resolve both HQ's
and the site CLI's paths against one fake home on Linux, macOS, and Windows and
assert every resulting path and credential service is distinct.

## Environment variables

These are HQ's own variables — the complete set that changes how HQ itself
behaves:

| Variable | Effect |
| --- | --- |
| `NOVAMIRA_HQ_HOME` | isolation root holding `config.json`, `state/`, `cache/` and `credentials/` directly |
| `NOVAMIRA_HQ_CONFIG` | override the configuration file path only; state, cache and credentials keep their platform locations |
| `NOVAMIRA_HQ_SITE_CLI` | absolute path to the `novamira` executable, for connected-state detection and the doctor's `integration.site_cli` check |
| `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP` | `1` accepts a plain-HTTP site URL in `hosting novamira setup` and a plain-HTTP **loopback** package registry; one opt-in, not two |
| `NOVAMIRA_HQ_UPDATE_CHECK` | `0` or `false` disables the background release notice entirely — no request, no state write |
| `NOVAMIRA_HQ_REGISTRY` | the npm registry `update`, the dashboard's update card and the background notice consult |
| `NO_COLOR` | disables ANSI color, exactly like `--no-color` |

An empty-string override is treated as unset — for every variable above, not
only the path ones.

Three further groups of variables are read, and are specified where they belong
rather than here, because each is data the operator points HQ at rather than a
switch on HQ's behavior:

- **Platform location variables**, resolved by "Storage namespace" above:
  `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` on Linux, `APPDATA`
  and `LOCALAPPDATA` on Windows, and the user's home directory on every
  platform.
- **Provider credential and identity variables**, named by "Configuration and
  credentials" above: an `env:NAME` credential reference resolves the variable it
  names, each provider kind has a default one (`KINSTA_API_KEY`,
  `INSTAWP_API_KEY`, `PANTHEON_MACHINE_TOKEN`, `PRESSABLE_CLIENT_SECRET`,
  `WPE_API_PASSWORD`, `ROCKETNET_PASSWORD`, `HOSTINGER_API_TOKEN`,
  `CLOUDWAYS_API_KEY`), and four providers read a non-secret identity variable
  when the profile's `company_id` is empty (`PRESSABLE_CLIENT_ID`,
  `WPE_API_USER_ID`, `ROCKETNET_USERNAME`, `CLOUDWAYS_EMAIL`). WP Engine
  additionally accepts the legacy aliases `WPENGINE_PASSWORD` and
  `WPENGINE_USERNAME` when its primary variables are unset.
- **`PATH` and, on Windows, `PATHEXT`**, used to resolve the optional `novamira`
  executable when `NOVAMIRA_HQ_SITE_CLI` is not set.

**HQ never reads the site CLI's variables.** `NOVAMIRA_HOME`,
`NOVAMIRA_ALLOW_INSECURE_HTTP`, `NOVAMIRA_UPDATE_CHECK` and `NOVAMIRA_REGISTRY`
have no effect on HQ, are never interpreted, and are never forwarded to a child
process on HQ's behalf. The one exception is deliberate and narrow: when HQ
spawns `novamira` through `src/integration/`, that child inherits the ambient
environment it would have had anyway.

`NOVAMIRA_HQ_AGENT` (with `NOVAMIRA_AGENT` as a fallback) is read by the
installers, not by `novamira-hq`; it selects the agent `npx skills add`
registers the bundled skill with.

## Provider HTTP behavior

One HTTP client serves every provider. Status mapping is shared: 401 and 403 are
`credential_invalid`, 404 and 410 are `not_found`, 408 is `timeout`, 409 is
`conflict`, 422 is `schema_validation_failed`, 429 is `rate_limited`, and any
other non-2xx is `provider_error`. A transport failure is `network_error` and a
deadline is `timeout`. `retryable` is true for 408, 425, 429, 500, 502, 503, and
504, and for transport and deadline failures.

| Limit | Value |
| --- | --- |
| default per-attempt timeout | 30 seconds |
| default total request budget | 120 seconds |
| retry attempts | 3, GET and HEAD only unless a request opts in as idempotent |
| retry backoff | 250 ms initial, factor 2, 8 s cap, equal jitter |
| honored `Retry-After` ceiling | 30 seconds |
| buffered HTTP response ceiling | 25 MiB |
| maximum credential file size | 64 KiB |

The global `--timeout` sets the provider HTTP per-attempt timeout. When the
operator supplies it explicitly, the same value is also the total budget for
each provider request, including retries and backoff; omitting it retains the
120-second default total budget.

An `Authorization` header is never sent cross-origin: an absolute request URL on
another origin is a `usage_error`, and redirects are followed manually at most
three times and only to the same origin. A redirect chain shares one attempt
deadline, so the per-attempt timeout bounds the whole chain rather than each
hop. Redirects follow RFC 9110: a 303, and a 301 or 302 answering a POST, is
re-issued as a bodiless GET; only 307 and 308 replay the method and body, so a
redirect never repeats a mutating request. Error messages embed the provider's own
message truncated to 240 characters and redacted against the request's known
secrets. Live provider API calls are explicitly gated and never run in CI.

## Hosting commands

The command surface has exactly three top-level groups — `config`, for local HQ
configuration and hosting profiles; `hosting`, for provider resources; and
`skills`, for the bundled agent instructions — plus five top-level commands:
`dashboard`, `doctor`, `update`, `history` and `mcp`. There is no `site` group and no command
that reaches a configured WordPress site.

`novamira-hq mcp` is the stdio MCP transport intended for AI-agent configuration
as `npx -y @novamira/hq mcp`. It owns stdin and stdout for its process lifetime:
stdin is newline-delimited JSON-RPC 2.0 and stdout contains only newline-delimited
JSON-RPC responses. It supports protocol versions `2025-11-25`, `2025-06-18` and
`2025-03-26`, the initialize lifecycle, `ping`, `tools/list` and `tools/call`, and
advertises only the `tools` capability. It performs no background update check.

MCP exposes all supported typed tools at launch, without access presets or
capability-selection options. Unexpected launch arguments are rejected.

The hosting typed read tools are `hosting_profiles_list`, `hosting_provider_validate`,
`hosting_capabilities_get`, `hosting_sites_list`, `hosting_site_get`,
`hosting_environments_list`, `hosting_operation_get`, `hosting_backups_list`, and `hosting_history_list`. The typed mutations
are `hosting_backup_create` and `hosting_novamira_setup`. The push tools are `hosting_environment_push_plan` and
`hosting_environment_push_apply`; backup recovery uses
`hosting_backup_restore_plan` and `hosting_backup_restore_apply`. Every tool
carries MCP read-only and destructive annotations.

WordPress tools are `wordpress_sites_list`, `wordpress_doctor`,
`wordpress_discover`, `wordpress_describe`, `wordpress_skill`, and `wordpress_run`.
They invoke fixed public Novamira CLI grammar, not HQ site HTTP. Each site-scoped
call requires an explicit CLI profile. Discovery, relevant site skills and live
schema inspection precede execution. Run uses `--fresh --input -`, sends bounded
JSON over stdin, and forwards `--yes` only for an explicit `approveDestructive: true`.
That boolean is a CLI confirmation, not proof of human consent. The calling agent
must obtain task-level authorization and verify changes with a read-only Ability.
There is no automatic retry on ambiguous execution. Child output is bounded;
only parsed, redacted data leaves integration, marked untrusted. Raw stdout,
stderr and remote error text never enter logs, dashboard or history. These
operations do not install the CLI, reinstall the plugin, or enable AI Abilities.
Missing CLI and incompatible/unconnected sites have actionable failures without
disabling hosting. The hosting journal does not record these WordPress calls.

There is no generic CLI/argv bridge. MCP cannot mutate HQ configuration,
self-update, invoke arbitrary provider WP-CLI, manage domains or DNS, or manage
SSH/SFTP access. Unknown tools are neither advertised nor callable by name. Credentials still come only from configured references, never
an MCP credential argument.

Environment push is a two-call confirmation flow. The plan call requires different
source and target environments plus at least one positive scope: database, all
files, or a non-empty explicit file list. All-files and explicit files are
mutually exclusive, and search/replace requires database. It verifies the
provider advertises `envs.push`, resolves both
environment IDs under the named site, and returns a session-local random
confirmation ID expiring after five minutes. Apply consumes that ID before any
provider request, so it is one-use even after failure; it invokes the provider's
native push operation and awaits its completion when the provider returns an
operation ID. Apply revalidates provider support and environment membership.
Novamira HQ does not create a separate backup or compose backup and push into a
workflow; any automatic backup is part of the provider's own push contract.

Backup restore is another two-call transaction. Plan requires the target
environment, a non-empty backup id, and an explicit `allContent: true`; Kinsta
also requires its provider notification user id. It requires advertised backup
list/create/restore support, reads the target's backup catalog, and refuses an id
not present there. Apply consumes the five-minute, session-local confirmation
before any provider request, creates and awaits a fresh target safety backup,
then starts and awaits the restore. Restore accepts no provider-native JSON and
never deletes a backup.

Expected command, hosting, policy and argument failures are MCP tool results with
`isError: true`; malformed protocol requests remain JSON-RPC errors. All returned
values and errors pass through HQ's output redaction. Enabling every capability
does not weaken the WordPress boundary rule: no new HQ command or URL becomes
reachable.

### Grammar conventions

Global options are accepted at any position, before or after a subcommand.
Because a parent command consumes a matching option anywhere in the argument
list, every global option name is reserved across the whole tree, and no
subcommand may declare one. `--version` is the reason the version-valued options
are spelled `--php-version`, `--update-version`, and `--plugin-version`.

Options are long-form only; v1 declares no short option except `-h`.

`--from-json <path>` reads the entire request body from a JSON file, or from
standard input when the path is `-`. It supersedes every option that would
otherwise contribute a body field; an option required only as a body field is
therefore not required alongside it. A malformed document is a `usage_error`.

An option naming a resource that becomes part of the provider request path
rather than of its body — `--env` and `--target-env` on commands addressed per
environment, and `--site` where a command requires it — must be non-empty even
with `--from-json`, because no body can supply it. Omitting one is a
`usage_error` raised before any provider request. Missing body fields are
reported the same way.

A secret is always named and never given: a command that needs one registers
`--<name>-env <variable>`, `--<name>-stdin`, and `--<name>-file <path>`, and
exactly one must be supplied. No option anywhere accepts a secret value, so no
secret enters argv. Trailing newlines are trimmed from the stdin and file
sources; an absent or empty secret is `credential_missing`. No command reads,
generates, rotates, or exports an SSH/SFTP credential.

Repeatable options accumulate: `--ip`, `--file`, and `--name` on the
`update-all` commands.
Boolean options default to false unless documented otherwise, and a
true-defaulting boolean also registers its `--no-` form.

A command that polls a provider operation takes `--interval-seconds` (default 5,
must be greater than zero) and `--timeout-seconds` (default 300). An exhausted
budget is a retryable `timeout`; no status request starts at or after its
deadline, sleeps are clamped to the remaining budget, and a terminal answer
received at or after the deadline is not accepted. An operation the provider
reports as failed within the budget is a `provider_error`.

An invalid enumeration value, a non-numeric numeric option, a missing positional
argument, an unknown option, and an unknown subcommand are all `usage_error` at
exit 2, and none of them reaches a provider.

### `config`

| Command | Purpose |
| --- | --- |
| `config path` | print the resolved configuration, state, cache, lock, and credential paths |
| `config add <provider>` | add a hosting profile; `--profile` names it and defaults to the provider kind |
| `config list` | list hosting profiles with their provider, credential rendering, and company |
| `config show` | print the configuration document, or one profile with `--profile` |
| `config remove <profile>` | remove a hosting profile and the `stored` secret it owned |

`config add` takes `--company <id|auto|none>` (default `auto`, which asks the
provider for the account scope), `--api-base-url <url>`, `--force`, and one
credential source. `--credential-env <name>` and `--credential-file <path>`
record a reference only; `--credential-stdin` reads the secret and writes it to
the credential store, recording a `stored` reference. Naming no source records
an `env` reference to the provider's default credential variable. The credential
write, the company probe, and the configuration save are one critical section
under the profile's lock, and a failure rolls the credential back. No command in
this group prompts: HQ's interactive surface is the dashboard.

### `skills`

| Command | Purpose |
| --- | --- |
| `skills list` | list the bundled skills with their descriptions |
| `skills get [name]` | print a bundled skill's markdown; `name` defaults to `core` |
| `skills path [name]` | print a bundled skill's file path; `name` defaults to `core` |

Exactly two bundles ship: `core`, the router, and `hosting`, the provider-neutral
reference. A third file, `skills/novamira-hq/SKILL.md`, is the installable agent
stub and is not reachable through `skills get`. A name outside `core` and
`hosting` — `site` included — is `usage_error` with `details.skill` and
`details.known`. None of the three subcommands declares an option.

`skills get` in human mode writes the raw markdown to stdout with no framing; in
JSON mode `data` is `{ name, path, content }`. `skills list` renders
`{ skills: [{ name, description }] }` and `skills path` renders `{ name, path }`.
The path is a real, absolute file inside the installed package.

**No HQ command writes an agent skill to disk.** There is no `skills install`, no
`--scope`, no `--force`, and no stub or symlink written into a user's home.
Registering the skill with an agent is
`npx skills add <package root> --skill novamira-hq --global`, which the installers
run. The published tarball therefore contains `skills/novamira-hq/SKILL.md`,
`skills/core/SKILL.md` and `skills/hosting/SKILL.md`.

The `hosting` bundle's guidance never describes site access. It names
`novamira auth login <url>` — the separate `@novamira/cli` — as the step after
`hosting novamira setup`, and it mentions no Application Password, no site
profile and no WordPress REST route.

### `hosting`

Every `hosting` command operates through one hosting profile and never infers
one. `meta.profile` and `meta.provider` are present on every successful hosting
envelope.

| Group | Commands |
| --- | --- |
| `providers` | `validate`, `capabilities` |
| `regions` | `list` |
| `activity` | `list` |
| `ops` | `get <operation_id>`, `wait <operation_id>` |
| `sites` | `list`, `get <site_id>`, `create`, `create-plain`, `clone` |
| `envs` | `list`, `get <env_id>`, `create`, `create-plain`, `clone`, `push` |
| `domains` | `list`, `add`, `verify <site_domain_id>`, `primary` |
| `dns` | `domains list`, `records list` |
| `backups` | `list`, `downloadable`, `create`, `restore` |
| `cache` | `clear` |
| `php` | `restart`, `set-version` |
| `redirects` | `list`, `apply` |
| `denied-ips` | `list`, `set` |
| `wp` | `plugins list`, `plugins install`, `plugins update`, `plugins update-all`, `themes list`, `themes update`, `themes update-all` |
| `novamira` | `setup` |
| `wp-cli` | `run` |
| `logs` | `get` |
| `analytics` | `usage`, `env` |

Fixed value sets:

| Option | Values |
| --- | --- |
| `hosting cache clear --kind` | `site`, `edge`, `cdn` |
| `hosting domains add --setup-type` | `quick`, `avoid_downtime` |
| `hosting logs get --file` | `error` (default), `access`, `kinsta-cache-perf` |
| `hosting analytics usage --metric` | `visits`, `bandwidth`, `cdn-bandwidth` |
| `hosting analytics env --metric` | `cdn-bandwidth`, `visits`, `bandwidth`, `diskspace`, `top-countries`, `top-cities`, `top-client-ips`, `visits-dispersion`, `response-codes` |

Other defaults fixed by v1: `--wp-language` is `en_US`, `hosting activity list`
always sends `--limit` (10) and `--offset` (0), `hosting analytics env
--time-span` is `7_days` and the `diskspace` metric sends `time_zone` `00:00`
when none is given, and `hosting wp plugins install --source novamira-latest`
resolves locally to the sole canonical download endpoint
`https://license.dynamic.ooo/api/novamira/download`. HQ performs no GitHub
release lookup. `hosting novamira setup --source` **defaults** to
`novamira-latest`; `hosting wp plugins install --source` has no default and must
be given. `hosting activity list --api-key` names a provider-side API key
**identifier**, never a key value.

`hosting envs push` has no `--from-json` escape hatch and no implicit scope. It
requires `--site`, `--source-env`, `--target-env`, and at least one of `--db`,
`--all-files`, or repeatable `--file`. `--all-files` and `--file` cannot be
combined; `--search-replace` requires `--db`. HQ confirms both environments
exist beneath the site, requires provider support for push, then starts and
awaits the provider's native push operation. It does not create a separate
backup. Kinsta is the only provider currently advertising this granular contract;
Rocket.net's all-or-nothing staging publish and Cloudways' provider-native sync
are not implemented by their HQ adapters.

`hosting backups restore` has no `--from-json` form. It requires `--env`,
`--backup-id`, `--all-content`, and the global `--yes`; Kinsta additionally
requires `--notified-user-id`. Before mutation it verifies list/create/restore
support and finds the id in that environment's catalog. It then creates and
waits for a fresh safety backup, restores all content, and requires verified
completion of the restore. Missing operation IDs, synthetic statuses and unknown
outcomes stop the workflow with a non-retryable error: verify at the provider
before repeating. Apply revalidates the backup catalog before mutation. The
guarded workflow is advertised by Kinsta, Pantheon and Rocket.net. WP Engine
does not advertise it until its backup resource has genuine completion polling.

Read commands render the provider response unchanged under `data`; action
commands render the provider's action result; `hosting providers capabilities`
applies HQ's capability visibility policy before rendering.

### Not in the v1 command surface

- HQ never implements site deletion or reset, environment deletion, backup
  deletion, domain deletion, DNS record creation/update/deletion,
  or SSH/SFTP access management. Provider capability output is a positive
  allowlist, so provider-native and unknown operations remain private by
  default. These exclusions apply to CLI, dashboard, MCP, the provider-neutral
  client, and provider adapters; `--yes` does not unlock them.
- No command prompts, and no command reads standard input except through
  `--from-json -`, `--command-stdin`, and the `-stdin` secret sources.
- Push commands are not shipped. `pushes` is reserved in the
  configuration schema and no v1 command reads or writes it.
- No `site` group, no Application Password option, and no Ability proxying, per
  the boundary above.
- **No `setup` command and no `skills install`.** HQ writes no agent stub and
  creates no `~/.claude` or `~/.agents` entry; skill registration is
  `npx skills add` against the packaged `skills/novamira-hq` directory.
- **No `skills get site`.** Site guidance ships with `@novamira/cli`.
- **No self-replacing binary update.** `update` runs a package manager; it
  downloads no release asset, verifies no checksum, unpacks no archive and
  replaces no executable in place. There is no `upgrade` alias and no
  `update check` / `update install` subcommand — one command, one `--check`.

## Provisioning and handoff

`hosting novamira setup` installs and configures the Novamira plugin on one
environment and then stops. It writes no site credential, stores no site
profile, and creates no WordPress user.

### Flags

| Flag | Type | Default |
| --- | --- | --- |
| `--env <id>` | string | required |
| `--url <url>` | string | discovered with `wp option get home` |
| `--source <source>` | string | `novamira-latest` |
| `--plugin-version <version>` | string | — |
| `--force` | boolean | `false` |
| `--activate` / `--no-activate` | boolean | `true` |
| `--activate-network` | boolean | `false` |
| `--ignore-requirements` | boolean | `false` |
| `--preflight` / `--no-preflight` | boolean | `true` |
| `--validate-source` / `--no-validate-source` | boolean | `true` |
| `--wait` / `--no-wait` | boolean | `true` |
| `--ai-abilities` / `--no-ai-abilities` | boolean | `false` (explicit enable on an existing installation) |
| `--compat-check` / `--no-compat-check` | boolean | `true` |
| `--interval-seconds <seconds>` | positive integer | `5` |
| `--timeout-seconds <seconds>` | unsigned integer | `300` |

The command has no `--from-json` and no `--command-id`: it always generates its
own request body. `--plugin-version` carries the reserved-global rename of
`--version`. `--preflight` is the DB-backed WP-CLI probe below, never the
compatibility preflight, which is `--compat-check`.

Four flags the Go program had are permanently deleted, not renamed:
`--username` and `--app-name` existed only to name a WordPress user and label an
Application Password, and `--site-profile` and `--replace-profile` existed only
to write a `site_profiles` entry. HQ does neither.

### Sequence

Local validation runs first and issues no provider request: `--env` must be
non-empty, the provider must expose WP-CLI output — otherwise
`provider_unsupported`, because HQ reads back the PHP version, the plugin's
activation state, and the site URL — a supplied `--url` must normalize, and
`--source` is resolved and, unless `--no-validate-source`, HEAD-checked before
the provider is touched. The canonical endpoint does not implement HEAD, so its
documented `405 Method Not Allowed` is inconclusive and accepted; the provider
then receives that exact canonical URL. HQ follows no download redirect itself,
and every redirect observed during source validation is an error.

After the PHP check, fixed read-only commands inspect Novamira's installed
version and activation state (`wp plugin list --name=novamira
--fields=name,status,version --format=json`) and, when installed, its two AI
Abilities options (`wp option list --search='novamira_ai_abilities_*'
--fields=option_name,option_value --format=json`). Invalid or older versions stop
before mutation, including under `--force`. The minimum plugin version is the
shared `MINIMUM_NOVAMIRA_VERSION` constant. Updating an old plugin is a separate
explicit action, never an implicit part of setup.

The remaining sequence is:

| # | Command | Skipped when |
| --- | --- | --- |
| 1 | `wp eval 'echo PHP_VERSION;'` | never |
| 2 | `wp option get siteurl` | `--no-preflight`, or a preserved existing installation |
| 3 | `wp plugin install <resolved source>` | a compatible installation exists and `--force` was not requested |
| 4 | `wp plugin status <slug>` | no activation is requested, or the source names no slug |
| 5 | `wp plugin activate <slug>` | as 4, and when 4 reports the plugin already active |
| 6 | `wp option get home` | `--url` was given |
| 7 | `wp option update novamira_ai_abilities_enabled 1` | existing installation without explicit `--ai-abilities` |
| 8 | `wp option update novamira_ai_abilities_domain <host>` | existing installation without explicit `--ai-abilities` |

New installations enable AI Abilities by default for CLI callers. The dashboard
requires an explicit, initially unchecked approval before starting any setup job.
Without it, Start Setup is disabled and the server rejects the request before
any provisioning or provider calls. Existing installations preserve
both options by default; `--ai-abilities` explicitly enables them and binds them
to the current domain. `--force` is not that option. Connecting a site does not
change either setting. CLI and MCP require no app acceptance, and MCP may pass
`enableAiAbilities: true` without an additional human-confirmation gate.

Step 1 always precedes step 3. The minimum is **PHP 8.0**; a lower major is
`server_unsupported` and the gate exists to prevent a doomed mutation, so a
failure there leaves the site untouched. A step-2 failure that looks like a
socket problem carries a `DB_HOST` hint.

Step 3's generated command carries no `--activate` or `--activate-network`
whenever the plugin slug can be inferred from the source: activation is then a
separate, observable call, because a plugin that installs but fails to activate
inside one provider operation is indistinguishable from success. When the source
names no slug there is nothing to pass to steps 4 and 5, and the requested
activation flags go on the install line instead. Step 6 reads `home`, never
`siteurl`: `home` is the front-end URL an agent connects to and the URL the
discovery document is served under, and the two differ on a "WordPress in its
own directory" install. Step 8's host is shell-quoted like every other generated
argument. `--no-wait` against a provider that answers the install
asynchronously is a `usage_error`.

### Compatibility preflight

The run ends with the single site-directed request the boundary permits: one
`GET {siteUrl}/.well-known/oauth-protected-resource`, the RFC 9728 *append* form
under the site's own path. The insert form is never used; on a subdirectory
install it lands on a domain root the WordPress does not own.

That request is a **public, unauthenticated metadata read** and nothing else.
The plugin publishes the document from the `init` hook with no permission
callback, before and after any authentication, so reading it is not site access:
HQ holds no site token to send and none is required. A field that turned out to
require authentication would be dropped from the preflight rather than fetched.

| Property | Value |
| --- | --- |
| headers | `Accept: application/json` and `User-Agent: novamira-hq/<version>` only — no `Authorization`, ever, and no `Cookie` |
| redirects | manual, at most 3 hops, same origin only (a scheme change is cross-origin), all inside one attempt deadline |
| body ceiling | 256 KiB, read incrementally and abandoned past the ceiling |
| per-attempt timeout | 10 seconds |
| attempts | 3, with 1 s then 3 s between them |
| retried on | transport failure, timeout, and HTTP 404, 408, 429, and 5xx |
| cache | none; the document is read once per invocation |

404 is retried because an edge cache may still be serving a pre-activation
response for that path. Nothing else is: any other non-2xx, a disallowed
redirect, an oversized body, and every validation failure below are final on the
first observation.

The document is checked against HQ's own copy of the site CLI's v1 compatibility
matrix — HQ never imports `@novamira/cli` — and the **first** failing check is
named in `details.check`:

| Check | Requirement |
| --- | --- |
| `metadata.reachable` | 2xx, within the size ceiling, no disallowed redirect |
| `metadata.document` | the body parses as JSON and is a non-null, non-array object |
| `metadata.resource` | `resource` is a `http:`/`https:` URL with no userinfo whose origin is the site's |
| `metadata.authorization_server` | `authorization_servers` is a one-element string array naming the site itself |
| `metadata.bearer_methods` | `bearer_methods_supported` contains `header` |
| `metadata.scopes` | `scopes_supported` contains `mcp` |
| `compat.block` | the `novamira` block is an object carrying `plugin_version`, `wordpress_version`, and `minimum_wordpress_version` strings, a safe-integer `rest_api_version`, and a `features` object whose every value is a boolean |
| `compat.wordpress` | `wordpress_version` is dotted-numeric and at least `6.9` |
| `compat.wordpress_consistency` | `minimum_wordpress_version` parses and is at most `wordpress_version` |
| `compat.plugin` | `plugin_version` is SemVer and at least `1.11.1`; a prerelease of the minimum fails |
| `compat.rest_contract` | `rest_api_version` is exactly `1` |
| `compat.features` | `abilities_bearer_auth`, `agent_context`, `rest_skills`, and `generalized_execution_shim` are each exactly `true` |

`metadata.resource` is **deliberately narrower** than the site CLI's own check:
HQ compares the origin only and does not require the advertised resource to
equal `{siteUrl}/wp-json/mcp/novamira-oauth` or its plain-permalink
`index.php?rest_route=` form, because HQ cannot know the site's permalink style
or its `rest_url_prefix` filter, and a false "not ready" on a working site is
worse than a missed exotic case.

The tolerance rule applies throughout: a required field that is missing, wrongly
typed, or of a disallowed value rejects the document, while any additional
member — top level, inside `novamira`, inside `features`, or as an extra array
element — is ignored and never rejected.

**A failed preflight fails the invocation**, carrying the check id and the whole
install record in `details`. A warning on a success envelope would still be a
success envelope, and the command's contract is that the site is ready.
`--no-compat-check` is the only way to proceed without the check: it skips the
request entirely, sets `compatibility.status` to `"skipped"` and `ready` to
`null`, and attaches a `compatibility_not_checked` warning.

### The handoff URL

The URL HQ advertises — from `--url` or from `wp option get home` — must be one
`novamira auth login` accepts, or HQ would print a command that fails. It must
use HTTPS, or plain HTTP with a loopback host, or plain HTTP with
`NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1`, which is the only opt-in and adds an
`insecure_http` warning. Userinfo, a query string, and a fragment are each
refused. A bare `example.com` is read as `https://example.com`, a trailing slash
and duplicate slashes are collapsed, and the value written to
`novamira_ai_abilities_domain` is the bare hostname, port-stripped and with IPv6
brackets removed.

Every rejection is a `usage_error` naming `--url` in `details.flag` whatever the
value's source, because supplying `--url` is what fixes it. No diagnostic ever
repeats userinfo back: a rejected URL's credential is removed before the error
is constructed. HQ never reads the site CLI's own
`NOVAMIRA_ALLOW_INSECURE_HTTP`.

### Failures

| Failure | Code |
| --- | --- |
| `--env` missing, a site URL HQ refuses, `--no-wait` against an install the provider answered asynchronously | `usage_error` |
| the provider cannot expose WP-CLI output | `provider_unsupported` |
| PHP major below 8, or any compatibility check failing | `server_unsupported` |
| the canonical download endpoint or another remote `--source` unreachable, and compatibility metadata still unreachable after its retries | `network_error`, retryable |
| a remote `--source` is not downloadable | `not_found` |
| a WP-CLI command, the install, the activation, or an option write that the provider reports failed | `provider_error` |
| an operation that outlives `--timeout-seconds`, or a compatibility attempt deadline that expires on every attempt | `timeout`, retryable |

The PHP gate is fatal and runs before anything is installed, so a site that
cannot run the plugin is left untouched; the compatibility preflight is fatal and
runs last, after the site has been mutated, because a site that is not ready
means the command did not do its job. Every preflight failure carries the failed
`check` plus the install record — `hostingProfile`, `env`, `siteUrl`,
`metadataUrl`, `pluginSlug`, `pluginSource`, `aiAbilities` — and whatever the
check observed, so a caller still learns exactly what landed. All of it is public
metadata and all of it is redacted like every other diagnostic.

### `data`

```json
{
  "hosting_profile": "kinsta",
  "env": "env-abc123",
  "url": "https://example.com",
  "plugin": {
    "slug": "novamira",
    "source": "https://license.dynamic.ooo/api/novamira/download",
    "version": "1.11.1",
    "activated": true,
    "network_activated": false
  },
  "ai_abilities": { "enabled": true, "domain": "example.com" },
  "compatibility": {
    "status": "supported",
    "metadata_url": "https://example.com/.well-known/oauth-protected-resource",
    "plugin_version": "1.11.1",
    "rest_api_version": 1,
    "wordpress_version": "6.9",
    "minimum_wordpress_version": "6.9",
    "features": {
      "abilities_bearer_auth": true,
      "agent_context": true,
      "rest_skills": true,
      "generalized_execution_shim": true
    }
  },
  "ready": true,
  "next_step": {
    "tool": "novamira",
    "command": ["novamira", "auth", "login", "https://example.com"],
    "command_line": "novamira auth login https://example.com"
  }
}
```

`compatibility.status` is `"supported"` or `"skipped"`; a failing check never
produces a success envelope, so no other value can appear. When it is
`"skipped"`, every other `compatibility` field is `null`, `plugin.version` is
`null`, and `ready` is `null`; otherwise `ready` is `true` only when AI Abilities
are effectively enabled for the current domain, and `null` with an activation
warning otherwise. Preserved `ai_abilities.domain` reports the existing binding,
including a mismatching domain; HQ never silently rewrites it. `next_step.command` is argv a caller may
spawn with no shell and `next_step.command_line` is the same command as one
string; both are generated from one value so they cannot drift, and the command
carries no `--name` and no `--no-open` because profile naming belongs to the
site CLI and launching a browser belongs to the operator. There are no
timestamps anywhere.

**`site_profile`, `username`, `credential`, `rest_url`, and `config_path` are
permanently absent.** Each existed in the Go program only because it created an
Application Password and wrote a `site_profiles` entry; HQ does neither, and
`config_path` in particular must never return.

Human mode prints one block, unstyled and with no glyph:

```text
Novamira 1.11.1 installed and activated on https://example.com
  Connect your agent:  novamira auth login https://example.com
```

Under `--no-compat-check` the version is unknown, because it is read from the
metadata, and the skip is stated rather than implied:

```text
Novamira installed and activated on https://example.com
  Compatibility not checked (--no-compat-check).
  Connect your agent:  novamira auth login https://example.com
```

The two warnings the command can raise, `compatibility_not_checked` and
`insecure_http`, reach stderr through the normal warning path and `meta.warnings`
in JSON mode; the block never repeats them.

## Local dashboard

`novamira-hq dashboard` serves a local web dashboard. Its transport, security,
route surface and pages are frozen below, and every one of them is shipped: no
page carries a control wired to a route that answers `404`, and there is no
deferred route left. What is **not** frozen is the markup inside a page beyond
the app shell — the elements a page renders, and their classes, may change
without a major version, while its routes, its SSE fragments, its security model
and what it may and may not do are frozen here.

### Binding

`--listen <address>` accepts `:PORT`, `PORT`,
`HOST:PORT` and `[IPv6]:PORT`. The host must be loopback: an omitted host, the
literal name `localhost` (never resolved), any IPv4 literal in `127.0.0.0/8`,
the IPv6 literal `::1` with or without brackets, or an IPv4-mapped IPv6
loopback. Everything else — `0.0.0.0`, `::`, any other address or name — is a
`usage_error` naming `--listen` in `details.flag`, raised before any socket is
opened. The check is repeated against the address the listener actually reports;
a mismatch is `internal_error`. Port `0` is accepted and the reported URL and
JSON `port` carry the port the kernel assigned. `EADDRINUSE` is `conflict`,
`EACCES` is `usage_error`, and both name `--listen`.

### The mutation token

One token per process: 32 random bytes, hex-encoded, held only in memory. It is
never written to disk, never logged, never placed in a URL, a query string, an
SSE frame, an error, or a diagnostic. It reaches the page in exactly one place,
the root `data-signals` object of a rendered document, and it travels back in
exactly one place, the request header `X-Novamira-Dashboard-Token`. There is no
request-body form of the token, and no `GET` the dashboard renders includes it in
the signal scope it sends, because a `GET`'s signals are serialized into the
query string. Verification is a constant-time comparison over
equal-length values and runs on **every** `/_dashboard/*` route regardless of
method, before the handler. A missing or invalid token is HTTP `403` with the
failure envelope, code `usage_error`, the fixed message
`The dashboard mutation token is missing or invalid.` and no `details`.

### The loopback request guard

On every request, whatever the route: `Host` must be present and name one of the
accepted loopback hosts — a `Host` with no host component, such as `:8787`, is a
malformed authority and is refused — and its port, when present, must equal the
bound port; an `Origin`, when present, must be `http://` one of the same hosts on
the bound port, with no exemption for the opaque value `null`;
`Sec-Fetch-Site`, when present, must be `same-origin` or `none`. A
violation is HTTP `403` with the failure envelope, code `usage_error`, the fixed
message `The dashboard accepts loopback requests only.` and no `details`.
Neither rejection ever echoes what the caller sent.

### Security headers

Applied to every response — pages, JSON, assets, errors and SSE:

```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'
X-Frame-Options: DENY
Cross-Origin-Resource-Policy: same-origin
```

`'unsafe-eval'` is required because Datastar evaluates its expressions;
`'unsafe-inline'` is never present, so the dashboard emits no inline script and
no interpolated `style` attribute. Pages are `Cache-Control: no-store`.

### Routes

| Path | Method | Token |
| --- | --- | --- |
| `/assets/…` | GET, HEAD | no |
| `/` | GET | no |
| `/providers` | GET | no |
| `/sites` | GET | no |
| `/how-to-use` | GET | no |
| `/push` | GET | no |
| `/push/new` | GET | no |
| `/novamira-setup` | GET | no |
| `/diagnostics` | GET | no |
| `/history` | GET | no |
| `/mcp` | GET | no |
| `/mcp/novamira-hq.mcpb` | GET | no |
| `/_dashboard/mcp/connect` | POST | yes |
| `/_dashboard/mcp/verify` | POST | yes |
| `/_dashboard/app/acknowledge` | POST | yes |
| `/_dashboard/pushes/plan` | POST | yes |
| `/_dashboard/pushes/apply` | POST | yes |
| `/settings` | GET | no |
| `/_dashboard/providers/save` | POST | yes |
| `/_dashboard/providers/remove` | POST | yes |
| `/_dashboard/providers/validate` | POST | yes |
| `/_dashboard/sites` | GET | yes |
| `/_dashboard/connect` | POST | yes |
| `/_dashboard/site-profiles/connect` | POST | yes |
| `/_dashboard/site-profiles/logout` | POST | yes |
| `/_dashboard/site-profiles/rename` | POST | yes |
| `/_dashboard/site-profiles/remove` | POST | yes |
| `/_dashboard/pushes/save` | POST | yes |
| `/_dashboard/pushes/remove` | POST | yes |
| `/_dashboard/setup/start` | POST | yes |
| `/_dashboard/setup/jobs/<id>` | GET | yes |
| `/_dashboard/setup/jobs/<id>/stream` | GET | yes |
| `/_dashboard/diagnostics/doctor` | GET | yes |
| `/_dashboard/diagnostics/capabilities` | GET | yes |
| `/_dashboard/updates/check` | GET | yes |
| `/_dashboard/updates/install` | POST | yes |

`/` renders first-run onboarding when neither the hosting-profile list nor the
site CLI's site list holds anything to show, and opens Sites otherwise. An
unknown path is `404` with a `not_found`
failure envelope; a known path with the wrong method is `405` with an `Allow`
header and a `usage_error` envelope; a request body over 256 KiB is `413`.

Every `/_dashboard/*` route answers an SSE patch stream, never JSON: a handler
that fails turns its error into a `danger` notice and patches it onto the page,
so a browser waiting for patches is never left with a bare failure envelope. The
error's `code` reaches the diagnostics sink; its `details` reach nothing.
`/_dashboard/providers/save` is the only route in HQ through which a provider
secret travels — in the request body, in `providerForm.credentialValue`, once,
on its way to the credential store. It is written to `config.json` as a
`stored:<id>` reference, never as a value, and the success response explicitly
resets that signal to the empty string.

`/_dashboard/sites` is a `GET` and still requires the token: it reaches live
provider APIs and its answer is patched into the DOM. It reads its signals from
`?datastar=`, caches the provider listing for five minutes per
`(profile, include_envs)` key, and patches `#sites-status` (inner),
`#sites-result` (outer) and `#toast` (outer), in that order and no other.
`?refresh=true` bypasses the cache; a provider profile being saved or removed
drops it entirely.

`/_dashboard/connect` takes `?url=`. Hosting rows supporting setup also send
`hosting_profile` and `env`: Novamira HQ first inspects the plugin and its two
AI Abilities options through read-only provider WP-CLI. A missing, inactive or
not-ready installation opens the setup approval page, without making changes.
An inspection failure stops the flow; it is never treated as a missing plugin.
A ready installation proceeds directly to authorization. Other providers use
the existing direct authorization flow. Authorization spawns
`novamira auth login <url>` through the site-CLI integration: no shell, an argv
array, with the non-secret URL as its only site value. The URL is
normalized by the same rules `hosting novamira setup` applies before it can
reach an argv element, and a rejected URL is a `usage_error` with nothing
spawned. Child output is read for the envelope's `ok` and then discarded: a
failure is reported as one fixed sentence chosen by a reason enum, never as
subprocess text. Novamira HQ holds no site token, makes no request to the site,
and reads none of the site CLI's storage.

The four `/_dashboard/site-profiles/*` routes manage the **site CLI's** site
profiles, and are not a reintroduction of the two deleted routes named below.
Each one spawns a `novamira` command through the site-CLI integration and reads
the v1 envelope's `ok`; Novamira HQ stores nothing, holds no site token, and
makes no request to a configured site.

- `POST /_dashboard/site-profiles/connect` takes `?url=`, falling back to the
  posted `cliSites.url` signal, plus optional `cliSites.name`, and spawns
  `novamira auth login <url> [--name <name>]` under the same rules
  `/_dashboard/connect` follows. A custom name must match the site CLI profile
  grammar before it may become an argv element; an empty name lets the CLI use
  its domain-derived default.
- `POST /_dashboard/site-profiles/logout` and
  `POST /_dashboard/site-profiles/remove` take `?name=` and spawn
  `novamira auth logout --site <name>` and `novamira sites remove <name>`. The
  name must match the site CLI's own profile grammar
  (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`) before it may become an argv element;
  anything else is a `usage_error` with nothing spawned. `site_not_found` is
  reported as "already gone", which is a warning and not a failure.
- `POST /_dashboard/site-profiles/rename` takes the current name in `?name=` and
  the new name in that row's posted signal, then spawns
  `novamira sites rename <name> <new-name>`. Both names must match the same
  grammar and must differ before anything is spawned. The typed new name never
  enters a URL. A name conflict or an installed CLI without rename support is a
  fixed failure notice; child output never reaches the page.

Rename, logout, remove and row-level Reconnect re-run the site-CLI listing and
connected-state match against the warm hosting inventory, then patch
`#sites-status` (inner), `#sites-result` (outer) and `#toast` (outer). A
successful direct-site connection instead uses the one page-repaint sequence to
show a full **Site connected** completion screen with the site URL or custom
name, **Open Sites**, and **Connect another site**. A failure remains a fixed
toast. None of these paths triggers a provider call or invalidates the sites
cache.

`/_dashboard/setup/start` takes `?profile=` and `?env=`, plus the optional
display values `?site=` and `?envname=` the Sites page's link already carries.
It reads one signal subtree, `setup`; `setup.enableAiAbilities` defaults to
**false**, preserving existing settings. Selecting it requests activation on an
existing installation; new installations always enable abilities. It mints a job, runs
`hosting novamira setup`'s provisioning service — the same code path the command
uses, and therefore the same refusals, the same PHP gate and the same
compatibility preflight — detached from the request, and repaints the page with
the running job. A second start against a `(profile, environment)` that already
has a **running** job returns that job rather than installing twice. A hosting
profile that cannot be resolved is a `danger` notice and no job is created.

`/_dashboard/setup/jobs/<id>` is a prefix route with two shapes. Without a
suffix it answers one SSE patch of `#setup-work` (outer) and closes. With
`/stream` it answers a long-lived SSE response that re-renders the panel's body
into `#setup-work` (inner) at most once per second, emits a patch only when the
markup changed, and returns when the job leaves `running`, when the job is no
longer in the registry, or when the client disconnects. There is no wall-clock
cap. An unknown job id, and any other path under the prefix, is a JSON `404`
`not_found` failure envelope rather than a stream.

The job's event log and its result are process-lifetime and in memory: nothing
about a setup run is written to disk. A job records a failure as its `code` and
`message` only — `details` are never rendered, because a compatibility failure
carries the whole install record there and the envelope's redaction runs on the
JSON path alone. The result panel renders what landed on the site and the
`novamira auth login <url>` handoff; it holds no WordPress credential, username,
REST URL or site profile, because HQ produces none of those.

`/_dashboard/diagnostics/doctor` runs the same report as `novamira-hq doctor`,
bound to `--offline` and never `--fix`: a `GET` that patches a panel does not
repair the operator's filesystem permissions and makes no network request. It
patches `#diagnostics-output` (outer) and then `#toast` (outer), in that order and
no other, with the report pretty-printed inside a `<pre>`.

`/_dashboard/diagnostics/capabilities` reads its profile from `?profile=`, then
from the `diagnostics` signal subtree, which wins. An empty selection or the
`__all__` sentinel is a `danger` notice and **no provider call**. Otherwise it
reads the profile's capability document after HQ's visibility policy has omitted
destructive and access-management operations, exactly as `hosting providers
capabilities` does, and patches the same two fragments.

`/_dashboard/updates/check` reads the `latest` dist-tag and patches
`#updates-card` (outer) and then `#toast` (outer), in that order and no other.
`?silent=true` suppresses the "up to date" and "check failed" toasts but **not**
the "update available" one; it is what the card's own first-render self-check
sends.

`/_dashboard/updates/install` re-checks, and installs only when the registry
still advertises something newer — otherwise it reports "already up to date",
which is an outcome and not a failure. The package manager's stdout and stderr
are consumed by a bounded sink and **discarded**: the card renders the exact
command line that ran, never the child's output. A failure renders the
`CliError`'s message truncated to 240 characters, and never its `details`.

There is no deferred route: every path the dashboard answers is in the table
above, and every other path is a `404`. A route under `/_dashboard/` whose
`auth` is not `token` is refused when the table is built, rather than left to a
reviewer to notice — which is why the update install route has no
request-body form of the token even though Go's had one.

**`/_dashboard/sites/save` and `/_dashboard/sites/remove` are deleted, not
deferred.** They wrote WordPress site profiles; HQ holds no site credential and
has no site profiles, so the paths do not exist and never will. The
`/_dashboard/site-profiles*` rows above are a different thing wearing a similar
name: they operate on the **site CLI's** profiles, by running `novamira`, and
write nothing anywhere in HQ's own storage.

### SSE fragments

The dashboard may patch only a fixed catalog of element ids, and every
catalogued id is rendered by a shipped view. The catalog is
`main` (outer), `nav` (outer), `toast` (outer), `provider-flash` (outer),
`sites-status` (inner), `sites-result` (outer),
`setup-work` (outer **and**
inner), `diagnostics-output` (outer), `updates-card` (outer), plus one computed
id per configured provider profile for that profile's connection cell. The
catalog is closed: every id it names is rendered by a shipped view and patched by
a shipped handler. Every outer fragment's root element carries its own id; an
uncatalogued selector is a compile error, not a runtime miss.

### Pages

Nine page paths render one document each: an app shell carrying the root signal
object, a nav, a `#main` body and a `#toast`. Every mutating control on them
posts to a `/_dashboard/*` route and receives SSE patches; no page submits a
form to itself and no page reloads.

- **Home** (`/`) — the first-run onboarding only when both the hosting-profile
  list and the site CLI's site list are empty; otherwise it opens **Sites**.
- **Hosting accounts** (`/providers`) — the provider form, the configured
  table, and a per-row connection cell driven by `/_dashboard/providers/validate`.
  A new account is configured in two local steps: choose from a freshly shuffled
  provider list first, then enter the profile name and provider-specific account
  details. The second step states that configuration stays on the device, that
  it is not sent to Novamira servers, that provider credentials are used locally
  for direct provider API calls, that secrets use the OS credential store when
  available, and that the owner-only unencrypted file fallback produces a
  warning.
  Credential
  *references* are rendered, never values; there is no field, column or details
  row that could hold a secret.
- **Sites** (`/sites`) — one unified inventory. Hosting environments remain
  grouped by hosting profile. A site-CLI profile whose origin matches an
  environment is represented only on that environment row, with its credential
  state and Reconnect control. Rename and Disconnect are secondary actions
  inside a closed per-profile menu; Rename opens its own initially closed editor.
  Remove from list is offered only for unmatched URL-added profiles; the confirmation
  explains that reconnecting the URL adds the profile again and does not delete the website.
  Hosting sites offer Hide from list, covering all environments of that site.
  Visibility is a browser-local preference keyed by hosting profile and provider site ID,
  persisted in localStorage for that dashboard origin, not in CLI storage or at the provider.
  Show hidden sites reveals them with Restore to list; clearing browser storage resets
  these preferences. Hiding never logs out, deletes a profile, or changes the site.
  Configure push is a secondary environment-menu action, never an immediate push.
  Profiles that match no
  hosting environment appear once in a final **CLI only** group. The integration
  performs the one origin comparison and returns both the profile listing and
  the connection snapshot from the same `sites list` round, so the web layer
  neither compares domains nor duplicates entries. The global **Connect** menu
  follows the navigation's Sites-first order: **Site by URL** connects an
  existing Novamira site, while **Hosting account** connects a provider and
  discovers its sites. “New site” is reserved for future provider-side site
  creation. The direct-site action accepts a URL and an optional custom profile
  name, and success renders a dedicated page rather than a transient toast. CLI
  actions reread only the warm hosting inventory and never trigger provider
  calls.
- **How to use it** (`/how-to-use`) — the three-step handoff: prepare a site
  through a hosting provider or by URL, authorize it until it is Connected, then
  open the AI agent selected during Novamira HQ installation. The page states
  explicitly that Novamira HQ prepares the connection and does not contain an AI chat. It also
  prints the macOS/Linux and PowerShell `npx skills add` commands for direct npm
  installs and for registering the packaged `novamira-hq` instructions with a
  different agent; the dashboard does not spawn that interactive third-party
  installer itself.
- **Push** (`/push`, `/push/new`) — the saved environment push configurations
  as direction cards with resolved environment names, domains and scope. Sites
  offers Configure push in the menu of every eligible environment; that
  source is preselected, and a two-environment site also preselects the only
  possible target. The form then collects direction, positive scope and saved name.
  Push prepares a five-minute, one-use confirmation on a dedicated review page,
  showing source and destination URLs from the provider's current environment
  inventory and the positive scope. IDs and labels are secondary technical details.
  Dashboard planning refuses missing URLs or identical normalized source and
  destination URLs, rather than allowing confirmation based on labels alone.
  Apply rejects changed pushes and invokes only the provider's
  native push operation; it does not create a separate backup. Neither page load
  issues a provider call: both read the warm inventory only; explicit Plan and
  Apply actions contact providers.
- **Novamira Setup** (`/novamira-setup`) — the target panel, the AI-Abilities
  toggle and Start button, the live event log, and, when a run has finished, what
  landed on the site plus the `novamira auth login` handoff. `?job=<id>` reopens
  a run; `?profile=&env=` reopens the most recent run for that environment.
- **Diagnostics** (`/diagnostics`) — the provider selector, two actions (Health
  check and Check capabilities) and the output panel they patch. Neither action
  repaints `#main`, so the selection survives.
- **Settings** (`/settings`) — the update card and the configuration file's
  path, read-only. The card checks the npm registry silently on first render,
  shows the current and published versions, the registry consulted and the
  command that ran, and offers Install only when something newer exists. It
  renders no external link — the CSP is `default-src 'self'` — and no installer
  output.

### Assets

Nine files under `/assets/`, served from a fixed allowlist rather than from a
directory: `app.css`, `datastar.js`, `relative-time.js`, `sites-filter.js`,
`novamira-hq-logo-white.svg`, and under `/assets/fonts/`
`montserrat-var.woff2`, `montserrat-OFL.txt`, `jetbrains-mono-var.woff2`,
`jetbrains-mono-OFL.txt`. Any other path is `404` before any filesystem access.
Assets carry `Cache-Control: no-cache` and a strong content `ETag`; a matching
`If-None-Match` is `304` with no body. `HEAD` returns identical headers,
`Content-Length` included, with no body.

### JSON responses and the status map

The dashboard's JSON responses are the CLI's success and failure envelopes,
unchanged, with the same redaction. The taxonomy code maps to an HTTP status:

| Code | HTTP |
| --- | --- |
| `usage_error`, `credential_missing`, `credential_invalid` | 400 |
| `profile_not_found`, `not_found` | 404 |
| `conflict`, `confirmation_required` | 409 |
| `schema_validation_failed` | 422 |
| `rate_limited` | 429 |
| `config_error`, `internal_error` | 500 |
| `provider_unsupported` | 501 |
| `provider_error`, `network_error`, `server_unsupported` | 502 |
| `integration_unavailable` | 503 |
| `timeout` | 504 |

Route-level statuses are set by the dispatcher and override the map: `403` for a
token or loopback rejection, `405` for a wrong method, `413` for an oversized
body, `304` for an `ETag` match.

### Connected-state detection

The dashboard reports one of four states for a hosting environment:
`not_configured` (no site-CLI profile matches its origin), `connected` (a
matching profile holds a usable credential and its REST surface is reachable),
`reconnect_required` (every matching profile reports an absent, invalid or
expired credential, or an authentication error), and `unavailable` (the site CLI
is missing or incompatible, a child timed out, its output was malformed, or
reachability could not be established). A profile alone is never a connection.

An explicit site-CLI `server_unsupported` code is classified as
`site_incompatible`, not as a broken CLI or generic network failure. The fixed
hint explains that the plugin may be missing, inactive or incompatible, or that
required AI Abilities may be unavailable, without exposing child output or
guessing which specific requirement failed. The visible state is **Novamira not
ready**, not **Unknown**. A matched hosting environment keeps its **Setup
Novamira** action; a CLI-only profile tells the operator to install or update
Novamira on the site and reconnect. Connect still makes no hosting mutation and
never installs a plugin or enables abilities.

Detection runs `novamira --json --quiet --timeout <ms> sites list` once, matches
normalized origins against hosting environments, and then runs
`novamira --json --quiet --timeout <ms> --site <name> auth status` for the
matched profiles only, with bounded concurrency. The executable is run directly
with an argv array and never through a shell; each child has its own timeout and
shares one overall refresh deadline, and captured output is capped and discarded
after parsing. A killed child — timeout, refresh deadline, or output cap — is
terminated as its whole process tree, so a descendant can neither outlive the
deadline nor hold the outcome open through an inherited pipe. HQ never reads the site CLI's configuration, profile store,
credential storage, keychain records, or `NOVAMIRA_HOME`. Integration failure is
always a connection state and never a hosting error, so every other dashboard
capability works with `novamira` absent.

### The `dashboard` command

`novamira-hq dashboard [--listen <address>] [--open]`. It declares no
`--timeout`: the name is a reserved global and a long-running server has no
operation deadline. The command binds first, then emits exactly one envelope —
`data` is `{ "url", "host", "port", "configFile" }` in JSON mode, and two lines
in human mode:

```
Novamira HQ dashboard: http://127.0.0.1:8787
Config: /home/…/.config/novamira-hq/config.json
```

Nothing is written to stdout for the rest of the run. `--open` launches the
platform URL opener with an argv array and no shell; a failure is a warning,
never fatal. Without `--listen`, HQ prefers `127.0.0.1:8787` and tries the next
nine ports when earlier ones are occupied. With `--open`, it first looks across
that range for an HQ dashboard, verifies its identity from its HTTP response,
opens it, and exits 0 instead of starting a second server. An explicit
`--listen` is exact: an unrelated listener remains a `conflict`. `SIGINT` and
`SIGTERM` stop the listener and the command exits 0.

## Doctor

`novamira-hq doctor [--offline] [--fix]`. Both options are command-local.

The report is a `{ version: 1, offline, fix, status, checks }` object, and in
JSON mode `data` **is** that object. Each check is
`{ id, status, summary, evidence, fixed? }`, where `status` is `pass`, `warn` or
`fail`, `summary` is one stable sentence, and `evidence` is output-safe
structured detail. The report's `status` is the worst member of `checks`.

The check identifiers and their order are frozen:

| # | id | Answers |
| --- | --- | --- |
| 1 | `runtime.node` | is the Node runtime at or above the supported major (22)? `fail` below it |
| 2 | `storage.permissions` | are HQ's private paths owner-only? `fail` when one exists and is not, `warn` when none exists yet |
| 3 | `storage.atomic` | does the state directory support the atomic write pattern every HQ write uses? |
| 4 | `credential.backend` | did an OS credential service resolve, or the owner-only file fallback? `warn` for the fallback |
| 5 | `config.schema` | does `config.json` parse against the v1 schema? `warn` when it does not exist yet |
| 6 | `profile.credentials` | does every hosting profile's credential reference resolve? **never `fail`** |
| 7 | `skills.bundled` | are the packaged agent skills readable, non-empty, and still carrying their cross-references? |
| 8 | `integration.site_cli` | is `novamira` installed and at or above the minimum version? **never `fail`** |
| 9 | `update.available` | is a newer `@novamira/hq` published? `warn` when one is, `warn` when the registry could not be reached, `pass` otherwise. **never `fail`**; skipped entirely under `--offline` |

Checks run **sequentially**, never concurrently. A check that throws is isolated
as `{ status: "fail", summary: "The check could not be completed.", evidence: { error: "check_threw" } }`
and does not suppress any later check; the thrown error's message never reaches
the report.

**A completed report is a successful invocation.** Exit 0 and `ok: true`, even
when the overall status is `warn` or `fail`. Only a failure to *produce* a report
uses the normal typed nonzero contract.

`profile.credentials`, `integration.site_cli` and `update.available` can never
be `fail`. One
unresolvable credential reference must not condemn an installation whose other
profiles work, and `@novamira/cli` is an optional integration — hosting
inventory, provider actions, provisioning and plugin-installed status all work
without it, and only the dashboard's connected-state detection and Connect action
degrade. A fresh install has neither profiles nor the site CLI and must report
`warn`, not `fail`.

`--offline` performs no network operation of any kind: `update.available` is
**removed from the report** rather than run and recorded as skipped, so an
offline report carries eight checks, and the background release notice is
suppressed for the invocation. `--fix` is limited to repairing
owner-only permissions on HQ's private paths and initializing the state
directory: it writes no credential, removes no profile, edits no configuration
and calls no provider. A check sets `fixed: true` only when `--fix` actually
changed state and the reinspection proves the relevant condition now passes: it
is evidence of a repair performed, never of the flag being supplied. `--profile`,
when given, narrows `profile.credentials` to that profile and changes nothing
else.

Evidence is output-safe by construction. `profile.credentials` renders
`env:NAME` / `file:PATH` / `stored:ID` and a boolean, never a secret value;
`storage.permissions` renders target *labels*, never directory contents;
`integration.site_cli` renders the resolved executable path, the reported
version, a reason enum and a fixed hint, and never any child output. Human mode
prints one aligned `status  id  summary` line per check plus a trailing
`status: <overall>` and never prints evidence; `--verbose` emits evidence as a
redacted stderr diagnostic per non-passing check.

## Update

`novamira-hq update [--check]`. One command, one command-local option, matching
`@novamira/cli`'s grammar so an operator learns it once. There is no `upgrade`
alias and no `update check` / `update install` subcommand.

This updater applies to the **npm distribution only**. The standalone desktop
app refuses these dashboard update actions with an explanatory message before
any registry read or package-manager spawn; updating its separate binary requires
a newer desktop release. The published npm version is read from the npm
registry's dist-tag endpoint for `@novamira/hq` — one anonymous `GET` over
HTTPS, carrying `Accept` and nothing else: no cookie, no `Authorization`, no npm
token, and **no profile, credential, provider or telemetry data**. Redirects are
refused rather than followed, the response is read incrementally and abandoned at
64 KiB, and a `latest` that is not a valid SemVer is a `network_error` rather
than an install specifier. Plain HTTP is refused except for a loopback registry
with `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1`; a registry URL carrying credentials is
a `usage_error`. HQ makes no request to GitHub.

Installing runs a package manager and never replaces an executable in place:
`npm install --global --ignore-scripts --registry <registry> @novamira/hq@<version>`
(`npm.cmd` on Windows), or `bun add --global --registry <registry> @novamira/hq@<version>`
when the running module resolves under a Bun global install. The registry that
answered the version is the registry installed from. The child is spawned with an
argv array and no shell; its stdout and stderr go to **stderr only** and never to
stdout, so `--json` still emits exactly one envelope. An explicitly given
`--timeout` bounds the installer process as well as the registry request;
otherwise the installer's own five-minute deadline applies.

`data` is `{ current, latest, updateAvailable }` for `--check`, the same plus
`updated: false` for a bare `update` with nothing newer, and
`{ updated: true, from, to, command }` after an install — where `command` is the
exact command line that ran, so a failed install can be repeated by hand. A
non-zero installer exit is an `internal_error` naming that command.

### The background release notice

After a successful invocation HQ may write one line to stderr:
`A new novamira-hq release is available: <current> -> <latest>. Run "novamira-hq update" to install it.`
It never touches stdout and never changes an exit code, and every failure inside
it is silent.

It is backed by `state/update-check.json` (see "Storage namespace"): at most one
registry request per 24 hours per registry, with the lock held across the request
so concurrent invocations do not duplicate it.

It is suppressed — meaning **no request is made and no state is written**, not
merely that no line is printed — when any of these holds: `--quiet`; `--json`;
`NOVAMIRA_HQ_UPDATE_CHECK=0` or `false`; the command was `dashboard`, whose
handler blocks until the listener stops; the command was `doctor --offline`; or
stderr is not a terminal. The last is the one that matters most in practice: HQ
is an agent-facing tool, and a scripted or piped invocation performs no network
work its caller did not ask for.

## Connect your AI and app acknowledgement

`/mcp` first asks for the AI client, then renders only that client's setup.
The token-protected POST `/_dashboard/mcp/connect` uses the client's official
command-line registration command: `codex mcp add` for the configuration shared
by ChatGPT Desktop, Codex CLI and the IDE extension, or `claude mcp add` at user
scope for Claude Code. It spawns an argv array with `shell: false`, displays no
child output and copies no provider credential. Claude Desktop JSON and Codex
TOML remain hidden in Manual configuration disclosures as fallbacks. The npm
distribution launches the stable installed command `novamira-hq mcp`, never a
versioned Node executable or a package-internal `dist/index.js`; it includes the
dashboard process' executable search path so a GUI client can resolve that
installed command. The standalone desktop distribution keeps using its own
embedded executable and `--mcp`. Both forms use fixed argv and copy only the
executable search path and Novamira HQ path overrides, never provider secrets.
The optional `novamira` site CLI is resolved separately by Novamira HQ and is
not another MCP server or part of the generated client configuration.
Claude Desktop's primary action downloads `/mcp/novamira-hq.mcpb`, a ZIP
generated in memory using the manifest-and-launcher format from Novamira.
It contains a manifest, fixed launch settings and a stdio launcher for the
existing installation. No package is downloaded or installed by the launcher.
The read-only download uses the dashboard's loopback and origin guards and is
served as an attachment with `Cache-Control: no-store`. It contains only the
same launch information as the manual configuration. The user opens the file
in Claude Desktop and confirms installation. The page explains that action and
suggests asking the AI to list sites; provider diagnostics and skill details
remain on their dedicated pages. It never claims an external connection was verified.
There are no access presets or per-profile permission switches; all supported
typed tools are exposed at launch. Profiles follow Novamira HQ configuration
dynamically, and configured credentials are not validation.

The token-protected POST `/_dashboard/mcp/verify` spawns the configured local
entry point and sends only initialize, initialized and tools/list. Output is
bounded to 256 KiB and startup to ten seconds. Failure output is not displayed.
Success proves local startup only, not an external client connection or working
provider credentials. The desktop's `--mcp` role calls the existing `mcpMain`
without importing webview or depending on a running dashboard.

The dashboard shows an initial explanation of PHP/filesystem/data access and
autonomous AI Abilities activation. POST `/_dashboard/app/acknowledge` records
version 1 and acceptedAt in the owner-only state/app-acknowledgement.json, resolved
through config/paths.ts. This is application onboarding, not an authorization
checked by CLI/MCP, not per hosting, and not revocable. Connecting a site does
not activate abilities; explicit setup may. No WordPress site token is stored.

## Local hosting history

The dashboard exposes Hosting history from Diagnostics, not as a main navigation
item. The history page highlights Diagnostics and links back to it. Both pages
explicitly exclude WordPress CLI operations, including those delegated by HQ MCP.

Sites renders its latest process-local snapshot immediately and refreshes in the
background on mount, without clearing existing rows. One Refresh button forces
an update. Automatic loads reuse the five-minute provider cache while refreshing
CLI connection state. Provider failures are isolated by hosting profile: healthy
profiles update, while a failed profile retains its last successful site listing
with a local warning that API failure does not establish site downtime. CLI
connection checks still run for those retained environments. The page timestamp
remains conservatively anchored to the older snapshot while any provider listing
is retained. Snapshots can outlive the provider cache and are cleared on
configuration invalidation or process restart. They never authorize mutations.

`history [--profile <name>]`, `hosting_history_list`, and `/history`
share state/hosting-history.json. Reads are local and never poll or replay a
provider mutation. Actions record intent before dispatch, and atomic writes are
serialized across processes. Records contain IDs, channel, target, safe scope,
timestamps and error codes; never commands, PHP, payloads, credentials or raw
provider output. Setup and restore child requests share a workflow ID and
separate running/succeeded/failed workflow outcome. A workflow failure never
claims earlier requests were undone. A crashed workflow remains unresolved.

Request states distinguish accepted from succeeded, failed and needs_verification.
Only positive provider evidence marks an operation completed. Last observed is
not continuous monitoring; refresh only reads disk. Attention uses recorded
uncertainty/failure and gives a provider-check next step. A newer successful
equivalent action supersedes an older failure notice, not its historical record.

Retention is bounded to 500 records and evicts terminal work only. It never
silently drops unresolved requests: when all slots are unresolved, another
mutation fails before dispatch with an actionable conflict. Corrupt or unsafe
history also fails closed. A post-dispatch persistence failure instructs the
operator to verify at the provider before retrying.

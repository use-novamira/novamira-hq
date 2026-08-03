# Novamira HQ v1 Contract

Status: contract skeleton — the filled sections are normative and implemented;
sections marked **RESERVED** are planned but not yet decided or shipped.

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

The package has no lifecycle setup, downloaded runtime, required native
executable or addon, and no native keychain module: OS credential storage uses
inbox platform commands. `@novamira/cli` is an optional integration and is never
a runtime, package, or peer dependency.

## Boundary

HQ never holds a WordPress site token, never calls a WordPress REST route on a
configured site's behalf, and never proxies an Ability. The v1 schema has no
site profiles, HQ issues no Application Password, and HQ never reads the site
CLI's configuration or credential storage. The only site-directed request v1
permits is the public, unauthenticated plugin compatibility metadata read used
by the provisioning preflight.

## Global options

Global options are `--profile <name>`, `--json`, `--quiet`, `--verbose`,
`--no-color`, `--yes`, `--timeout <ms>`, `--version`, and `--help`. `NO_COLOR`
has the same color-disabling effect as `--no-color`.

`--profile` selects the hosting profile. A profile is never inferred: a command
that needs one and is given none fails `usage_error` with the configured profile
names in `details.profiles`. No command accepts a secret-valued option.

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
| 4 | `provider_unsupported`, `provider_error`, `network_error`, `timeout`, `rate_limited`, `not_found`, `conflict`, `integration_unavailable` |
| 5 | `schema_validation_failed` |
| 6 | `confirmation_required` |

Exit 0 always has `ok: true`; nonzero exits always have `ok: false`. Code
meanings are fixed: `profile_not_found` is a missing local hosting profile or
deploy path, `not_found` is a missing remote provider resource,
`credential_invalid` covers provider 401/403 and unusable local credential
records, `provider_unsupported` is an operation a provider deliberately does not
implement, and `integration_unavailable` is the optional `novamira` CLI being
absent, incompatible, or unusable.

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
  "deployPaths": {
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

Names — map keys, hosting profile names, and deploy path names — match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a violation is a `usage_error`. A structural
problem is a `config_error`; a field problem is a `schema_validation_failed`
carrying the exact dotted path. A deploy path's `sourceEnvId` must differ from
its `targetEnvId`; its `hostingProfile` need not already exist. A missing
configuration file loads as an empty version-1 document.

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
platform commands invoked without a shell — macOS `security`, Linux
`secret-tool`, Windows Credential Manager through PowerShell `Add-Type` P/Invoke
of Advapi32 — with an explicit owner-only file fallback under
`credentials/v1/<id>.json` selected only when the platform command is
unavailable or is explicitly requested. The file fallback is not OS-backed
encryption and warns on first use.

All writes use a cross-process lock, an owner-only temporary file, and atomic
replacement. Unix directories and files are verified `0700` and `0600` with the
current UID; Windows verifies a protected ACL owned by the current SID with a
single full-control allow rule for that SID. Contract tests resolve both HQ's
and the site CLI's paths against one fake home on Linux, macOS, and Windows and
assert every resulting path and credential service is distinct.

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

The command surface has exactly two top-level groups: `config`, for local HQ
configuration and hosting profiles, and `hosting`, for provider resources. There
is no `site` group and no command that reaches a configured WordPress site.

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
rather than of its body — `--env` and `--target-env` on the commands addressed
per environment, `--domain` on the DNS record commands, and `--site` where a
command requires it — must be non-empty even with `--from-json`, because no body
can supply it. Omitting one is a `usage_error` naming the flag in
`details.flag`, raised before any provider request. Missing body fields are
reported the same way.

A secret is always named and never given: a command that needs one registers
`--<name>-env <variable>`, `--<name>-stdin`, and `--<name>-file <path>`, and
exactly one must be supplied. No option anywhere accepts a secret value, so no
secret enters argv. Trailing newlines are trimmed from the stdin and file
sources; an absent or empty secret is `credential_missing`. `hosting access ssh
password` writes the provider-generated password to an owner-only file and
reports only `{ "path": …, "value": "********" }`.

Repeatable options accumulate: `--domain-id`, `--value`, `--add-value`,
`--remove-value`, `--ip`, `--file`, and `--name` on the `update-all` commands.
Boolean options default to false unless documented otherwise, and a
true-defaulting boolean also registers its `--no-` form.

A command that polls a provider operation takes `--interval-seconds` (default 5,
must be greater than zero) and `--timeout-seconds` (default 300). An exhausted
budget is a retryable `timeout`; an operation the provider reports as failed is
a `provider_error`.

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
| `sites` | `list`, `get <site_id>`, `create`, `create-plain`, `clone`, `reset <site_id>` |
| `envs` | `list`, `get <env_id>`, `create`, `create-plain`, `clone`, `push`, `delete <env_id>` |
| `domains` | `list`, `add`, `delete`, `verify <site_domain_id>`, `primary` |
| `dns` | `domains list`, `records list`, `records create`, `records update`, `records delete` |
| `backups` | `list`, `downloadable`, `create`, `restore`, `delete <backup_id>` |
| `cache` | `clear` |
| `php` | `restart`, `set-version` |
| `redirects` | `list`, `apply` |
| `denied-ips` | `list`, `set` |
| `wp` | `plugins list`, `plugins install`, `plugins update`, `plugins update-all`, `themes list`, `themes update`, `themes update-all` |
| `wp-cli` | `run` |
| `logs` | `get` |
| `analytics` | `usage`, `env` |
| `access` | `ssh status`, `ssh set-status`, `ssh allowlist`, `ssh set-allowlist`, `ssh config`, `ssh generate-password`, `ssh password`, `ssh set-password-status`, `ssh change-expiration`, `sftp list`, `sftp toggle`, `sftp add`, `sftp remove <sftp_account_id>` |

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
resolves to the newest published Novamira plugin zip. `hosting activity list
--api-key` names a provider-side API key **identifier**, never a key value.

Read commands render the provider response unchanged under `data`; action
commands render the provider's action result; `hosting providers capabilities`
renders the provider's capability list with `sites.delete` forced to unsupported.

### Not in the v1 command surface

- **`hosting sites delete` is not registered.** HQ reports `sites.delete` as an
  unsupported capability for every provider, and offers no command that deletes
  a site. The provider-neutral delete request still exists for the dashboard's
  future use, but no CLI grammar reaches it.
- No command prompts, and no command reads standard input except through
  `--from-json -`, `--command-stdin`, and the `-stdin` secret sources.
- Deploy-path commands are not shipped. `deployPaths` is reserved in the
  configuration schema and no v1 command reads or writes it.
- No `site` group, no Application Password option, and no Ability proxying, per
  the boundary above.

## Provisioning and handoff

**RESERVED.** The contract for plugin installation, the PHP-compatibility and
site-CLI compatibility preflight, and the emitted handoff is not yet frozen.
What is already decided: the flow ends after the plugin is installed, activated,
and configured, and emits a handoff naming `novamira auth login <url>` with the
JSON equivalent under `data`. HQ writes no site credential, stores no site
profile, and creates no WordPress user. The compatibility preflight reads public
unauthenticated metadata only; any field that turns out to require
authentication is dropped from the preflight rather than fetched.

## Local dashboard

**RESERVED.** The dashboard's routes, SSE patch contract, and view surface are
not yet frozen. What is already decided: it binds to loopback only, requires a
per-process mutation token, reuses the same JSON envelope for its JSON
responses, and uses Datastar with the official SDK for SSE. Connected-state
detection and the Connect action spawn the `novamira` executable directly with an
argv array and no shell, under bounded timeouts, and are disabled with an install
hint when the CLI is absent or incompatible; every other dashboard capability
works without it.

## Doctor and update

**RESERVED.** The check identifiers, report shape, and update contract are not
yet frozen. What is already decided: doctor reports a warning rather than a
failure when the optional `novamira` CLI is missing or incompatible, and a
completed report is a successful invocation even when its overall status is
`warn` or `fail`.

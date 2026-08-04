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
CLI's configuration or credential storage.

The only site-directed request v1 permits is one
`GET {siteUrl}/.well-known/oauth-protected-resource` per `hosting novamira
setup` invocation: the public, unauthenticated plugin compatibility metadata the
provisioning preflight reads. It carries `Accept` and `User-Agent` and nothing
else — **no `Authorization` header, ever**, and no `Cookie`. No other URL on a
configured site is requested, and a metadata field that turns out to require
authentication is dropped from the preflight rather than fetched.

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
| 4 | `provider_unsupported`, `provider_error`, `network_error`, `timeout`, `rate_limited`, `not_found`, `conflict`, `integration_unavailable`, `server_unsupported` |
| 5 | `schema_validation_failed` |
| 6 | `confirmation_required` |

Exit 0 always has `ok: true`; nonzero exits always have `ok: false`. Code
meanings are fixed: `profile_not_found` is a missing local hosting profile or
deploy path, `not_found` is a missing remote provider resource,
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
configuration and hosting profiles, and `hosting`, for provider resources, plus
the single top-level command `dashboard`. There is no `site` group and no
command that reaches a configured WordPress site.

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
| `novamira` | `setup` |
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
resolves to the newest published Novamira plugin zip. `hosting novamira setup
--source` **defaults** to `novamira-latest`; `hosting wp plugins install
--source` has no default and must be given. `hosting activity list --api-key`
names a provider-side API key **identifier**, never a key value.

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
| `--ai-abilities` / `--no-ai-abilities` | boolean | `true` |
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
the provider is touched.

The environment then runs these WP-CLI commands, in this order:

| # | Command | Skipped when |
| --- | --- | --- |
| 1 | `wp eval 'echo PHP_VERSION;'` | never |
| 2 | `wp option get siteurl` | `--no-preflight` |
| 3 | `wp plugin install <resolved source>` | never |
| 4 | `wp plugin status <slug>` | no activation is requested, or the source names no slug |
| 5 | `wp plugin activate <slug>` | as 4, and when 4 reports the plugin already active |
| 6 | `wp option get home` | `--url` was given |
| 7 | `wp option update novamira_ai_abilities_enabled 1` | `--no-ai-abilities` |
| 8 | `wp option update novamira_ai_abilities_domain <host>` | `--no-ai-abilities` |

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
| the release API or a remote `--source` unreachable, and compatibility metadata still unreachable after its retries | `network_error`, retryable |
| the release metadata is unparseable | `schema_validation_failed` |
| the release carries no Novamira zip, or a remote `--source` is not downloadable | `not_found` |
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
    "source": "https://github.com/use-novamira/novamira/releases/download/v1.11.1/novamira-1.11.1.zip",
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
`null`, and `ready` is `null`; otherwise `ready` is `true`. `ai_abilities.domain`
is `null` under `--no-ai-abilities`. `next_step.command` is argv a caller may
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

`novamira-hq dashboard` serves a local web dashboard. Its transport, security
and route surface are frozen below. **The view surface — the rendered pages,
their forms, and their SSE fragments beyond the app shell — remains RESERVED.**

### Binding

`--listen <address>` (default `127.0.0.1:8787`) accepts `:PORT`, `PORT`,
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
| `/deploy-paths` | GET | no |
| `/deploy-paths/new` | GET | no |
| `/novamira-setup` | GET | no |
| `/diagnostics` | GET | no |
| `/settings` | GET | no |

`/` renders the providers page. An unknown path is `404` with a `not_found`
failure envelope; a known path with the wrong method is `405` with an `Allow`
header and a `usage_error` envelope; a request body over 256 KiB is `413`.

Deferred, and answering `404` until they ship: `/_dashboard/providers/{save,
remove,validate}`, `/_dashboard/sites`, `/_dashboard/deploy-paths/{save,remove}`,
`/_dashboard/setup/start`, `/_dashboard/setup/jobs/…`, `/_dashboard/connect`,
`/_dashboard/diagnostics/{doctor,capabilities}` and
`/_dashboard/updates/{check,install}`. Every one of them requires the token when
it ships: a route under `/_dashboard/` that does not require it is refused when
the table is built, not left to a reviewer to notice.

**`/_dashboard/sites/save` and `/_dashboard/sites/remove` are deleted, not
deferred.** They wrote WordPress site profiles; HQ holds no site credential and
has no site profiles, so the paths do not exist and never will.

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

Detection runs `novamira --json --quiet --timeout <ms> sites list` once, matches
normalized origins against hosting environments, and then runs
`novamira --json --quiet --timeout <ms> --site <name> auth status` for the
matched profiles only, with bounded concurrency. The executable is run directly
with an argv array and never through a shell; each child has its own timeout and
shares one overall refresh deadline, and captured output is capped and discarded
after parsing. HQ never reads the site CLI's configuration, profile store,
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
never fatal. `SIGINT` and `SIGTERM` stop the listener and the command exits 0.

## Doctor and update

**RESERVED.** The check identifiers, report shape, and update contract are not
yet frozen. What is already decided: doctor reports a warning rather than a
failure when the optional `novamira` CLI is missing or incompatible, and a
completed report is a successful invocation even when its overall status is
`warn` or `fail`.

# Novamira HQ

`novamira-hq` is the hosting-side command-line tool and local dashboard for
Novamira.

It manages hosting-provider profiles and provider API credentials, operates
provider resources — sites, environments, backups, domains, caches, DNS, plugins
and themes, SSH and SFTP access — and provisions the Novamira plugin so a site
becomes ready for an agent to use.

HQ stops there. It never holds a WordPress site token, never calls a WordPress
REST route on a configured site's behalf, and never proxies an Ability. Once a
site is provisioned, agents talk to it through the separate
[`@novamira/cli`](https://github.com/use-novamira/novamira-cli) tool.

## Status

The port of the Go `novamira-hub` is complete. Every command, route and page
described in [`docs/v1-contract.md`](docs/v1-contract.md) is implemented, and
that document is normative throughout — nothing in it is marked as planned. No
release has been published to npm yet.

What the repository contains: the error and exit-code taxonomy, the JSON output
envelope, HQ's storage namespace with locking, atomic writes and owner-only file
permissions, the `config.json` v1 schema and store, keychain-backed provider
credentials, the shared HTTP client with retry, timeout and redacted
diagnostics, the eight provider clients, the whole `config` and `hosting`
command line, the provisioning flow behind `hosting novamira setup`, the bundled
agent skills behind `skills`, the local installation report behind `doctor`,
npm-only self-update behind `update`, the two installer scripts, and the local
dashboard — all eight pages, including Diagnostics, which runs the same report
`doctor` does, and Settings, which carries the update card.

One thing is deliberately _not_ frozen: the markup inside a dashboard page,
beyond the app shell. A page's routes, its SSE fragments, its security model and
what it may and may not do are contract; the elements it renders are not.

## Requirements

- Node.js 22 or newer
- An API credential for a supported hosting provider

Supported providers: Kinsta, InstaWP, Pantheon, Pressable, WP Engine,
Rocket.net, Hostinger, and Cloudways.

## Install

Once published, the installers set up HQ, register its agent skill with the
agent of your choice, smoke-test the result with `novamira-hq doctor --offline`,
and install the `@novamira/cli` site CLI alongside it:

```sh
curl -fsSL https://raw.githubusercontent.com/use-novamira/novamira-hq/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/use-novamira/novamira-hq/main/install.ps1 | iex
```

Both require Node.js 22+, `npm` and `npx`. Set `NOVAMIRA_HQ_AGENT` (for example
`NOVAMIRA_HQ_AGENT=opencode`) to pick the agent non-interactively; without it the
skill step asks, and needs a terminal to ask on.

The site CLI is installed last, as a separate global package — never a
dependency of `@novamira/hq` — so that connected-state detection and the
dashboard's Connect action work on a fresh machine. Set
`NOVAMIRA_HQ_SKIP_SITE_CLI=1` to skip it. If that step fails, the installer says
so and still exits 0: HQ is already installed at that point, and everything
except the one dashboard panel works without the site CLI.

Or install the package alone, without the agent skill or the site CLI:

```sh
npm install -g @novamira/hq --ignore-scripts
novamira-hq --version
```

Until then, build it from a checkout:

```sh
bun install
bun run build
node dist/index.js --version
```

The executable is `novamira-hq`. It does not collide with the site CLI's
`novamira` executable, and the two tools share no configuration, state, cache,
credential, or keychain storage.

## Configuration

HQ keeps a single `config.json` holding hosting profiles and deploy paths. A
hosting profile names a provider, an optional company or account id, an optional
API base URL, and a reference to a credential — never the credential itself. A
credential reference is one of:

- `env` — the name of an environment variable, for example `KINSTA_API_KEY`;
- `file` — the path of an owner-only file containing the secret;
- `stored` — an opaque id for a secret held in the OS keychain (`ai.novamira.hq`)
  with an owner-only file fallback.

`stored` never means a plaintext secret in `config.json`. No HQ command accepts a
secret as a command-line option; secrets come from an environment variable, a
file, or standard input.

Storage locations, which are deliberately disjoint from the site CLI's:

| Platform | Config                                                  | State / credentials                               | Cache                              |
| -------- | ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/novamira-hq/config.json`              | `$XDG_STATE_HOME/novamira-hq`                     | `$XDG_CACHE_HOME/novamira-hq`      |
| macOS    | `~/Library/Application Support/Novamira HQ/config.json` | `~/Library/Application Support/Novamira HQ/State` | `~/Library/Caches/Novamira HQ`     |
| Windows  | `%APPDATA%\Novamira HQ\config.json`                     | `%LOCALAPPDATA%\Novamira HQ\State`                | `%LOCALAPPDATA%\Novamira HQ\Cache` |

### Environment variables

| Variable                          | Effect                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `NOVAMIRA_HQ_HOME`                | relocate the whole tree — `config.json`, `state/`, `cache/`, `credentials/` — under one root |
| `NOVAMIRA_HQ_CONFIG`              | override the configuration file path only                                                    |
| `NOVAMIRA_HQ_SITE_CLI`            | absolute path to the `novamira` executable, for connected-state detection                    |
| `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP` | set to `1` to let `hosting novamira setup` accept a plain-HTTP site URL that is not loopback |
| `NOVAMIRA_HQ_UPDATE_CHECK`        | set to `0` to disable the daily update notice entirely — no request, no state written        |
| `NOVAMIRA_HQ_REGISTRY`            | alternate npm registry for `update` and the update notice                                    |
| `NOVAMIRA_HQ_AGENT`               | agent the installers register the bundled skill with; read by `install.sh` / `install.ps1`   |
| `NO_COLOR`                        | disable ANSI color, like `--no-color`                                                        |

The site CLI's `NOVAMIRA_HOME`, `NOVAMIRA_ALLOW_INSECURE_HTTP`,
`NOVAMIRA_UPDATE_CHECK` and `NOVAMIRA_REGISTRY` are never read.

## Commands

Three top-level groups plus three commands: `config` manages HQ's own
configuration and its hosting profiles, `hosting` operates provider resources
through one profile, `skills` prints the bundled agent instructions, `dashboard`
serves the local web UI, `doctor` checks the installation, and `update` installs
a newer release.

```sh
novamira-hq config add kinsta --credential-env KINSTA_API_KEY
novamira-hq config list

novamira-hq skills list
novamira-hq skills get hosting
novamira-hq doctor --offline
novamira-hq update --check
novamira-hq dashboard --open

novamira-hq --profile kinsta hosting providers validate
novamira-hq --profile kinsta hosting sites list --include-envs
novamira-hq --profile kinsta hosting backups create --env <env-id> --tag nightly
novamira-hq --profile kinsta hosting wp plugins install --env <env-id> \
  --source novamira-latest
```

`hosting` covers provider inventory and capabilities, sites and environments,
domains and DNS, backups, cache, PHP, redirects, denied IPs, WordPress plugins
and themes, WP-CLI, logs, analytics, and SSH/SFTP access. `--profile` is
required and never inferred, and every command accepts `--json`. Run
`novamira-hq hosting --help` for the tree, or see
[`docs/v1-contract.md`](docs/v1-contract.md) for the normative surface.

## Dashboard

```sh
novamira-hq dashboard                          # http://127.0.0.1:8787
novamira-hq dashboard --listen localhost:9000 --open
```

The dashboard is HQ's interactive surface — it is what the CLI has instead of
prompts. It binds to **loopback only**: `--listen` accepts `:PORT`, `PORT`,
`HOST:PORT` or `[IPv6]:PORT`, and the host must be `localhost`, an address in
`127.0.0.0/8`, or `::1`. Anything else is refused before a socket is opened, so
the dashboard cannot be exposed to a network by accident. Every mutating route
additionally requires a per-process token that only the served page carries, and
every request is checked against a loopback `Host` and `Origin`, so a page on
another site cannot drive it.

What it does:

- **Hosting Providers** — add, edit and remove provider profiles, and check a
  profile's API credential. The credential is posted once and handed to the
  credential store; the page only ever shows the reference (`env:NAME`,
  `stored:ID`), never a value.
- **Sites** — browse hosting sites and Novamira CLI profiles in one list. A CLI
  profile matched to a hosting environment appears only on that environment;
  unmatched profiles appear once under **CLI only**. The list exposes credential
  state, expiry, Reconnect, Sign out and Remove, and the New menu can connect a
  CLI site by URL with an optional custom profile name. Hosting inventory stays
  cached for five minutes; CLI actions use that warm inventory and never call a
  provider. Every CLI control runs one `novamira` command — HQ stores nothing
  and never talks to the site itself.
- **Deploy paths** — create and remove the environment-to-environment paths.
  Running one is not part of this release.
- **Novamira Setup** — install and activate the plugin on an environment with
  live progress, then print the `novamira auth login` command that connects your
  agent. It runs the same code path as
  `novamira-hq hosting novamira setup`, including the PHP gate and the
  compatibility preflight.
- **Diagnostics** — run the same installation report as `novamira-hq doctor`
  (bound to `--offline`, and never `--fix`), or read one provider's capability
  document. Neither action repaints the page, so the provider you picked stays
  picked.
- **Settings** — the update card, which checks the npm registry when the page
  opens and can install a newer release with your package manager, and the
  configuration file's location, read-only.

Stop it with Ctrl-C. `--open` launches your default browser and is never fatal
if it cannot.

Connected-state detection — whether a provisioned site is actually connected to
your agent — needs `@novamira/cli` installed alongside HQ, which the installers
do by default. Without it that one panel reports "unavailable" with an install
hint; provider inventory, deploy paths, provisioning and everything else are
unaffected.

## Provision a site

One command installs the Novamira plugin on an environment, activates it, turns
on the AI Abilities options, and verifies the site against the compatibility
matrix the site CLI enforces:

```sh
novamira-hq --profile kinsta hosting novamira setup --env <env-id>
```

The plugin source defaults to `novamira-latest`, which resolves to the newest
published release. The site URL is discovered from the site's own `home` option
unless `--url` overrides it; `--no-ai-abilities` leaves the two options
untouched, and `--no-compat-check` skips the verification and says so in the
output. A site that cannot run the plugin — PHP below 8.0, WordPress below 6.9,
a plugin build older than 1.11.1, a missing server feature — fails the command
with `server_unsupported` and names the check that failed, rather than reporting
a success an agent could not use.

## Handoff to the agent CLI

HQ provisions; the site CLI connects. After HQ installs and activates the plugin
on a provisioned environment, it prints the next step rather than creating any
credential of its own:

```text
Novamira 1.11.1 installed and activated on https://example.com
  Connect your agent:  novamira auth login https://example.com
```

That second command belongs to `@novamira/cli`, which owns the browser
authorization, the OAuth grant, and the credential storage for the site. HQ
writes no site credential, stores no site profile, and creates no WordPress
user.

`@novamira/cli` is an optional integration, not a dependency. The installers
install it by default because the two tools are meant to be used together, but
that is a convenience of the install step and nothing more: it is not a runtime,
package, or peer dependency, HQ never imports it, and uninstalling it breaks
nothing. Hosting inventory, provider actions, provisioning, and plugin-installed
status all work without it; only the dashboard's connected-state detection and
Connect action require it.

## Agent skills

HQ ships two instruction bundles for coding agents: `core`, a router that sends
hosting work to HQ and everything inside WordPress to `novamira`, and `hosting`,
the provider-neutral reference for the whole `hosting` tree.

```sh
novamira-hq skills list
novamira-hq skills get           # core, the router
novamira-hq skills get hosting
novamira-hq skills path hosting  # a real file inside the installed package
```

The bundle an agent registers is `skills/novamira-hq/SKILL.md`, installed with
the third-party `skills` CLI (`npx skills add <package root> --skill novamira-hq
--global`). **No HQ command writes a skill to disk**: there is no `skills
install` and no `setup`, and nothing touches `~/.claude` or `~/.agents`.

The one thing the hosting bundle will not do is tell an agent to reach inside
WordPress. It routes that work to `novamira auth login <url>` and the separate
`@novamira/cli`, and it names no Application Password, no site profile and no
WordPress REST route — because HQ has none of those.

## Doctor

```sh
novamira-hq doctor              # nine checks, one line each
novamira-hq doctor --offline    # no network operation of any kind
novamira-hq doctor --fix        # repair private-path permissions and state storage
```

The checks, in order: the Node version, owner-only permissions on HQ's private
paths, atomic writes in the state directory, which credential backend resolved,
whether `config.json` matches the v1 schema, whether every profile's credential
reference resolves, whether the bundled skills are intact, whether the optional
`novamira` site CLI is installed and compatible, and whether a newer HQ is
published.

`--offline` drops the last one entirely — the report has eight checks and makes
no request at all, which is what the installers' smoke test relies on.

**A completed report exits 0**, even when its status is `warn` or `fail` — the
report is the output, and a `warn` is information rather than a broken command.
Three checks can never fail: one unresolvable credential reference must not
condemn an install whose other profiles work, a missing `@novamira/cli` is a
warning by design because nothing except the dashboard's connected-state
detection depends on it, and an out-of-date or unreachable-registry install still
works.

`--fix` touches exactly two things: file permissions on HQ's own private paths,
and creating the state directory. It writes no credential, removes no profile,
and calls no provider.

## Updates

```sh
novamira-hq update --check   # report what is published, install nothing
novamira-hq update           # install it with your package manager
```

Distribution is npm only. `update` reads the `latest` dist-tag of `@novamira/hq`
— one anonymous HTTPS request carrying no cookie, no token and no profile,
credential, provider or telemetry data — and then runs
`npm install --global --ignore-scripts @novamira/hq@<version>` (or the Bun global
equivalent, if that is how HQ was installed). Nothing is downloaded from GitHub,
no checksum file is fetched, and no executable is replaced in place. The
installer's output goes to stderr only, and the exact command that ran is
reported in `data.command`.

Separately, a human running HQ at a terminal may see one stderr line a day when a
newer release exists. It is backed by `update-check.json` in HQ's state directory
(`$XDG_STATE_HOME/novamira-hq` on Linux — see the table above), which bounds it to
one registry request per 24 hours. It is off entirely — no request, no state
written — under `--quiet`, under `--json`, under
`NOVAMIRA_HQ_UPDATE_CHECK=0`, for `dashboard` and `doctor --offline`, and
whenever stderr is not a terminal. A scripted or piped invocation never consults
a registry.

## Output

Every command emits one envelope in `--json` mode:

```json
{"ok":true,"data":{},"meta":{"requestId":"..."}}
{"ok":false,"error":{"code":"provider_error","message":"...","retryable":false}}
```

stdout carries only the requested output; warnings, progress, and diagnostics go
to stderr, redacted. See [`docs/v1-contract.md`](docs/v1-contract.md) for the
full envelope, global options, and the error-code to exit-code mapping.

## Development

```sh
bun install
bun run check              # lint, format check, and the contract tests
bun run pack:inspect       # what the published tarball contains
bun run package:acceptance # pack it, install it, and run the installed CLI
```

Live provider API calls are explicitly gated and never run in CI. See
[`AGENTS.md`](AGENTS.md) for repository conventions.

## License

AGPL-3.0-or-later. Copyright Ovation S.r.l.

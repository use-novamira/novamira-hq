# Novamira HQ

`novamira-hq` is the hosting-side command-line tool and local dashboard for
Novamira.

It manages hosting-provider profiles and provider API credentials, operates
provider resources — sites, environments, backups, domains, caches, DNS, plugins
and themes — and provisions the Novamira plugin so a site becomes ready for an
agent to use. Site and environment deletion, site reset, backup deletion, domain
deletion, DNS writes, and SSH/SFTP credential management are deliberately
outside HQ's surface and provider adapters. Backup restoration is available only
through a guarded recovery workflow that first creates a new safety backup.

HQ never holds a WordPress site token or calls authenticated site REST directly.
Its MCP can also delegate WordPress tasks to the optional `novamira` CLI, which
owns authentication and site requests. Once a
site is provisioned, agents talk to it through the separate
[`@novamira/cli`](https://github.com/use-novamira/novamira-cli) tool.

## Status

The port of the Go `novamira-hub` is complete. Every command, route and page
described in [`docs/v1-contract.md`](docs/v1-contract.md) is implemented, and
that document is normative throughout — nothing in it is marked as planned.
The current release is `1.0.0-rc1`, a release candidate for the normative v1
contract; the first stable public release will be `1.0.0`.

What the repository contains: the error and exit-code taxonomy, the JSON output
envelope, HQ's storage namespace with locking, atomic writes and owner-only file
permissions, the `config.json` v1 schema and store, keychain-backed provider
credentials, the shared HTTP client with retry, timeout and redacted
diagnostics, the eight provider clients, the whole `config` and `hosting`
command line, the provisioning flow behind `hosting novamira setup`, the bundled
agent skills behind `skills`, the local installation report behind `doctor`,
npm-only self-update behind `update`, the two installer scripts, and the local
dashboard — including Diagnostics, which runs the same report
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

The installers set up HQ, register its agent skill with the agent of your choice,
smoke-test the result with `novamira-hq doctor --offline`, install the
`@novamira/cli` site CLI alongside it, and add an operating-system application
launcher. On macOS, **Novamira HQ** is installed in
`/Applications` when that folder is writable, otherwise in `~/Applications`;
on Linux, its freedesktop entry is installed under
`${XDG_DATA_HOME:-~/.local/share}/applications`; on Windows, **Novamira HQ** is
added to the current user's Start Menu. Opening any launcher starts the local
dashboard and opens it in the default browser.

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

To build it from a checkout instead:

```sh
bun install
bun run build
node dist/index.js --version
```

The executable is `novamira-hq`. It does not collide with the site CLI's
`novamira` executable, and the two tools share no configuration, state, cache,
credential, or keychain storage.

## Configuration

HQ keeps a single `config.json` holding hosting profiles and pushes. A
hosting profile names a provider, an optional company or account id, an optional
API base URL, and a reference to a credential — never the credential itself. A
credential reference is one of:

- `env` — the name of an environment variable, for example `KINSTA_API_KEY`;
- `file` — the path of an owner-only file containing the secret;
- `stored` — an opaque id for a secret held in the OS keychain (`ai.novamira.hq`)
  with no automatic file fallback.

`stored` never means a plaintext secret in `config.json`. No HQ command accepts a
secret as a command-line option; secrets come from an environment variable, a
file, or standard input.

On macOS, app, CLI and MCP use the dedicated **Novamira HQ Credentials** native
helper. Releases include its signed, notarized universal bundle in both the app
and npm package. No Swift compiler or desktop installation is required for npm.
Only the verified HQ executable signed by the helper's Developer ID team gets
automatic caller authorization. Node/npm and development callers require an
explicit **Allow once** confirmation for each helper operation; Node itself is
never permanently trusted. Keychain may still ask to unlock or authorize a key.
Windows uses Credential Manager; Linux uses Secret Service (`secret-tool`).
An unavailable OS backend is an error, not permission to save secrets to files.
Use an explicit `file` reference only when you deliberately want that storage.

For local macOS development, run `bun run keychain:build` with Xcode command-line
tools installed. This creates an unsigned development helper: no automatic
caller authorization. Old test credentials are not migrated; re-enter them.
For terminal use of the signed app without a window:

```sh
"/Applications/Novamira HQ.app/Contents/MacOS/novamira-hq-desktop" --cli doctor --offline
```

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

Three top-level groups plus four commands: `config` manages HQ's own
configuration and its hosting profiles, `hosting` operates provider resources
through one profile, `skills` prints the bundled agent instructions, `dashboard`
serves the local web UI, `doctor` checks the installation, `update` installs a
newer release, and `mcp` serves the policy-controlled typed tool surface over MCP
stdio.

```sh
novamira-hq config add kinsta --credential-env KINSTA_API_KEY
novamira-hq config list

novamira-hq skills list
novamira-hq skills get hosting
novamira-hq doctor --offline
novamira-hq update --check
novamira-hq dashboard --open
novamira-hq mcp

novamira-hq --profile kinsta hosting providers validate
novamira-hq --profile kinsta hosting sites list --include-envs
novamira-hq --profile kinsta hosting backups create --env <env-id> --tag nightly
novamira-hq --profile kinsta --yes hosting backups restore --env <env-id> \
  --backup-id <backup-id> --all-content --notified-user-id <kinsta-user-id>
novamira-hq --profile kinsta hosting wp plugins install --env <env-id> \
  --source novamira-latest
```

`hosting` covers provider inventory and capabilities, sites and environments,
domain and DNS inspection, backups, cache, PHP, redirects, denied IPs,
WordPress plugins and themes, WP-CLI, logs, and analytics. `--profile` is
required and never inferred, and every command accepts `--json`. Run
`novamira-hq hosting --help` for the tree, or see
[`docs/v1-contract.md`](docs/v1-contract.md) for the normative surface.

## Dashboard

```sh
novamira-hq dashboard                          # prefers http://127.0.0.1:8787
novamira-hq dashboard --listen localhost:9000 --open
```

The dashboard is Novamira HQ's interactive surface — it is what the CLI has instead of
prompts. It binds to **loopback only**: `--listen` accepts `:PORT`, `PORT`,
`HOST:PORT` or `[IPv6]:PORT`, and the host must be `localhost`, an address in
`127.0.0.0/8`, or `::1`. Anything else is refused before a socket is opened, so
the dashboard cannot be exposed to a network by accident. Every mutating route
additionally requires a per-process token that only the served page carries, and
every request is checked against a loopback `Host` and `Origin`, so a page on
another site cannot drive it.

What it does:

- **Hosting Providers** — add, edit and remove provider profiles, and check a
  profile's API credential. New accounts choose a randomly ordered provider
  first, then enter its account details. Configuration stays on the user's
  device and is never sent to Novamira servers; Novamira HQ uses the credential
  locally to contact the hosting provider directly. The credential is posted
  once and handed to the OS credential store. If it is unavailable, saving
  fails explicitly; no local file fallback is selected. The page only
  ever shows the reference (`env:NAME`, `stored:ID`), never a value.
- **Sites** — browse hosting sites and Novamira CLI profiles in one list. A CLI
  profile matched to a hosting environment appears only on that environment;
  unmatched profiles appear once under **CLI only**. The list exposes credential
  state, expiry, Reconnect, Rename, Sign out and Remove. The **Connect** menu
  first offers an existing Novamira site by URL, then a hosting account; “New
  site” is reserved for future provider-side creation. A direct site may use an
  optional custom profile name. Hosting inventory stays
  cached for five minutes; CLI actions use that warm inventory and never call a
  provider. Every CLI control runs one `novamira` command — Novamira HQ stores nothing
  and never talks to the site itself.
- **How to use it** — the persistent three-step guide from preparing a site, to
  authorizing it on the computer, to opening the AI agent selected during
  Novamira HQ installation. Novamira HQ prepares the connection; the AI work
  happens in the agent.
- **Push** — save and run environment-to-environment pushes.
  Start directly from a source environment on Sites, save the direction and
  scope, then review them before invoking the provider's native push operation.
  It does not create a separate backup. A changed or reused confirmation is refused.
- **Configure your AI** — choose ChatGPT/Codex or Claude, then connect with one
  click through the client's official command-line setup when available.
  Generated JSON or TOML is kept as a manual fallback.
  Claude Desktop uses a downloadable `.mcpb` extension: open the file and
  confirm installation in Claude. The bundle connects to the existing local
  Novamira HQ installation, so keep that installation available.
- **History** — local requests and correlated workflows across CLI, dashboard
  and MCP, with observed outcomes and next steps for unverified work.
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
hint; provider inventory, pushes, provisioning and everything else are
unaffected.

## Desktop app

The dashboard also ships as a native desktop window, built with
[Deno](https://deno.com) and the [webview](https://jsr.io/@webview/webview)
backend (WebKitGTK on Linux, WebKit on macOS, WebView2 on Windows):

```sh
bun run desktop:build          # writes dist-desktop/novamira-hq-desktop
./dist-desktop/novamira-hq-desktop
```

It is the same dashboard, not a second one. The executable embeds HQ's own
build and runs `novamira-hq dashboard --json --listen 127.0.0.1:0` in a child
process — a fresh loopback port every time, never attached to a dashboard
another process is running — then opens a window on the printed URL. Closing
the window stops that server and only that server; if the window dies any
other way the server notices and stops itself. Everything about the CLI
holds: loopback only, the per-process mutation token, the `NOVAMIRA_HQ_*`
storage namespace, and the site CLI found on `PATH` or through
`NOVAMIRA_HQ_SITE_CLI`.

Linux needs `libwebkit2gtk-4.1` installed; macOS and Windows use the system
web view. Packaged macOS `.app` bundles include their architecture's native
webview library, verified against a pinned checksum at build time; opening the
window requires no download. Bare executables and development builds still
download the small native library into Deno's cache on first launch.
During development `deno task --cwd desktop dev` runs the window
from the checkout after `bun run build`.

### Release assets

Every release attaches a compiled executable per platform and architecture.
Each one carries the same application icon, derived at build time from the one
committed 1024x1024 master — `deno compile --icon` embeds it on Windows,
`scripts/macos-sign.sh` builds the `.icns` for each macOS bundle, and Linux,
where an executable cannot hold an icon at all, gets a tarball that carries it
beside the binary.

| Asset                                      | What it is                                                       |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `novamira-hq-desktop-macos-arm64.app.zip`  | `Novamira HQ.app` for Apple Silicon, signed, notarized, stapled. |
| `novamira-hq-desktop-macos-arm64`          | the same executable, bare, for a script.                         |
| `novamira-hq-desktop-macos-x86_64.app.zip` | `Novamira HQ.app` for Intel, signed, notarized and stapled.      |
| `novamira-hq-desktop-macos-x86_64`         | the same executable, bare, for a script.                         |
| `novamira-hq-desktop-windows-x86_64.exe`   | the window, with its icon. Unsigned, so SmartScreen asks once.   |
| `novamira-hq-desktop-linux-x86_64.tar.gz`  | the executable, its freedesktop entry and its hicolor icons.     |
| `novamira-hq-desktop-linux-x86_64`         | the same executable, bare, for a script.                         |

On Linux, the tarball installs for the current user with three commands, and
`INSTALL.txt` inside it repeats them:

```sh
tar xzf novamira-hq-desktop-linux-x86_64.tar.gz
cd novamira-hq-desktop-linux-x86_64
install -Dm755 novamira-hq-desktop ~/.local/bin/novamira-hq-desktop
cp -r icons/hicolor ~/.local/share/icons/
install -Dm644 ai.novamira.hq.desktop.desktop \
  ~/.local/share/applications/ai.novamira.hq.desktop.desktop
```

That entry is separate from the one `install.sh` writes: this one opens the
native window, and the installer's opens the dashboard in a browser.

## Provision a site

One command installs the Novamira plugin on an environment, activates it, turns
on the AI Abilities options, and verifies the site against the compatibility
matrix the site CLI enforces:

```sh
novamira-hq --profile kinsta hosting novamira setup --env <env-id>
```

The plugin source defaults to `novamira-latest`, which resolves locally to
`https://license.dynamic.ooo/api/novamira/download`; HQ performs no GitHub
release lookup. The site URL is discovered from the site's own `home` option
unless `--url` overrides it. New installs enable AI Abilities. Existing compatible
installs are preserved by default, including their AI Abilities settings; pass
`--ai-abilities` explicitly to enable them on an existing site. An old or
unverifiable installation stops before mutation, even with `--force`: update it
separately. `--no-compat-check` skips the public metadata verification and says so in the
output. A site that cannot run the plugin — PHP below 8.0, WordPress below 6.9,
a plugin build older than 1.11.1, a missing server feature — fails the command
with `server_unsupported` and names the check that failed, rather than reporting
a success an agent could not use.

## Handoff to the agent CLI

InstaWP backup creation, listing and in-place restore use **Site Versions** (files
and database), not the separate Snapshots product. CLI, MCP and dashboard use
the same guarded restore flow, including a completed fresh safety version before
restoring. Only task status `completed` confirms success. Labels are limited to
25 characters; provider plan limits apply. Deletion and sharing are not exposed.
This integration is covered by offline tests, not yet validated on a live account.

Cloudways setup uses the official WP Manager API to upload the Novamira ZIP and
activate it. WP Manager must be available for the application. HQ checks PHP,
WordPress and the plugin inventory first, preserves existing plugins, and verifies
installation and activation through fresh inventory reads. This API cannot set
Novamira's AI Abilities options: enable them in WordPress if the final readiness
check requests it, then reconnect. Installation alone is not a site connection.
Generic WP-CLI and arbitrary plugin installation remain unavailable on Cloudways.

Hostinger setup is also available through its provider APIs: HQ uploads the
official ZIP and a temporary installer, verifies activation, and enables AI
Abilities when requested. It requires a root-domain HTTPS WordPress installation
and never overwrites an existing plugin directory. It does not imply support
for generic WP-CLI or arbitrary plugin installation. Temporary-file cleanup is
checked and any leftovers are reported. If the OAuth check sees a cached 404,
clear LiteSpeed's cache before retrying; installation alone is not a connection.

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

## MCP server

In the dashboard, open **Configure your AI** for installation-specific
configurations for Claude Desktop and ChatGPT Desktop. Copying a configuration
does not connect the client: merge it without overwriting other servers and
restart that client. The local verification button checks initialization and
tool listing, not provider credentials or the external client's connection.
Client instructions follow the [MCP local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
and [ChatGPT Desktop MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

The standalone desktop executable also accepts `--mcp` and launches the same MCP
server without a window. The client starts its own process, so the Novamira HQ
dashboard need not remain open. Its copied configuration does not require a
separate Novamira HQ CLI installation. Provider secrets are never copied; environment-based secrets
must be available to the AI client, which may not inherit your terminal's env.

The application's initial acknowledgement explains that AI agents may explicitly
enable AI Abilities on an existing site without asking again. It is not a
per-hosting permission, has no revocation switch, and is not required by CLI or
MCP. New plugin installations enable abilities automatically; existing
installations preserve them unless explicitly requested.

Native desktop updates require installing a newer desktop release. The npm
updater only updates a separately installed CLI and is unavailable in the
standalone app.

Novamira HQ can be configured as a local stdio MCP server in AI agents. The server writes
only newline-delimited JSON-RPC messages to stdout and performs no background
update check. After installing `@novamira/hq`, configure its stable command:

```json
{
  "mcpServers": {
    "novamira-hq": {
      "command": "novamira-hq",
      "args": ["mcp"]
    }
  }
}
```

The dashboard-generated configuration also carries the executable search path,
which lets a graphical client find the installed command without embedding a
versioned Node path or the package's `dist/` location. Moving or updating the
package therefore does not require editing the client configuration. The
optional `novamira` site CLI is discovered separately by Novamira HQ; it is not
another MCP server and does not belong in this JSON.

MCP exposes a deliberately smaller, typed operational surface rather than a
generic CLI bridge. All supported MCP tools are available at launch; there are no access presets.
Run `novamira-hq mcp`. Typed tools cover
profile and hosting inventory, provider validation, operation status, backup
creation and guarded restoration, Novamira setup, and environment push. There is
no arbitrary argv tool, no configuration mutation, no self-update, no provider
WP-CLI passthrough, no domain or DNS mutation, and no SSH/SFTP tool.

Environment push is two-step: `hosting_environment_push_plan` requires an
explicit database, all-files, or file-list scope and returns a five-minute,
session-local, one-use confirmation ID; `hosting_environment_push_apply` consumes
it and invokes only the provider's native push operation. Novamira HQ does not
combine a separate backup and push into a workflow; any automatic backup is part
of the provider's own behavior.
Tool inputs never accept provider credential values; credentials continue to
resolve from the HQ profile's configured environment, file, or credential store
reference. The granular push contract is currently available on Kinsta;
Rocket.net's all-or-nothing publish and Cloudways' provider-native sync remain
unexposed. The MCP server retains HQ's WordPress-site boundary rule.

Backup restore is also two-step. `hosting_backup_restore_plan` requires an
explicit target environment, a backup ID from that environment's catalog, and
`allContent: true`. `hosting_backup_restore_apply` consumes its five-minute
one-use confirmation and creates and waits for a fresh safety backup before
restoring.

The same MCP also exposes WordPress site listing, doctor, discovery, site-skill
loading, Ability description and execution through the optional `novamira` CLI.
Choose a site explicitly, inspect the live schema, authorize the task and verify
changes. No raw argv, local file input, direct authenticated site HTTP or automatic
retry is exposed. Site content is untrusted. WordPress calls are not included in
the hosting History page.

## Removing the separate site CLI

Removing Novamira HQ does not uninstall `@novamira/cli` or the WordPress plugins
on your sites. Keep the CLI if other agents use it. For a global npm installation,
remove it with `npm uninstall -g @novamira/cli`. This removes the executable, not
necessarily saved profiles or credentials. Before uninstalling, optionally list
profiles with `novamira sites list --json`, then for each intended profile run
`novamira --site PROFILE_NAME auth logout` and `novamira sites remove PROFILE_NAME`.
Logout attempts remote revocation; check its result. These commands disconnect
other agents using that profile, but do not delete the WordPress site. They are
not a complete cleanup of local files or authorizations on other devices.
Settings → Uninstalling contains the same instructions; HQ never runs them
automatically. Remove unused MCP entries in your AI client separately.

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
bun run desktop:check      # deno fmt, lint and type-check the desktop shell
bun run desktop:build      # generate the icons, compile into dist-desktop/
node scripts/desktop-build.mjs --package   # ...and the Linux release tarball
node scripts/desktop-smoke.mjs             # run the compiled --serve role
```

Live provider API calls are explicitly gated and never run in CI. See
[`AGENTS.md`](AGENTS.md) for repository conventions.

## License

AGPL-3.0-or-later. Copyright Ovation S.r.l.

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

Early. HQ is a TypeScript port of the Go `novamira-hub` and the port is in
progress: no release has been published to npm yet, and the command surface
described in [`docs/v1-contract.md`](docs/v1-contract.md) is being landed phase
by phase.

What exists in this repository today is the foundation: the error and exit-code
taxonomy, the JSON output envelope, HQ's storage namespace with locking, atomic
writes and owner-only file permissions, the `config.json` v1 schema and store,
keychain-backed provider credentials, and the shared HTTP client with retry,
timeout, and redacted diagnostics. The provider clients, the command line, the
provisioning flow, and the dashboard are not wired up yet.

Sections of the contract document that are not implemented are marked
**RESERVED** rather than described as if they shipped.

## Requirements

- Node.js 22 or newer
- An API credential for a supported hosting provider

Supported providers: Kinsta, InstaWP, Pantheon, Pressable, WP Engine,
Rocket.net, Hostinger, and Cloudways.

## Install

Once published, HQ installs from npm:

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

`NOVAMIRA_HQ_HOME` relocates the whole tree and `NOVAMIRA_HQ_CONFIG` overrides
the config file path. The site CLI's `NOVAMIRA_HOME` is ignored.

## Commands

Two top-level groups: `config` manages HQ's own configuration and its hosting
profiles, `hosting` operates provider resources through one profile.

```sh
novamira-hq config add kinsta --credential-env KINSTA_API_KEY
novamira-hq config list

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

## Handoff to the agent CLI

HQ provisions; the site CLI connects. After HQ installs and activates the plugin
on a provisioned environment, it prints the next step rather than creating any
credential of its own:

```text
✓ Novamira installed and activated on https://example.com
  Connect your agent:  novamira auth login https://example.com
```

That second command belongs to `@novamira/cli`, which owns the browser
authorization, the OAuth grant, and the credential storage for the site. HQ
writes no site credential, stores no site profile, and creates no WordPress
user.

`@novamira/cli` is an optional integration, not a dependency. Hosting inventory,
provider actions, provisioning, and plugin-installed status all work without it;
only the dashboard's connected-state detection and Connect action require it.

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
bun run check
bun run pack:inspect
```

Live provider API calls are explicitly gated and never run in CI. See
[`AGENTS.md`](AGENTS.md) for repository conventions.

## License

AGPL-3.0-or-later. Copyright Ovation S.r.l.

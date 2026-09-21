---
name: novamira-hq-hosting
description: Operate WordPress hosting providers through Novamira HQ, and provision the Novamira plugin on an environment.
allowed-tools: Bash(novamira-hq:*)
---

# Novamira HQ Hosting

Use `novamira-hq hosting ...` for provider-neutral WordPress hosting operations. Kinsta, InstaWP, Pantheon, Pressable, WP Engine, Rocket.net, Hostinger, and Cloudways are implemented, but agents should use the generic hosting command names and inspect provider capabilities before reaching for a provider-specific workflow.

Always use `--json` for automation. Every hosting operation requires an explicit global `--profile`; there is no default and no single-profile fallback.

HQ stops at the hosting boundary. It never holds a WordPress site token, never calls a WordPress REST route on a configured site's behalf, and never proxies an Ability. For work inside WordPress, see **Handoff** below.

## Discovery

Validate hosting credentials and inspect provider capabilities:

```bash
novamira-hq --json --profile <hosting-profile> hosting providers validate
novamira-hq --json --profile <hosting-profile> hosting providers capabilities
novamira-hq --json --profile <hosting-profile> hosting sites list --include-envs
novamira-hq --json --profile <hosting-profile> hosting sites get <site_id>
novamira-hq --json --profile <hosting-profile> hosting envs list --site <site_id>
novamira-hq --json --profile <hosting-profile> hosting ops get <operation_id>
```

HQ deliberately implements no site deletion/reset, environment deletion, backup deletion, domain deletion, DNS record writes, or SSH/SFTP access management. Backup restore is the sole recovery exception: it verifies the backup in the target environment, requires explicit destructive approval. Capability output is governed by a positive public allowlist.

InstaWP exposes each site as one synthetic environment. Credential validation, site list/get, site creation from scratch or template, task polling, and WP-CLI command execution are available. Saved command IDs are still accepted for provider-native workflows.

Pantheon exposes sites with their `dev`/`test`/`live` environments. Authentication is a machine token in `PANTHEON_MACHINE_TOKEN`; the profile `company_id` can hold an organization id for account-scoped listings.

Pressable exposes sites with one environment each. Authentication is an OAuth client credential pair: the client secret is the profile credential (`PRESSABLE_CLIENT_SECRET`) and the client id is read from `PRESSABLE_CLIENT_ID`.

WP Engine exposes sites as site containers and installs as environments. The WP Engine API user ID is stored in the profile `company_id` field or read from `WPE_API_USER_ID` with `WPENGINE_USERNAME` as a fallback; the API password should be read from `WPE_API_PASSWORD` with `WPENGINE_PASSWORD` as a fallback. For provider-native create workflows prefer `--from-json` with WP Engine-native payload fields.

Rocket.net exposes each site as one synthetic environment. The Rocket.net username is stored in the profile `company_id` field or read from `ROCKETNET_USERNAME`; the password should be read from `ROCKETNET_PASSWORD`. For clone, CDN purge, and WP-CLI workflows prefer `--from-json` with Rocket.net-native payload fields when the generic flags do not cover the provider request.

Hostinger exposes websites as sites. Use `HOSTINGER_API_TOKEN` for authentication; the profile `company_id` can store the hosting account username for endpoints that require one. Hostinger website environments use `username:domain` when both values are needed. Prefer `--from-json` for Hostinger-native website and WordPress installation payloads.

Cloudways exposes applications as sites with one synthetic environment per application. Use `CLOUDWAYS_API_KEY` for the API key and store the account email in `company_id` or `CLOUDWAYS_EMAIL`. Cloudways environment IDs use `server_id:app_id` when both values are needed. Prefer `--from-json` with Cloudways-native form field names for create, clone, domains, backups, cache, and service operations.

Provisioning and maintenance operations return normalized action results. If `operation_id` is present, poll it with:

```bash
novamira-hq --json --profile <hosting-profile> hosting ops wait <operation_id> --interval-seconds 5 --timeout-seconds 300
```

## Inventory

```bash
novamira-hq --json --profile <hosting-profile> hosting regions list
novamira-hq --json --profile <hosting-profile> hosting activity list --limit 20
novamira-hq --json --profile <hosting-profile> hosting domains list --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting backups list --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting logs get --env <env_id> --file error --lines 1000
novamira-hq --json --profile <hosting-profile> hosting wp plugins list --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting wp themes list --env <env_id>
```

## Provisioning

```bash
novamira-hq --json --profile <hosting-profile> hosting sites create --from-json site.json
novamira-hq --json --profile <hosting-profile> hosting sites create --site-name demo-site
novamira-hq --json --profile <hosting-profile> hosting sites create --template-slug blueprint --site-name demo-site --reserved
novamira-hq --json --profile <hosting-profile> hosting sites create-plain --display-name "Plain site" --region us-central1
novamira-hq --json --profile <hosting-profile> hosting envs create --site <site_id> --from-json env.json
novamira-hq --json --profile <hosting-profile> hosting envs clone --site <site_id> --display-name staging --source-env <env_id>
novamira-hq --json --profile <hosting-profile> hosting envs push --site <site_id> --source-env <source_env_id> --target-env <target_env_id> --db
novamira-hq --json --profile <hosting-profile> hosting envs push --site <site_id> --source-env <source_env_id> --target-env <target_env_id> --file wp-content/uploads
```

Environment push has no implicit scope. Select `--db`, `--all-files`, or one or more `--file` paths; `--all-files` and `--file` are mutually exclusive, and `--search-replace` requires `--db`. HQ verifies both environments and provider support, then starts only the requested native push. Backup creation is a separate explicit action. `--from-json` is intentionally unavailable for this command. The safe granular contract is currently advertised only by Kinsta; Rocket.net's all-or-nothing publish and Cloudways' provider-native sync are not exposed as HQ push operations.

## Maintenance

```bash
novamira-hq --json --profile <hosting-profile> hosting backups create --env <env_id> --tag before-maintenance
novamira-hq --json --profile <hosting-profile> --yes hosting backups restore --env <env_id> --backup-id <backup_id> --all-content
novamira-hq --json --profile <hosting-profile> hosting cache clear --kind site --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting php restart --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting php set-version --env <env_id> --php-version 8.3
novamira-hq --json --profile <hosting-profile> hosting wp plugins install --env <env_id> --source novamira-latest
novamira-hq --json --profile <hosting-profile> hosting wp plugins update-all --env <env_id>
novamira-hq --json --profile <hosting-profile> hosting wp-cli run --env <env_id> --command "wp core version"
novamira-hq --json --profile <hosting-profile> hosting wp-cli run --env <instawp_site_id> --from-json command.json
```

Backup restore accepts no `--from-json` payload. Always take the backup id from
`backups list` for the same environment, then pass both `--all-content` and the
global `--yes`. Kinsta also requires `--notified-user-id <kinsta_user_id>`. HQ
checks that the provider supports listing, creating, and restoring backups,
verifies the id in the target catalog, and creates and waits for a new safety
backup before it restores anything.

`hosting wp plugins install` uses provider WP-CLI support, installs and activates by default, runs a DB-backed WP-CLI preflight by default, validates remote zip URLs by default, and waits for async provider operations by default. Use `--source novamira-latest` to install the current Novamira plugin release without depending on a release asset filename. It works on providers with arbitrary `wp-cli.run`, including InstaWP:

```bash
novamira-hq --json --profile <hosting-profile> hosting wp plugins install --env <instawp_site_id> --source novamira-latest
```

## Making a site agent-ready

```bash
novamira-hq --json --profile <hosting-profile> hosting novamira setup --env <env_id>
```

`hosting novamira setup` blocks environments running PHP older than 8.0 and inspects an existing Novamira before mutation. Too-old or unreadable versions stop without replacement, even with `--force`; update explicitly first. New installations enable AI Abilities. Compatible existing installations preserve both AI Abilities options unless `--ai-abilities` is explicitly passed. This is independent of the reinstall flag. Setup discovers the site URL with `wp option get home` unless `--url` supplies one, checks public compatibility metadata unless `--no-compat-check` is given, and prints the handoff below.

It **writes no credential and stores no profile**. CLI and MCP require no app acceptance. AI Abilities permit PHP execution and filesystem/data changes; an AI may request activation without another human prompt. Connecting an existing site does not enable them. A copied site may preserve an old domain binding; use the explicit activation option only when activation on the current domain is intended.

## Handoff

HQ provisions; it does not connect. After `hosting novamira setup` succeeds, the next step belongs to a different tool:

```bash
novamira-hq site-cli auth login https://example.com
```

`novamira-hq site-cli` launches HQ's pinned `@novamira/cli` in a child process. HQ never holds a site token or calls authenticated WordPress REST directly. Continue site work through the site CLI's own guidance or typed WordPress MCP tools.

## Complex payloads

Complex actions accept `--from-json <path>` or `--from-json -` for standard input where the command grammar advertises it. Prefer it for redirects and provider-specific payloads. Environment push is the exception: it accepts only the explicit granular flags above. For InstaWP command execution, `wp_command`, `command`, `commands`, and saved `command_id` payloads are accepted.

## Configuration

Prefer environment-backed credentials. Do not pass API key values in argv.

```bash
export KINSTA_API_KEY=...
novamira-hq --json config add kinsta --profile kinsta-dev --credential-env KINSTA_API_KEY --company auto --yes
```

If an automation environment cannot set environment variables, pass the secret through standard input:

```bash
printf '%s' "$KINSTA_API_KEY" | novamira-hq --json config add kinsta --profile kinsta-dev --credential-stdin --company auto --yes
```

The same shape works for every provider kind: `instawp`, `pantheon`, `pressable`, `wpengine`, `rocketnet`, `hostinger`, and `cloudways`, each with its own default credential variable.

Inspect configuration without exposing secrets:

```bash
novamira-hq --json config list
novamira-hq --json config show --profile kinsta-dev
novamira-hq --json doctor
```

## Secret handling

Do not put provider credentials, WordPress admin passwords, SSL private keys, or other secrets in command argv when an env/stdin/file option exists. Use admin-password input flags such as `--admin-password-env` or `--admin-password-stdin`. HQ has no command that returns, generates, rotates, or exports an SSH/SFTP credential. Normal output, JSON output, errors, tests, and docs must not contain full secrets.

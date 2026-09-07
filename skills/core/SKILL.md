---
name: novamira-hq
description: Route Novamira HQ work to the right version-matched skill instructions.
allowed-tools: Bash(novamira-hq:*)
---

# Novamira HQ

Novamira HQ is a CLI for operating WordPress **hosting providers** and for provisioning the Novamira plugin on a hosting environment. It never talks to a WordPress site: it holds no site token, calls no WordPress REST route on a site's behalf, and cannot run an Ability.

Use this router first, then load only the detailed instructions the task needs:

```bash
novamira-hq skills get hosting
novamira-hq skills list
```

## Route selection

- Use `novamira-hq hosting ...` for host and platform operations: environments, backups, domain and DNS inspection, cache, PHP, redirects, denied IPs, logs, analytics, provider WP-CLI, plugin and theme operations, provider operation polling, and installing or configuring the Novamira plugin. HQ deliberately omits site and environment deletion, site reset, backup and domain deletion, DNS writes, and SSH/SFTP access management.
- Use `novamira-hq hosting novamira setup` to make a site agent-ready, and then **stop**. HQ's job ends there.
- **For anything inside WordPress — content, settings, Abilities, files — switch to the separate `novamira` CLI** after `novamira auth login <site-url>`. HQ has no `site` command group, holds no site credential, and cannot execute an Ability.
- If the route is unclear, inspect the configured profiles and then the selected one:

  ```bash
  novamira-hq --json config list
  novamira-hq --json --profile <hosting-profile> hosting sites list --include-envs
  ```

  If it is still ambiguous, ask one short clarification instead of guessing.

Always use `--json` for automation, and never put provider credentials, WordPress admin passwords, SSL private keys, or other secrets in command argv when an env/stdin/file option exists.

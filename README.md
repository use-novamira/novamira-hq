# Novamira HQ

**All your WordPress sites. One connection for your AI. A free and open source
desktop app.**

Novamira HQ brings your WordPress sites together in one local dashboard. Connect
your hosting accounts, prepare sites for Novamira, manage common hosting tasks,
and make your sites available to compatible AI agents through one connection.

[Download Novamira HQ](https://novamira.ai/hq) ·
[Documentation](https://novamira.ai/docs/hq)

## What you can do

- View hosting environments and manually added WordPress sites together.
- Install and configure Novamira on supported hosting environments.
- Create and restore backups, clear caches, inspect logs, and use other
  operations supported by each hosting provider.
- Save, review, and run content pushes between supported environments.
- Connect an MCP-compatible AI client once and use it across your sites.

Novamira HQ currently supports Kinsta, InstaWP, Pantheon, Pressable, WP Engine,
Rocket.net, Hostinger, Cloudways, and Plesk. Available operations vary by provider.
Plesk accounts can list hosted domains. An active WP Toolkit adds WordPress
installation discovery, Novamira setup, WordPress backup and restore, and
directional copying between two selected WordPress installations. Plesk copying
requires an explicit database and/or WP Toolkit files scope; selected files and
a separate search-and-replace step are not supported. WP Toolkit excludes
WordPress configuration and server rewrite files from its default file copy.

## How it works

1. Add a hosting account or a WordPress site.
2. Prepare and connect the sites you want to use.
3. Connect your AI to Novamira HQ from **Configure your AI**.

The dashboard and hosting integrations run on your computer. Your hosting and
WordPress connections remain local to your device.

## Install

Download the latest version from [novamira.ai/hq](https://novamira.ai/hq).

- **macOS:** open the DMG and drag Novamira HQ to Applications.
- **Windows:** download and open the Windows application.
- **Linux:** download and extract the Linux archive, then open
  `novamira-hq-desktop`.

The desktop app includes everything it needs. You do not need to install
Node.js, npm, Deno, or any additional Novamira component.

## Privacy and safety

- Hosting credentials stay on your device and are stored using the operating
  system's credential store.
- Novamira HQ does not store WordPress site tokens in its own configuration.
- The dashboard is available only on your computer, not on the public network.
- Destructive provider operations such as deleting sites, environments,
  backups, domains, or DNS records are not exposed.
- Pushes and restores require an explicit review and confirmation. Creating a
  backup is always a separate action.

Read more in the [Novamira HQ documentation](https://novamira.ai/docs/hq).

## Development

Novamira HQ requires Node.js 22+ and uses Bun for development:

```sh
bun install
bun run build
node dist/index.js dashboard --open
```

Run the complete local check before submitting a change:

```sh
bun run check
```

## License

Novamira HQ is free and open source software licensed under
[AGPL-3.0-or-later](LICENSE). Copyright Ovation S.r.l.

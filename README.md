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

Novamira HQ currently supports Kinsta, InstaWP, SandyWP, Pantheon, Pressable, WP Engine,
Rocket.net, Hostinger, Cloudways, Plesk, xCloud, cPanel, and WHM. Available operations vary by provider.
SandyWP accounts connect with a SandyWP API key, created from the account menu
in the SandyWP dashboard. HQ lists your sandboxes with their status and expiry
and creates new ones from the CLI; a new sandbox is provisioned in the
background, so wait for it with `hosting ops wait`. The workspace is optional:
leave it blank to use your personal workspace. HQ never shows or stores a
sandbox's admin password or one-click login link. Novamira setup uploads the
official plugin to a ready sandbox and activates it, and never overwrites an
existing Novamira folder. HQ does not turn on Novamira's AI Abilities there, on
any plan, so enable them in WordPress before connecting. SandyWP's API cannot run
WP-CLI, manage backups or change PHP, so those actions are not available.
Plesk accounts can list hosted domains. An active WP Toolkit adds WordPress
installation discovery, Novamira setup, WordPress backup and restore, and
directional copying between two selected WordPress installations. Plesk copying
requires an explicit database and/or WP Toolkit files scope; selected files and
a separate search-and-replace step are not supported. WP Toolkit excludes
WordPress configuration and server rewrite files from its default file copy.
xCloud accounts list WordPress sites with their staging sites, and support
backups, full-page cache purges, plugin and theme updates, access logs, and site
events. The xCloud API cannot install plugins, create or push staging sites, or
restore backups, so Novamira setup, pushes, and restores are not available
there; install the Novamira plugin yourself and connect the site by URL.
cPanel accounts connect with the HTTPS cPanel address (the panel URL, for
example `https://server.example.com:2083`), the cPanel username and a cPanel
API token. HQ lists WordPress installed at the root of each domain, creates
and lists whole-account backups in the home directory, and shows the domain
error log. An account backup counts against the account's disk quota. With
WP Toolkit, HQ installs and activates Novamira through it. Without WP
Toolkit, and only after you approve it, HQ uploads Novamira and a temporary
installer that runs once when WordPress loads and then removes itself; when
Novamira is already installed, HQ uploads only the temporary installer, no
ZIP. This needs WordPress permalinks turned on. cPanel has no user-level API
for restoring backups, clearing caches or changing PHP, so those actions are
not available. WordPress installed in a subfolder is not listed.

WHM servers connect with the HTTPS WHM address (for example
`https://server.example.com:2087`), the WHM user and that user's API token.
With root, one profile covers every cPanel account on the server; with a
reseller, the accounts that reseller owns. Site ids are `<account>:<domain>`.
The operations, limits and temporary-installer approval are the same as
cPanel's. HQ uses WP Toolkit for an account only when that account's feature
list includes it; otherwise it reads the account's files and, after you approve
it, sets up Novamira with the temporary installer, uploaded through a
short-lived cPanel session that HQ logs out. That temporary installer path
needs `https://<WHM host>:2083` reachable from this computer with a valid
certificate. WHM's WP Toolkit API does not accept reseller tokens, so a
reseller's sites always use the temporary installer, which needs the
reseller's create-user-session privilege; listing needs list-accts. A root
token controls the whole server, so create one for HQ and revoke it from
WHM » Development » Manage API Tokens.

### Hostinger Agency hosting

Unscoped Hostinger profiles list both classic and Agency websites. An explicit
hosting username scopes the inventory to classic hosting only. Agency IDs use
`agency:<website_uid>` and expose one synthetic live environment. Listing does
not establish that a website is WordPress or that Novamira is installed.

Agency plugin installation and other hosting operations are not implemented.
Install and activate the official Novamira ZIP in WordPress, enable AI Abilities
with the owner's approval, then use Connect to authorize the site by URL. Agency
Connect does not offer the classic hosting installer. Unscoped listing requires
both API inventories to succeed: permission errors, server errors and incomplete
pagination fail the refresh rather than silently hiding Agency websites. A
classic-only account can use its explicit hosting username to query only the
classic inventory. Leave that optional field empty for Agency or mixed accounts.

## How it works

1. Add a hosting account or a WordPress site.
2. Prepare and connect the sites you want to use.
3. Connect your AI to Novamira HQ from **Configure your AI**.

The dashboard and hosting integrations run on your computer. Your hosting and
WordPress connections remain local to your device.

## Install

Download the latest version from [novamira.ai/hq](https://novamira.ai/hq).

- **macOS:** open the DMG and drag Novamira HQ to Applications.
- **Windows:** download and run the installer. It installs for your user
  account and needs no administrator rights.
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

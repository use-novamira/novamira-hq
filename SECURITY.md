# Security Policy

## Reporting a vulnerability

Report security issues privately to **security@novamira.ai**. Do not open a
public issue, pull request or discussion for a suspected vulnerability.

Include what you need to make the problem reproducible: the HQ desktop app
version, the operating system, the app action, dashboard route or MCP tool
involved, and the smallest sequence that shows the behaviour. If a provider is
involved, name the provider but **never send a credential, an API key, a token
or an unredacted log**. HQ redacts secrets from its own output; a report does
not need one to be actionable.

We acknowledge a report within three working days and tell you our assessment of
severity and our intended timeline. We will keep you informed while a fix is
prepared, and we will credit you in the release notes when the fix ships unless
you ask us not to.

Please give us a reasonable period to release a fix before disclosing publicly.
We will not pursue or support legal action against anyone who reports in good
faith, stays within the scope below, and does not access, modify or destroy data
belonging to anyone else.

## Supported versions

HQ currently releases only the desktop app, available from
[novamira.ai/hq](https://novamira.ai/hq).

Until `1.0.0` ships, only the current `main` branch and the most recent desktop
prerelease receive fixes. After `1.0.0`, security fixes land on the latest minor
release of the desktop app.

In 1.0, MCP is the only supported integration for AI agents. Configure it through
**Configure AI** in the desktop app.

## Scope

In scope, because HQ owns them:

- The desktop app and its bundled HQ runtime, configuration store and credential
  storage, including the OS keychain integrations and file permissions on HQ's
  private paths.
- The local dashboard: its loopback binding, its per-process mutation token, the
  `Host` / `Origin` / `Sec-Fetch-Site` guards, and its SSE stream.
- The MCP server, its desktop configuration flow, and HQ's guarded WordPress
  connection layer.
- The hosting provider adapters, in particular anything that can move a provider
  credential into output, a diagnostic, an error, a log or a URL.
- The desktop shell and published desktop release assets.

Out of scope, because they are not ours to fix:

- Vulnerabilities in a hosting provider's own API or control panel. Report those
  to the provider; tell us as well if HQ's use of the API makes the impact
  worse.
- WordPress core, the Novamira plugin, or a third-party plugin on a managed
  site.

## Boundaries that are security properties, not preferences

These are invariants. A way around one is a vulnerability even when nothing
crashes and no error appears:

- HQ never holds a WordPress site token and never calls an authenticated
  WordPress REST route on a configured site's behalf. The single exception is
  the public, unauthenticated
  `GET {siteUrl}/.well-known/oauth-protected-resource` compatibility probe,
  which carries no `Authorization` header.
- HQ implements no site deletion or reset, no environment deletion, no backup
  deletion, no domain deletion, no DNS-record mutation and no SSH/SFTP
  credential management through any application surface, provider-neutral
  client, or provider adapter.
- A provider credential never reaches stdout, stderr, an error message, a
  diagnostic, a serialized result, a URL or a process argument list.
- The dashboard binds to loopback only, and every `/_dashboard/*` route requires
  the mutation token in a request header — never in a URL and never in a body.

# Novamira HQ Design Issues

Review date: 2026-09-07

This directory records the open product and security questions found while
reviewing the hosting and MCP surfaces. These documents describe questions and
decision boundaries; they do not make a capability part of the shipped v1
contract. Shipped behavior remains defined by `docs/v1-contract.md`.

## Open Issues

| Issue                                     | Status                            | Subject                                                                           |
| ----------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| [001](001-backup-restore-verification.md) | Open — safety blocker             | Proving that a safety backup completed before restore                             |
| [002](002-mcp-ai-abilities-consent.md)    | Direction agreed — mechanics open | Human consent before MCP enables AI Abilities                                     |
| [003](003-existing-novamira-preflight.md) | Open — design required            | Handling an existing or outdated Novamira installation without implicit overwrite |
| [004](004-hosting-mutation-review.md)     | Open — policy review              | Classifying the remaining non-deletion hosting mutations                          |
| [005](005-release-validation.md)          | Open — final gate                 | Provider, package, desktop, and release validation                                |

## Decisions Already Made

- HQ does not expose destructive removal or reset of hosting sites,
  environments, backups, domains, or DNS records.
- HQ does not manage SSH or SFTP accounts, credentials, allowlists, or access.
- Environment push is allowed only with positive scope, distinct source and
  target environments, and a completed target safety backup.
- Backup restore is useful, but it must remain typed, confirmation-gated, and
  protected by a completed safety backup.
- WP-CLI and WordPress plugin/theme updates remain available through the CLI.
  MCP has no generic CLI or argv bridge.
- Connecting a site that already runs Novamira uses the existing dashboard
  Connect action and the public `novamira auth login <url>` site-CLI command.
  Connect does not install, update, or configure the WordPress plugin.
- `@novamira/cli` remains a separate optional integration. None of these issues
  authorizes a change to that package or to HQ's WordPress-token boundary.

## Working Rule

An issue is closed only when its decision is reflected in the normative
contract, implementation, focused contract tests, and user-facing explanation.
If the decision is to omit a capability, remove it from the public surface
rather than leaving a callable unsupported or hidden command.

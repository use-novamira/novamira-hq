# 004: Review the Remaining Hosting Mutations

Status: open — policy review

## Question

Which non-deletion hosting mutations belong in HQ's public CLI, dashboard, and
MCP surfaces, and which need stronger confirmation or narrower input types?

## Settled Boundaries

- Destructive removal and reset of provider data stay outside every public
  surface.
- DNS records are readable but not mutable.
- SSH and SFTP access management stays outside every public surface.
- Environment push, WP-CLI, WordPress updates, and guarded backup restore are
  legitimate HQ functions when their dedicated safety rules hold.
- Local removal of an HQ profile, deploy-path record, or site-CLI profile is not
  deletion of provider-hosted site data and must remain clearly labelled as
  local state.

## Remaining Categories to Review

### Domains

- Adding a domain changes routing and may trigger certificate work.
- Changing the primary domain changes canonical traffic and can cause downtime
  or redirect mistakes.
- Decide whether primary-domain changes require an explicit confirmation flag,
  a plan/apply flow, or should remain CLI-only.

### Network and Runtime Configuration

- Applying redirects replaces or changes request-routing rules.
- Setting denied IPs may lock out legitimate users or operators.
- Changing PHP version or restarting PHP can interrupt service.
- Decide which operations need target-state previews and rollback guidance.

### WordPress and Provider Resources

- Forced plugin installation can overwrite an existing plugin.
- Bulk plugin and theme updates can change production behavior.
- Site/environment creation and cloning are not deletions, but can incur cost
  and expose copied data in a new environment.
- Decide whether production targets need stricter confirmation than staging.

## MCP Boundary

MCP should continue to expose only dedicated typed workflows. This review does
not authorize a generic provider-action tool, arbitrary CLI bridge, domain or
DNS mutation tool, SSH/SFTP management, or raw provider JSON input.

## Acceptance Criteria

- Every public mutation is classified by impact and surface.
- High-impact operations have explicit target and scope, no implicit broad
  defaults, and actionable confirmation text.
- MCP exposes all supported typed tools without launch presets; high-impact
  mutations retain their explicit plan/apply and verified-backup guards.
- Capability output and documentation match the final policy exactly.
- Focused tests prove excluded provider-native operations never become public
  merely because an adapter models them internally.

---
name: novamira-hq
description: Use when the user asks an agent to operate WordPress hosting providers — sites, environments, backups, domains, DNS inspection, cache, PHP, or provider WP-CLI — or to provision the Novamira plugin on a hosting environment.
allowed-tools: Bash(novamira-hq:*)
---

# Novamira HQ

When using the Novamira HQ MCP connector, first call `novamira_hq_guide`.
For a complete available site inventory, use `novamira_hq_sites_list`, not the
hosting-only list. MCP provides this guidance even without an installed skill.

Before using Novamira HQ terminal commands, load the current version-matched instructions:

```bash
novamira-hq skills get core
```

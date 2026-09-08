# 003: Inspect Existing Novamira Before Any Setup Mutation

Status: open — design required

## Question

What should HQ do when the target already has Novamira installed, especially
when that installation is too old for the site CLI compatibility matrix?

## Current Behavior and Risk

The current setup attempts plugin installation before its final compatibility
check. Without an explicit force option, an already-installed plugin normally
causes installation to fail and HQ adds an explanatory hint. With force, the
plugin may be overwritten. MCP does not currently expose that force option.

AI Abilities are configured before the final public compatibility metadata is
validated. A naive change that merely skips installation when the plugin exists
would therefore risk changing options on an old or incompatible build.

## Proposed Read-Only Preflight

Before any mutation, use fixed provider WP-CLI reads to determine:

- whether the Novamira plugin is installed;
- its installed version;
- whether it is active or network-active;
- optionally, the current AI Abilities option state when that information is
  needed to offer a deliberate "complete setup" action.

Compare the installed version against HQ's existing compatibility matrix before
installing, activating, updating, or writing options.

## Proposed Classification

| Observed state                          | Proposed behavior                                              |
| --------------------------------------- | -------------------------------------------------------------- |
| Plugin absent                           | Offer full setup, subject to AI Abilities consent              |
| Compatible and already configured       | Offer Connect; do not reinstall                                |
| Compatible but setup incomplete         | Offer an explicit Complete setup action                        |
| Too old                                 | Stop without mutation and explain the required minimum version |
| Invalid, partial, or unreadable version | Stop without mutation                                          |

Updating an existing plugin must be a separate, explicit operator decision. An
MCP setup call must not imply force, overwrite, or upgrade merely because a
newer version exists.

## Questions Still Open

- Should the preflight be an internal setup phase, a public read-only command,
  an MCP read tool, or some combination of these?
- May Complete setup enable AI Abilities on a compatible existing install, or
  should it require a more narrowly named action?
- Should an explicit dashboard update action be offered for an old version, or
  should HQ only explain which existing update command the operator can run?
- Must the public compatibility metadata also be checked before option writes
  when the site URL is already known?
- How should multisite and network-active installations be represented?

## Acceptance Criteria

- An existing plugin is never overwritten or upgraded implicitly.
- Version and compatibility are checked before AI Abilities option writes.
- A too-old version produces a specific, actionable, non-secret diagnostic and
  leaves the site unchanged.
- Connect remains available for an already prepared site and performs no
  hosting mutation.
- The implementation uses provider WP-CLI only and introduces no WordPress
  token, authenticated REST request, or site-CLI change.

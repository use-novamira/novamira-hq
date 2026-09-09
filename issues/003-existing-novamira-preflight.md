# 003: Inspect Existing Novamira Before Setup Mutation

Status: implemented — offline contracts, 2026-09-08

Setup performs fixed provider WP-CLI reads after the PHP gate and before plugin
installation or option writes. It reads the installed version/activation state,
then existing AI Abilities options. It compares against the shared
MINIMUM_NOVAMIRA_VERSION constant rather than inventing a second minimum.

| Observed state                                         | Behavior                                               |
| ------------------------------------------------------ | ------------------------------------------------------ |
| Plugin absent                                          | Install, activate as requested, enable abilities       |
| Compatible existing plugin                             | Preserve installation and abilities by default         |
| Existing abilities disabled or bound to another domain | Preserve and explain; explicit activation is available |
| Too old or unverifiable                                | Stop before mutation, including under --force          |

Updating an old plugin remains a separate explicit operation. A compatible
installation is only reinstalled when force is explicitly requested, and force
is independent of abilities activation. MCP exposes the activation choice, not
an implicit upgrade or force option. Multisite activation states are recognized.

Connect continues through the existing optional site-CLI integration. This work
adds no WordPress token, authenticated site REST call, or site-CLI modification.

Offline tests cover old versions, absent plugins, state preservation, explicit
activation, domain mismatch and the public unauthenticated compatibility check.
Live provider smoke checks remain part of issue 005, not CI unit tests.

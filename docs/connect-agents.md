# Connect your agents

The compiled desktop offers agent setup after the first-launch notice and in
**Settings → Connect your agents**. Continue/Done records completion of the
introduction; setup remains available in Settings. No agents are preselected.
The npm/development dashboard explains that setup requires the installed app.
MCP's existing guide-based connection remains available without skills.

## Commands and agent selection

Enable, repair and remove use session 2's native command-registration service.
The panel shows launcher location, PATH/shadowing status and platform-specific
PATH instructions. Restart terminals and agents after changing PATH or skills.
After enabling command access, reopen HQ and regenerate old MCP configurations
from the MCP guide to select the stable launcher. These portable releases do not
edit shell profiles or the user PATH automatically.

Choose **Install for Claude Code** or **Install for Windsurf** explicitly. Each
action installs two independent, user-scope entry points:

| Agent | Installed artifacts |
| --- | --- |
| Claude Code | `${CLAUDE_CONFIG_DIR or ~/.claude}/skills/novamira-hq/SKILL.md`, `…/novamira-site/SKILL.md` |
| Windsurf | `~/.codeium/windsurf/skills/novamira-hq/SKILL.md`, `…/novamira-site/SKILL.md` |

The exact-target resolver in `desktop/registrar.ts` mirrors these two reviewed
registry entries from pinned `skills@1.5.18`; compiled acceptance compares its
answer with real registrar output. It does not use upstream's merged inventory
for ownership decisions. Other agents remain unsupported pending upstream
shared-directory inventory improvements.

HQ hosting loads `novamira-hq skills get core`. Site operations load
`novamira-hq site-cli guide get core` (and `--full` on demand). The released
`@novamira/cli@1.3.1` owns managed command-prefix rendering and suppresses
standalone update guidance. HQ does not rewrite child output. No installed skill
depends on an app/staging path or a separately installed runtime.

## Ownership, repair and cancellation

`src/agent-setup/owned-skills.ts` runs the bundled registrar with isolated home,
config and cache directories. Only its verified copies reach real agent homes.
Fresh files use exclusive creation, and setup operations coordinate with HQ's
cross-process lock. A manual or malformed directory, linked target, extra file
or edited entry is a conflict; setup preserves it and explains how to retry.

Each installed target has a private record under
`<HQ stateDir>/agent-skills/<sha256-of-target-path>.json`, containing its exact
path and installed SHA-256 digest. Repair compares that digest before updating
entry instructions. An unchanged entry is a no-op; an absent owned file can be
restored. A changed bundled entry is shown as outdated and requires Repair.
Removal deletes only the matching file, its empty directory and its HQ record.
Lost/invalid records do not grant ownership of existing files.

Detailed guidance is loaded from the running app, so normal app updates do not
require reinstalling skills. Entry-point changes are versioned by digest.
HQ's introduction marker is `<HQ stateDir>/agent-setup.json`.

The service exposes `view`, `start`, `wait`, `cancel`, `dismiss`, and `command`
through a structural dashboard dependency (`src/agent-connection.ts`). One
session-local setup job runs at a time. Each skill reports success/failure
independently. Cancellation stops the current child and skips subsequent work;
completed installations remain. Repair/retry fills missing entries. A dashboard
disconnect does not discard the job; Refresh status waits for its result.

Routes are token-guarded SSE operations. Install/repair/remove take an explicit
`agent=claude-code|windsurf` query; command takes
`operation=enable|repair|remove`. Other posted signals are ignored. No setup route
calls a hosting provider. Failures are notice patches or per-entry results and
do not disable the hosting dashboard.

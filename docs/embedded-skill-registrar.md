# Embedded skill registrar: session 1 findings

## Runtime and API

`skills@1.5.18` is pinned in `desktop/deno.json` and integrity-locked in
`desktop/deno.lock`, including `yaml@2.9.1`. This is a desktop-only dependency;
the HQ npm dependency graph and Bun lock are unchanged. Its npm tarball bundles
most dependencies, including prompts, simple-git, agent detection and XDG path
handling. The published package declares Node >=18. Deno's Node compatibility
layer runs the published ESM CLI successfully in the compiled executable.

There is no public programmatic API (`cli.d.mts` exports nothing). `bin/cli.mjs`
enables Node's optional compile cache and imports `dist/cli.mjs`. HQ imports the
latter directly in an isolated `--skill-registrar` process: upstream mutates
process state and calls `process.exit`, so it must never run in the dashboard
process. Ordinary startup does not load the registrar.

`createSkillRegistrar({ command, prefixArgs?, env?, spawn? })` in
`src/agent-setup/registrar.ts` exposes:

- `agents`: the reviewed subset `claude-code`, `windsurf`.
- `installHosting(agent, signal)`: a single-agent, user-scope fresh install of
  `novamira-hq`, returning `{ ok: true, path }` or
  `{ ok: false, reason, message }`. No arbitrary sources or argv are accepted by
  this adapter. `command` is the desktop executable; `prefixArgs` is only for
  the development Deno launch prefix.

The adapter reuses `integration/spawn.ts`: ignored stdin, 30-second deadline,
256-KiB stdout / 32-KiB stderr limits, cancellation and process-tree termination.
Captured registrar output is neither logged nor included in errors. Failures
remain local to setup. `path` is the registrar's inventory path, **not an
ownership record**: upstream may return a canonical path when copies exist.

The internal executable role accepts `list <agent>` and
`install <agent> <staging-directory>`. It constructs the fixed registrar argv,
sets `DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`, `CI=1` and `DENO_NO_PROMPT=1`, and
revokes Deno network and subprocess permissions before importing upstream code.
Local installation has no Git or external-runtime requirement. The supported
adapter always provides an absolute local source. No public command or UI has
been added in this session.

## Assets and installation semantics

The existing `skills/novamira-hq/SKILL.md` is included in the compiled filesystem.
Its digest is checked by `legal/manifest.json`. It continues to load detailed
guidance using `novamira-hq skills get core` at runtime. No large guidance copy
is installed.

The adapter materializes just this file in a private `skill-registration-*`
directory under HQ's resolved cache directory, with the existing file-security
backend securing staging (including Windows ACLs). It invokes:

```text
skills add <local-stage> --skill novamira-hq --global --agent <id> --copy --yes
```

Copy mode writes real files to the agent directory; symlink mode would instead
use a canonical shared skill directory and links/junctions. Staging is removed
in `finally`, including failure and cancellation paths. Installed files remain
readable after cleanup and contain no staging or app-location references.

Upstream local installs do not add a remote-source update lock entry. GitHub
sources can clone repositories, fetch privacy/security information and record
update metadata; none are used here. Telemetry is opt-out via either environment
variable above. There is no automatic registrar update check on this local
noninteractive path; `check` and `update` are separate commands. The optional
`find-skills` follow-up is skipped with `--yes` and non-TTY stdin.

Upstream `remove --global --agent ... --yes` operates by skill name, scans
canonical and agent directories and updates its own lock. It does not implement
HQ artifact ownership. HQ therefore exposes no remove/repair adapter yet.

## Important upstream limitations

- Per-target copy failures can print `Failed to install` yet exit zero. HQ checks
  the failure text and verifies the resulting inventory and file bytes.
- `list --global --json --agent <id>` still scans other agent directories. HQ
  filters its returned display names. Inventory combines identical skill names
  across directories and can return a canonical/representative path rather than
  every installed path.
- Codex, Cursor, Gemini CLI, GitHub Copilot and OpenCode are **universal/shared**
  agents in this release: `getAgentBaseDir` uses `~/.agents/skills` even though
  their registry entries also specify agent-specific global directories.
  Inventory detection depends on the agent's configuration directory already
  existing. A fresh isolated home can receive a successful copy with no matching
  agent in inventory. These agents are not exposed by this prototype.
- Claude Code and Windsurf have independent global directories and detection
  works after installation. Their paths are resolved by upstream, not by HQ.
  This subset is intentionally narrower than the registrar's full catalog.
- `--yes` permits replacement, and copy mode removes/recreates the target.
  The prototype refuses recognized existing installs, but upstream listing can
  miss malformed/manual instructions. **Before UI wiring**, session 3 needs a
  reliable exact-target inventory/preflight and HQ ownership records, including
  concurrent installs and user edits. Do not treat this primitive as a complete
  conflict-safe setup service or use its representative `path` for removal.

Recommended upstream work: a typed local install/list API with exact per-agent
paths, explicit no-overwrite semantics, stable machine-readable results and
nonzero failure codes; fix explicit-agent inventory for shared-directory agents.
Self-contained registration itself is feasible and verified. Extending the
prototype to the full catalog is contingent on resolving these inventory issues.

## Site skill decision

Inspected the bundled `@novamira/cli@1.3.0` entry skill, `guide-data/core/SKILL.md`
and built command implementation. The entry skill tells users to install Node
and `npm install -g @novamira/cli`; both it and core/full guidance use the bare
`novamira` executable. There is no verified command-prefix option in this release.

Do not copy those instructions or silently rewrite child output in HQ. The site
CLI remains the owner of detailed guidance. Before session 3 enables a distinct
`novamira-site` entry skill, upstream must support a managed command prefix for
all bundled guidance/examples (including `guide get core --full`) and suppress
standalone npm installation instructions in managed guidance. HQ's lightweight
entry will then invoke `novamira-hq site-cli guide get core` and every executable
example must use `novamira-hq site-cli ...`. Pin and integrity-lock that public
CLI release in npm and Deno together, with focused acceptance. Until then,
site-skill registration is unavailable; the existing site-cli forwarding works.

## Legal and verification

`legal/licenses/skills.txt` retains the upstream MIT license and published
third-party notices (including ISC components), supplemented with bundled
`@kwsites` helper notices omitted by upstream. `legal/licenses/detect-agent.txt`
adds the bundled agent detector's Apache-2.0 license, also omitted by upstream.
`legal/manifest.json` inventories
the registrar and separately resolved YAML dependency. The skills tarball does
not include its own LICENSE, so that text was obtained from upstream's main
branch; npm's reported gitHead is recorded but its GitHub LICENSE URL returned
404 during review. The existing incomplete desktop runtime legal review remains
a release prerequisite; this session does not claim release clearance.

`desktop/registrar-acceptance.ts` is compiled by `scripts/desktop-build.mjs`.
`scripts/desktop-smoke.mjs` runs it with isolated HOME/USERPROFILE/XDG/HQ/Deno
directories and no external runtimes on PATH. Network and subprocess permissions
are revoked inside the registrar role itself. It installs both supported agents,
reads copies after cleanup, checks repeat conflicts and actionable child-launch
failure; the rest of the smoke verifies HQ startup, bundled site CLI and MCP.

`test/agent-registrar.test.mjs` covers pre-abort, unsupported agents, deadline,
overflow, spawn failure, cancellation outcomes, zero-exit copy failure, malformed
inventory, output redaction and staging cleanup. The existing compiled spawn
acceptance exercises actual cancellation and descendant termination.

Linux x86_64 was exercised locally. macOS/Windows execution and Windows ACL
behavior need platform CI; they are not claimed as validated here.

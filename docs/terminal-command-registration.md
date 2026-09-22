# Desktop terminal command registration

Session 2 supplies the backend for the Connect your agents UI. The desktop
application can also manage it directly:

```text
<desktop executable> --command-registration status
<desktop executable> --command-registration enable
<desktop executable> --command-registration repair
<desktop executable> --command-registration remove
```

These roles print JSON; registration failures exit nonzero. They require the
compiled app. On macOS use the executable inside the installed `.app` bundle,
not a mounted disk image or App Translocation location. The application must
retain the executable name `novamira-hq-desktop` inside its bundle.

## Stable native launch target

`createCommandRegistration` in `src/agent-setup/command-registration.ts` exposes
`status`, `enable`, `repair`, `remove`, `refresh`, `resolve`, and `launcher`.
The desktop adapter is `desktop/command-registration.ts`. UI composition should
inject the service through a structural interface in session 3.

`commandRegistrationPaths` in `src/config/paths.ts` resolves the owned directory
as `<HQ stateDir>/command`. It contains `registration.json` and `novamira-hq`
(`novamira-hq.exe` on Windows). State honors `NOVAMIRA_HQ_HOME`, independently
of `NOVAMIRA_HQ_CONFIG`. The launcher reads its adjacent registration record;
changing the invocation's HQ home does not redirect app discovery.

The launcher is a byte-for-byte copy of the compiled desktop executable. This
deliberately costs one additional executable's disk space to avoid a second
native build/signing pipeline, shell escaping, `.cmd` MCP interoperability, or
external runtime dependencies. Its reserved basename selects a forwarding-only
role before any UI, CLI, registrar, or credential-helper initialization. **Do
not rename the installed application executable to `novamira-hq`**; that name
is reserved for the stable launcher. Repair/refresh updates the launcher copy
when the app bytes change. On Windows, close running commands/MCP agents if an
executable lock prevents replacement, then retry repair.

The launcher spawns the selected app with `--cli` and passes argument boundaries
and all three streams directly. `--mcp` selects the app's MCP role. It relays
POSIX INT/TERM/HUP signals and returns the child exit status. The signed app,
not the forwarding process, runs CLI composition and invokes the macOS
credential helper. No credentials are copied into registration state.

## Platform installation and relocation

Current formats are macOS `.app` ZIP/DMG, Windows portable executable, and Linux
tar archive. None provides a system installer hook. Enable is explicit; session
3 must offer it on first launch and in Settings. Existing registrations refresh
when a desktop window is opened, before starting its server. Registration
errors are reported without preventing dashboard startup.

| Platform | Default launcher directory | Relocation |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Novamira HQ/State/command` | Recorded bundle first; then `~/Applications`, `/Applications`, and Spotlight bundle-ID discovery. |
| Windows | `%LOCALAPPDATA%/Novamira HQ/State/command` | Recorded portable executable; open the moved copy or run its repair role. |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/novamira-hq/command` | Recorded extracted executable; open the moved copy or run its repair role. |

macOS candidates must be regular executables inside a bundle whose identifier
is `ai.novamira.hq.desktop`; mounted images, translocated apps, and Trash entries
are excluded. When the recorded location is missing, discovery requires exactly
one distinct valid executable. Multiple copies produce an error, rather than
choosing by version, mtime, or Spotlight ordering. An explicitly opened/repaired
copy becomes the recorded selection. In-place app updates keep the path valid.
Windows/Linux do not scan disks or fall back to another command on PATH.

No shell startup files, Windows registry values, existing npm commands, aliases,
or user PATH values are modified. Status returns `directory`, `onPath`, the
first detected `pathCommand`, `shadowed`, and `pathInstruction`. Add the returned
directory to user PATH and restart terminals/agents; until then use the absolute
launcher path. PATH inspection is advisory (shell aliases/functions and custom
Windows PATHEXT ordering are outside filesystem status). Existing conflicting
commands remain intact and visible in status.

## Ownership and repair

Writes serialize with HQ's shared process lock manager. The record has schema
version 1, the selected executable's absolute path, and the launcher's SHA-256.
Registration does not adopt foreign launcher files, symlinks, malformed records,
or edited launcher bytes. Repair recreates a missing owned launcher and updates
the selected app. Removal deletes only a matching launcher and its valid record;
unrelated directory contents and PATH configuration remain untouched. A corrupt
record or interrupted cross-file update fails closed as a conflict and requires
inspection; it is never silently overwritten.

## MCP configuration

When registration is healthy, every desktop CLI/MCP/dashboard composition uses
the absolute stable launcher with `["--mcp"]` for generated configurations. PATH
membership is unnecessary. Existing absolute-app configurations cannot be
rewritten retroactively: enable/repair command access, then regenerate and
re-import the MCP configuration. Before registration, configuration generation
continues to use the app path and requires regeneration after relocation. Moving
HQ's state directory or disabling command access also requires regeneration.

## Verification and remaining platform checks

`test/command-registration.test.mjs` covers ownership conflicts, repeat setup,
concurrency, updates, relocation, selection among explicit copies, missing apps,
missing launchers, PATH conflicts, and repair/removal. Its macOS-only case checks
real `plutil` identity validation and ambiguous discovery.

`scripts/command-registration-acceptance.mjs`, called by
`scripts/desktop-smoke.mjs`, exercises the compiled native launcher with empty
runtime PATH/caches, special-character paths/arguments, piped input, JSON doctor,
help, bundled site CLI, nonzero exits, repeated setup, update-in-place and
relocation/repair. The smoke script performs its MCP protocol handshake through
the launcher. Existing desktop CI invokes this on Linux, Windows and both macOS
architectures. The smoke's temporary macOS bundle validates metadata discovery;
it is not a replacement for testing Finder/Gatekeeper and credential-helper
authorization in a signed, installed release bundle.

Session 3 still owns first-launch/Settings UI, user-facing PATH instructions and
MCP regeneration guidance. Native Windows/macOS execution, Finder relocation,
Spotlight indexing, signed helper authorization through the launcher, and Windows
in-use replacement behavior must be confirmed in platform CI/release acceptance.

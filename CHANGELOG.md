# Changelog

## Unreleased

### Added

- First-launch and Settings **Connect your agents** flow: command access,
  explicit Claude Code/Windsurf selection, both hosting and site entry points,
  per-entry status, cancellation, retry, digest-owned repair and removal.
- Managed site guidance uses `novamira-hq site-cli` throughout, including full
  references, without standalone installation/update instructions.
- Bundle public `@novamira/cli@1.3.1` in npm and desktop. npm launches it with
  HQ's Node runtime; desktop embeds its code, dependencies and guide data and
  launches the `--site-cli` role without an external JavaScript runtime.
- `novamira-hq site-cli <arguments...>` forwards terminal arguments, streams,
  and exit codes. Provisioning handoffs now use this available launch path.
- Shared packaged resolution across dashboard, doctor, MCP and terminal roles,
  with explicit executable override precedence and repair guidance.
- Offline compiled acceptance covers packaged assets, managed update policy,
  OAuth loopback and PKCE, profile persistence, mocked site operations, bounded
  capture, cancellation and descendant cleanup.

### Changed

- Updating HQ updates its pinned CLI; managed invocations suppress independent
  updates. Installers and first-run onboarding no longer install a global CLI.
- Windows external CLI overrides require native `.exe`/`.com` launchers;
  implicit PATH discovery and Node-specific npm shim assumptions are removed.

- The desktop application ships with its icon on all three platforms. A new
  `scripts/desktop-icons.mjs` derives a Windows `.ico` and the freedesktop
  hicolor PNGs from `scripts/macos/icon.png`, the same committed master the
  macOS bundle already used, converting Display P3 to sRGB and resampling in
  linear light with no build-time image dependency.
- `novamira-hq-desktop-macos-x86_64` and `novamira-hq-desktop-macos-x86_64.app.zip`:
  the macOS desktop application now ships for Intel as well as Apple Silicon.
  Each architecture is compiled natively on its own runner and signed and
  notarized by the same `scripts/macos-sign.sh`, and the dispatch-only
  **Verify macOS signing** workflow proves both.
- `novamira-hq-desktop-linux-x86_64.tar.gz`: a new release asset carrying the
  Linux executable, its freedesktop entry, its icons and an `INSTALL.txt`,
  because an ELF executable cannot hold an icon. The bare executable is still
  published beside it.
- `scripts/desktop-build.mjs` compiles the shell with the host's icon —
  `deno compile --icon` refuses on any target but Windows — and `--package`
  assembles the Linux archive reproducibly.
- The Windows desktop build is exercised by the dispatch-only `package.yml`:
  its desktop matrix gained `windows-latest`, and `deno compile` failing on a
  malformed `.ico` is what checks the generator.

### Fixed

- The desktop server role now stops deterministically on Windows when its window
  dies. `Deno.kill(Deno.pid, "SIGTERM")` cannot be delivered there, so the stdin
  watcher exits instead of throwing out of an unawaited promise.
- The compiled executable's smoke test is `scripts/desktop-smoke.mjs`, which
  holds the server's stdin open. The three shell copies it replaces backgrounded
  the server, which handed it `/dev/null` — EOF, the one thing that means "the
  window is gone" — so it could stop before the first request.

## 1.0.0-rc1 - 2026-08-13

### Added

- Initial `@novamira/hq` package: hosting provisioning CLI and local dashboard.
- The `hosting` command tree and the `config` hosting-profile commands: 70
  subcommands over eight providers, all rendering the v1 envelope.
- `docs/v1-contract.md` freezes the v1 command surface.
- `hosting novamira setup`: installs and activates the Novamira plugin over
  provider WP-CLI, enables the two `novamira_ai_abilities_*` options, verifies
  the site against HQ's own copy of the site CLI's v1 compatibility matrix, and
  prints the `novamira auth login <url>` handoff. HQ writes no site credential,
  stores no site profile, and creates no WordPress user, so the Go program's
  `--username`, `--app-name`, `--site-profile` and `--replace-profile` flags and
  its `rest_url` / `username` / `credential` / `site_profile` / `config_path`
  output fields are gone permanently.
- The compatibility preflight: one public, unauthenticated
  `GET {siteUrl}/.well-known/oauth-protected-resource` per setup run, with no
  `Authorization` header, same-origin manual redirects, a 256 KiB ceiling and a
  bounded retry band. A failed check fails the invocation and names the check;
  `--no-compat-check` skips it and says so in the output.
- The `server_unsupported` error code at exit 4, for a site that cannot run the
  plugin — its PHP version, its WordPress version, the installed plugin's
  version, its REST contract, its feature flags, or its published compatibility
  document.
- `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1` accepts a plain-HTTP site URL that is not
  loopback, and a plain-HTTP loopback package registry; HQ never reads the site
  CLI's `NOVAMIRA_ALLOW_INSECURE_HTTP`.
- The local dashboard (`novamira-hq dashboard`): loopback-only binding, a
  per-process mutation token carried in a header and never in a URL, a
  DNS-rebinding guard, and seven pages driven by Datastar over SSE.
- `novamira-hq skills list | get [name] | path [name]`, over the two packaged
  bundles `core` and `hosting`. No HQ command writes a skill to disk: the Go
  program's `skills install` and `setup`, which hand-wrote an agent stub and
  symlinked `~/.claude/skills/novamira` at it, are deleted rather than ported.
- `novamira-hq doctor [--offline] [--fix]`: nine ordered checks with a
  `pass`/`warn`/`fail` severity and output-safe evidence. A produced report is a
  successful invocation whatever its status, `--offline` performs no network
  operation of any kind, and `--fix` may only repair private-path permissions and
  create the state directory.
- `novamira-hq update [--check]`: npm-only self-update. It reads the `latest`
  dist-tag of `@novamira/hq` over HTTPS — anonymously, carrying no cookie, token,
  profile, credential, provider or telemetry data — and installs with
  `npm install --global --ignore-scripts` or the Bun global equivalent. The Go
  program's GitHub release download, `checksums.txt` verification, archive
  extraction and in-place executable replacement are deleted, not ported, along
  with the `upgrade` alias.
- A background release notice, at most one registry request per 24 hours, cached
  in `state/update-check.json` under HQ's own namespace. It is suppressed —
  request and state write included — by `--quiet`, `--json`,
  `NOVAMIRA_HQ_UPDATE_CHECK=0`, `dashboard`, `doctor --offline`, and any
  invocation whose stderr is not a terminal.
- `install.sh` and `install.ps1`, published as GitHub release assets. They
  install the package with `--ignore-scripts`, smoke-test it with
  `novamira-hq doctor --offline`, and register the bundled agent skill through an
  exactly pinned `skills@1.5.18`. They then install `@novamira/cli` globally as
  a last step, so connected-state detection and the dashboard's Connect action
  work on a fresh machine. It is a separate global package and never a
  dependency of `@novamira/hq`: `NOVAMIRA_HQ_SKIP_SITE_CLI` skips the step, a
  failure is reported without failing the install, and neither script ever runs
  the `novamira` executable.
- The installers add `/Applications/Novamira HQ.app` on macOS when that folder
  is writable, otherwise falling back to `~/Applications`; a freedesktop menu
  entry under `${XDG_DATA_HOME:-~/.local/share}/applications` on Linux; and a
  **Novamira HQ** shortcut in the current user's Start Menu on Windows. Opening
  one runs `novamira-hq dashboard --open` using the exact HQ entry point and
  Node.js executable resolved at install time.
- `bun run package:acceptance`: packs the tarball, installs it into a throwaway
  prefix and exercises the installed executable offline. It runs on Linux, macOS
  and Windows in CI, and again in the release job against the published version.

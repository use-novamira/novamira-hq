# Changelog

## Unreleased

### Fixed

- After connecting a hosting account, HQ now confirms verified access and links
  to Sites without showing an actions table that was not verified for that
  account.
- Windows onboarding can save its acknowledgement without running Novamira HQ
  as an administrator. Private storage retains the current user's ownership
  while its access rules are secured; write failures now show a useful message.

## 1.0.0-beta1 - 2026-09-22

First public beta for 1.0.

### Added

- Initial `@novamira/hq` package: hosting provisioning CLI and local dashboard.
- The `hosting` command tree and the `config` hosting-profile commands: 70
  subcommands over eight providers, all rendering the v1 envelope.
- Focused contract tests freeze the v1 command surface.
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

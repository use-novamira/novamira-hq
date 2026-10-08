# Changelog

## Unreleased

### Fixed

- On macOS, Claude Code started from a terminal no longer stops with
  "suspended (tty input)" when it starts HQ's connector, and moving the mouse
  no longer prints stray characters at the prompt. HQ's lookup of the
  programs installed on the Mac took over the terminal and did not give it
  back.

## 1.0.0-beta4 - 2026-10-07

### Changed

- The bundled Novamira CLI is updated to 1.3.3. When `site-cli auth login`
  opens the browser it now also prints the authorization URL, so it can be
  opened in the browser where you are signed in to WordPress, and a login that
  times out explains how to retry.

### Fixed

- In Sites, each hosting environment now shows as connected only when its own
  address has a WordPress connection. Before, a Plesk subdomain could borrow
  its parent domain's connection, and a Kinsta or WP Engine environment could
  borrow another environment's, so Install Novamira Pro and Disconnect acted on
  the wrong site. An environment connected under an address other than its own
  now shows as not connected until it is connected with its own address.
- On Linux, HQ now detects an installed `secret-tool`, so hosting credentials
  and the Pro licence key save to the Secret Service instead of HQ reporting
  that the OS credential service is unavailable.
- Cloudways accounts can now be connected. HQ sent the Access Token in a
  header Cloudways no longer accepts, so every attempt failed with HTTP 400
  "Check the access token parameter" and the token never showed as used.
- Backup lists in Hosting tools and the restore backup menu now show when each
  backup was created as a readable date in your computer's time zone, with the
  zone named next to it, instead of a raw provider timestamp. If the time zone
  cannot be determined, dates are shown in UTC.
- Hosting tools reports now show file sizes in readable units, such as 683 KB,
  instead of raw byte counts, and long values such as backup file names wrap
  inside their column instead of overlapping the next one.

## 1.0.0-beta3 - 2026-10-01

### Added

- xCloud hosting accounts can now be connected with an API token. HQ lists
  WordPress sites and their staging sites, creates backups, purges the page
  cache, updates plugins and themes, and shows access logs and site events.
  Without a team, HQ uses the first team the token can access. The xCloud API
  cannot install plugins, create or push staging sites, or restore backups, so
  those actions stay unavailable for xCloud.

### Fixed

- Connecting a site that is already connected, with or without a different
  name, now reuses the existing connection instead of adding the site twice.
- Local development sites on `*.localhost` domains can now be connected over
  HTTP, matching the bundled Novamira CLI. Sites on `.local` domains connect
  over HTTPS, and HQ now explains how to enable it when plain HTTP is entered.
- In the desktop app, site connections now trust certificates in the system
  trust store, such as the one Local installs for HTTPS `.local` sites.
- When a site cannot be reached or is not ready during connection, HQ now asks
  whether Novamira is installed and active. The message points to Setup
  Novamira only where the dashboard offers it for that site.
- File uploads through the HQ MCP connector now receive the temporary upload
  token needed to transfer the file, where it was previously hidden.

## 1.0.0-beta2 - 2026-09-28

### Added

- Plesk hosting accounts now list domains even without WP Toolkit. With WP
  Toolkit active, HQ can discover WordPress installations, set up Novamira Free,
  create and restore backups, and copy files or databases between selected
  installations, including across domains.

### Tweak

- Connecting a site that is already ready for Novamira now opens authorization
  sooner.

### Fixed

- Hosting account names now accept accented characters, and validation errors
  let you correct the details and retry.
- Windows desktop startup now works from shortcuts without administrator access
  or downloading native libraries at launch.
- Windows credential storage and site connection checks now work reliably,
  including when authorization verification takes longer to complete.
- macOS command registration now uses the signed standalone launcher, including
  after moving the app.
- Novamira setup now accepts WordPress development builds such as
  `7.2-alpha-63789` when their numeric version meets the required minimum.
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

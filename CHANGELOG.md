# Changelog

## Unreleased

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
  loopback; HQ never reads the site CLI's `NOVAMIRA_ALLOW_INSECURE_HTTP`.

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The PHP gate, ported from Go's `internal/phpcompat` package.
 *
 * `hosting novamira setup` reads the site's PHP version before it installs
 * anything, because installing a plugin the runtime cannot load leaves the
 * operator with a broken site and a success message. Go's ordering property —
 * exactly one WP-CLI command is issued when the PHP check fails — is preserved
 * by the setup sequence and is worth keeping: fail hard *before* you touch the
 * site.
 *
 * Two behaviours look sloppy and are deliberate.
 *
 * 1. The version is the LAST version-like token in the output, not the first.
 *    Providers echo the command back before its output, and a PHP deprecation
 *    notice will happily print `5.6` in front of the value `echo` produced. The
 *    last token is the one WP-CLI actually wrote.
 * 2. The comparison is on the MAJOR component only. Go compared `Major < 8` and
 *    its test asserts exactly that; `"8.0"` is message text, not a bound. Do not
 *    upgrade this into a semver comparison — there is no upper bound either, so
 *    a future PHP 9 site stays supported without a code change.
 *
 * Where Go returned a bare `fmt.Errorf` for both failure modes, HQ separates
 * them: output with no version in it is a `provider_error` (the provider did
 * not give HQ a readable answer), while a site running PHP 7 is
 * `server_unsupported` — the site itself cannot run the plugin, which is the
 * same family of fact as a WordPress version below 6.9.
 */

import { CliError } from "../errors.js";

/** The minimum PHP runtime the Novamira plugin setup flow supports. */
export const NOVAMIRA_SETUP_MINIMUM_PHP = "8.0";

/** The only component actually compared. See the module comment. */
export const NOVAMIRA_SETUP_MINIMUM_PHP_MAJOR = 8;

/**
 * Sent as a LITERAL string, never through `shellJoin`: `shellQuote` refuses
 * both `'` and `;`, and both are load-bearing here. Do not "normalise" this
 * into a joined argument list — it will throw `usage_error` at run time.
 */
export const PHP_VERSION_COMMAND = "wp eval 'echo PHP_VERSION;'";

/** Go's `phpcompat.Version`. */
export interface PhpVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The whole matched token, e.g. `8.2.12` or `7.4`. Go's `Version.Raw`. */
  readonly raw: string;
}

const PHP_VERSION_PATTERN = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/g;

/**
 * The LAST version-like token in the output. Provider command echoes and PHP
 * deprecation warnings routinely precede the value `echo` produced.
 */
export function phpVersionFromOutput(output: string): PhpVersion | undefined {
  let last: PhpVersion | undefined;
  for (const match of output.matchAll(PHP_VERSION_PATTERN)) {
    const [raw, major, minor, patch] = match;
    if (major === undefined || minor === undefined) continue;
    last = {
      major: Number(major),
      minor: Number(minor),
      patch: patch === undefined ? 0 : Number(patch),
      raw,
    };
  }
  return last;
}

/**
 * Go's `EnsureNovamiraSetupSupported`: the raw version string, or a throw when
 * the site cannot run the Novamira plugin.
 */
export function ensureNovamiraSetupPhp(output: string): string {
  const version = phpVersionFromOutput(output);
  if (version === undefined) {
    throw new CliError(
      "provider_error",
      "Failed to determine the PHP version before plugin install.",
      { details: { command: PHP_VERSION_COMMAND } },
    );
  }
  if (version.major < NOVAMIRA_SETUP_MINIMUM_PHP_MAJOR) {
    throw new CliError(
      "server_unsupported",
      `Novamira setup requires PHP ${NOVAMIRA_SETUP_MINIMUM_PHP} or newer; this site is running PHP ${version.raw}.`,
      { details: { check: "php.version", phpVersion: version.raw } },
    );
  }
  return version.raw;
}

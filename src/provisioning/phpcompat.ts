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
 * 1. The version is read from `wp cli info`'s `PHP version:` label when the
 *    output carries one, and is otherwise the LAST version-like token, not the
 *    first. The label has to win, because `wp cli info` prints WP-CLI's own
 *    version *after* PHP's — the trailing token is `2.12.0`, not `8.4.1`. The
 *    last-token rule still governs unlabelled output: providers echo the command
 *    back before its output, and a PHP deprecation notice will happily print
 *    `5.6` in front of the real value.
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
 * `wp cli info`, and deliberately NOT `wp eval 'echo PHP_VERSION;'`.
 *
 * Kinsta validates `wp_command` against `letters, numbers, spaces, single
 * quotes, _, -, ., /, :, =` and answers anything else with HTTP 400. PHP's
 * `eval()` in turn refuses an unterminated statement, so `wp eval` cannot be
 * spelled in any way Kinsta accepts: with the `;` the request is rejected, and
 * without it the site raises a parse error. Because this gate is the first
 * request `hosting novamira setup` makes, the old command made provisioning
 * impossible on Kinsta rather than merely degraded.
 *
 * `wp cli info` costs nothing on the other seven providers and is strictly
 * better here: it does not bootstrap WordPress, so the gate no longer needs a
 * reachable database to tell an operator their PHP is too old. The DB-backed
 * preflight stays exactly where it was, one step later.
 *
 * Its output labels the value (`PHP version:\t8.4.1`) and carries WP-CLI's own
 * version last, which is why {@link phpVersionFromOutput} reads the label in
 * preference to the trailing token. See the module comment.
 */
export const PHP_VERSION_COMMAND = "wp cli info";

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
 * `wp cli info`'s labelled row, matched a line at a time so that only the
 * label's own value is scanned. `PHP binary:\t/usr/bin/php8.4` sits directly
 * above it and must never be mistaken for the version.
 */
const PHP_VERSION_LABEL_PATTERN = /^[ \t]*PHP version[ \t]*:[ \t]*(.+)$/gim;

/** The LAST version-like token in a fragment, or `undefined` if it has none. */
function lastVersionToken(text: string): PhpVersion | undefined {
  let last: PhpVersion | undefined;
  for (const match of text.matchAll(PHP_VERSION_PATTERN)) {
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

/** The value of the last `PHP version:` row, when the output carries one. */
function labelledVersion(output: string): PhpVersion | undefined {
  let last: PhpVersion | undefined;
  for (const match of output.matchAll(PHP_VERSION_LABEL_PATTERN)) {
    const value = match[1];
    if (value === undefined) continue;
    const found = lastVersionToken(value);
    if (found !== undefined) last = found;
  }
  return last;
}

/**
 * The site's PHP version: `wp cli info`'s `PHP version:` label when the output
 * has one, else the LAST version-like token. Provider command echoes and PHP
 * deprecation warnings routinely precede the real value, and `wp cli info`
 * routinely follows it with WP-CLI's own version — hence both rules.
 */
export function phpVersionFromOutput(output: string): PhpVersion | undefined {
  return labelledVersion(output) ?? lastVersionToken(output);
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

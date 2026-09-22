// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WP-CLI command-line construction, ported from Go's `shellQuote` / `shellJoin`
 * in `internal/cli/payloads.go`.
 *
 * These functions turn an argument list into a command line a hosting provider
 * will hand to a shell HQ cannot see, cannot configure and cannot audit. That
 * is why the quoter is deliberately far stricter than a real one: anything that
 * could change the command's meaning — a single quote, a semicolon, a `$`, a
 * backtick — is *refused* rather than escaped. There is no escaping scheme that
 * is correct for every provider's shell, so HQ does not attempt one.
 *
 * They lived in `src/cli/payloads.ts` because the CLI was the only caller. They
 * are provider machinery, not CLI grammar, and Phase 5's provisioning service
 * builds WP-CLI lines with no commander in the graph, so they move down here.
 * `src/cli/payloads.ts` re-exports all three unchanged.
 */

import { CliError } from "../errors.js";

/**
 * Quote one WP-CLI argument. This is intentionally far stricter than a real
 * shell quoter: the string is handed to a provider that runs it through a
 * shell HQ cannot see, so anything that could change the command's meaning is
 * refused rather than escaped.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (value.includes("'")) {
    throw new CliError(
      "usage_error",
      "WP-CLI arguments cannot contain single quotes.",
    );
  }
  let needsQuote = false;
  for (const character of value) {
    if (character === " ") {
      needsQuote = true;
      continue;
    }
    if (!/^[-_./:=@0-9A-Za-z]$/.test(character)) {
      throw new CliError(
        "usage_error",
        "WP-CLI arguments can contain only letters, numbers, spaces, and - _ . / : = @",
      );
    }
  }
  return needsQuote ? `'${value}'` : value;
}

/** Quote and join a WP-CLI command line. */
export function shellJoin(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

/**
 * The body of a bare `run-wp-cli` action, for helpers that build one.
 *
 * The return type is the literal object rather than `JsonRecord`: every caller
 * passes it straight into `ActionRequest.body`, which is `ActionBody = unknown`,
 * and naming the one field keeps `JsonRecord` — a CLI-layer type — out of the
 * provisioning service's import graph.
 */
export function wpCliCommandPayload(command: string): {
  readonly wp_command: string;
} {
  return { wp_command: command };
}

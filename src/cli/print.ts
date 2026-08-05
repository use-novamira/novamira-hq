// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Result rendering, adapted from `internal/cli/print.go` and
 * `internal/cli/output.go`.
 *
 * This is NOT a transliteration. Go's printers wrote to stdout themselves and
 * emitted a different ad-hoc JSON document per command; HQ has exactly one
 * writer (`src/output/render.ts`) and exactly one envelope, so nothing here
 * writes anything. Each function returns a {@link RenderedResult} — the `data`
 * member of the success envelope, plus the human-mode text — and the caller
 * hands it to `Renderer.success`. `console` is never used, and the `--json`
 * branch of Go's `printOrJSON` has no equivalent because the renderer owns that
 * decision.
 *
 * The JSON side always goes through `src/hosting/types.ts`'s `serialize*`
 * helpers, so the wire names stay byte-identical to the Go struct tags.
 * The human side reproduces Go's column layout exactly, with one deliberate
 * change: an action or operation line with no provider message no longer ends
 * in a trailing space.
 */

import {
  serializeActionResult,
  serializeHostingEnvironment,
  serializeHostingSite,
  serializeOperationStatus,
  serializeProviderValidation,
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
} from "../hosting/types.js";
import type { CommandMeta, InvocationWarning } from "../output/render.js";

/**
 * What a hosting command produces. Structurally identical to the private
 * `CommandResult` in `commands.ts`, so a handler can return one directly.
 */
export interface RenderedResult {
  /** The `data` member of the success envelope. */
  readonly data: unknown;
  /** Extra `meta` fields; `runHostingCommand` already supplies profile/provider. */
  readonly meta?: CommandMeta;
  /** Non-fatal warnings: `meta.warnings` in JSON mode, stderr otherwise. */
  readonly warnings?: readonly InvocationWarning[];
  /** Human-mode rendering. JSON mode always emits `data`. */
  readonly human?: string;
}

/** Go's `derefOr`. */
function orElse(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

/**
 * Go's `truncate`: values wider than `width` keep `width - 3` characters and
 * gain an ellipsis. Counting is by code point, as Go counted by rune.
 */
export function truncate(value: string, width: number): string {
  const runes = Array.from(value);
  if (runes.length <= width) return value;
  return `${runes.slice(0, Math.max(width - 3, 0)).join("")}...`;
}

/** Go's `%-<width>s`. */
function column(value: string, width: number): string {
  return value.padEnd(width);
}

/* -------------------------------------------------------------------------- */
/* Raw provider values                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Go's `printValue`: a read request's parsed provider response, pretty-printed
 * in human mode and passed through untouched under `data` in JSON mode.
 * `undefined` becomes `null`, the value Go's `parseJSONBody` produced for an
 * empty response body.
 */
export function renderRaw(value: unknown): RenderedResult {
  const data = value ?? null;
  return { data, human: JSON.stringify(data, null, 2) };
}

/* -------------------------------------------------------------------------- */
/* Sites and environments                                                     */
/* -------------------------------------------------------------------------- */

function siteRows(sites: readonly HostingSite[]): string[] {
  const lines = [
    `${column("ID", 38)} ${column("DISPLAY NAME", 28)} ${column("STATUS", 12)} DOMAIN`,
  ];
  for (const site of sites) {
    lines.push(
      `${column(site.id, 38)} ${column(truncate(site.displayName, 28), 28)} ${column(site.status, 12)} ${orElse(site.primaryDomain, "-")}`,
    );
    for (const environment of site.environments ?? []) {
      lines.push(
        `  env ${column(environment.id, 34)} ${column(truncate(environment.displayName, 24), 24)} ${orElse(environment.primaryDomain, "-")}`,
      );
    }
  }
  return lines;
}

function environmentRows(
  environments: readonly HostingEnvironment[],
): string[] {
  const lines = [
    `${column("ID", 38)} ${column("DISPLAY NAME", 24)} ${column("BLOCKED", 8)} ${column("PREMIUM", 8)} ${column("WP VERSION", 12)} DOMAIN`,
  ];
  for (const environment of environments) {
    lines.push(
      `${column(environment.id, 38)} ${column(truncate(environment.displayName, 24), 24)} ${column(String(environment.isBlocked), 8)} ${column(String(environment.isPremium), 8)} ${column(orElse(environment.wordpressVersion, "-"), 12)} ${orElse(environment.primaryDomain, "-")}`,
    );
  }
  return lines;
}

/** Go's `printSites`. */
export function renderSites(sites: readonly HostingSite[]): RenderedResult {
  return {
    data: sites.map(serializeHostingSite),
    human: siteRows(sites).join("\n"),
  };
}

/** Go's `printSite`. */
export function renderSite(site: HostingSite): RenderedResult {
  const lines = [
    `id: ${site.id}`,
    `name: ${site.name}`,
    `display_name: ${site.displayName}`,
    `status: ${site.status}`,
    `primary_domain: ${orElse(site.primaryDomain, "-")}`,
  ];
  if (site.environments !== undefined) {
    lines.push("environments:", ...environmentRows(site.environments));
  }
  return { data: serializeHostingSite(site), human: lines.join("\n") };
}

/** Go's `printEnvironments`. */
export function renderEnvironments(
  environments: readonly HostingEnvironment[],
): RenderedResult {
  return {
    data: environments.map(serializeHostingEnvironment),
    human: environmentRows(environments).join("\n"),
  };
}

/** Go's `printEnvironment`. */
export function renderEnvironment(
  environment: HostingEnvironment,
): RenderedResult {
  return {
    data: serializeHostingEnvironment(environment),
    human: [
      `id: ${environment.id}`,
      `name: ${environment.name}`,
      `display_name: ${environment.displayName}`,
      `is_blocked: ${String(environment.isBlocked)}`,
      `is_premium: ${String(environment.isPremium)}`,
      `wordpress_version: ${orElse(environment.wordpressVersion, "-")}`,
      `primary_domain: ${orElse(environment.primaryDomain, "-")}`,
    ].join("\n"),
  };
}

/* -------------------------------------------------------------------------- */
/* Actions, operations and validation                                         */
/* -------------------------------------------------------------------------- */

/** Go's `printAction`. */
export function renderAction(result: ActionResult): RenderedResult {
  const parts = [result.action, `status=${String(result.status)}`];
  if (result.operationId !== undefined)
    parts.push(`operation=${result.operationId}`);
  if (result.message !== undefined && result.message !== "")
    parts.push(result.message);
  return { data: serializeActionResult(result), human: parts.join(" ") };
}

/** Go's `printOperation`. */
export function renderOperation(status: OperationStatus): RenderedResult {
  const parts = [
    status.operationId,
    `status=${String(status.status)}`,
    `done=${String(status.done)}`,
    `failed=${String(status.failed)}`,
  ];
  if (status.message !== undefined && status.message !== "")
    parts.push(status.message);
  return { data: serializeOperationStatus(status), human: parts.join(" ") };
}

/** The `hosting providers validate` line from Go's `hosting.go`. */
export function renderValidation(
  validation: ProviderValidation,
): RenderedResult {
  return {
    data: serializeProviderValidation(validation),
    human: `${validation.provider} credential=${validation.credential} status=${validation.status} company=${validation.companyId ?? "(not set)"}`,
  };
}

/**
 * Go's `SecretWriteOutput`. The value written to disk is never echoed: `data`
 * carries the path and a fixed mask, exactly as the Go CLI did.
 */
export function renderSecretWrite(path: string): RenderedResult {
  return {
    data: { path, value: "********" },
    human: `wrote redacted secret to ${path}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Capability post-processing                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Moved to `src/hosting/capabilities.ts` in Phase 7 and re-exported here.
 *
 * The rule — a provider that advertises `sites.delete` must not be reported as
 * offering it through HQ — now has two callers: `hosting providers capabilities`
 * and the dashboard's `/_dashboard/diagnostics/capabilities` route. `src/web/`
 * may not import `src/cli/`, so the rule sits below both. Every existing
 * importer, `test/cli-foundations-contract.test.mjs` included, keeps working
 * unchanged.
 */
export {
  disableSiteDeleteCapability,
  SITE_DELETE_CAPABILITY,
  SITE_DELETE_DISABLED_NOTE,
} from "../hosting/capabilities.js";

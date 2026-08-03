// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider-neutral hosting domain types, ported from
 * `internal/providers/providers.go`.
 *
 * TypeScript field names are camelCase; the `serialize*` helpers at the bottom
 * of this module emit the exact snake_case wire names of the Go struct tags so
 * CLI and dashboard output stays byte-compatible with the Go implementation.
 * Nothing in this module is provider-specific and nothing here is a secret:
 * `ProviderValidation.credential` carries a `credentialSource()` rendering
 * (`env:KINSTA_API_KEY`), never a credential value.
 */

import type { ProviderKind } from "../config/schema.js";

/**
 * An ordered list of query-string parameters, mirroring Go's
 * `type Query = [][2]string`. Order is significant: several provider APIs are
 * sensitive to parameter order, and `http-client.ts` preserves the order of a
 * pair array verbatim.
 */
export type QueryParameter = readonly [name: string, value: string];

export type Query = readonly QueryParameter[];

/** The result of validating a provider credential (`providers.validate`). */
export interface ProviderValidation {
  readonly provider: ProviderKind;
  readonly status: string;
  /**
   * Provider-side account scope (Kinsta company, WP Engine account, ...).
   * Always serialized, as `null` when the provider does not report one — the Go
   * struct tag carries no `omitempty`.
   */
  readonly companyId: string | null;
  /** Non-secret `credentialSource()` rendering, e.g. `env:KINSTA_API_KEY`. */
  readonly credential: string;
}

/** A provider-neutral site description. */
export interface HostingSite {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly status: string;
  readonly primaryDomain?: string;
  /**
   * Present only when the caller asked for environments to be included; an
   * empty array is a meaningful "included, and there are none".
   */
  readonly environments?: readonly HostingEnvironment[];
}

/** A provider-neutral environment description. */
export interface HostingEnvironment {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly isBlocked: boolean;
  readonly isPremium: boolean;
  readonly wordpressVersion?: string;
  readonly primaryDomain?: string;
}

/** Whether a named capability is supported by a provider. */
export interface ProviderCapability {
  readonly name: string;
  readonly supported: boolean;
  readonly notes?: string;
}

/**
 * A capability entry as the provider modules declare it: either a bare name
 * (supported, no notes) or a `[name, supported, notes?]` tuple. This mirrors the
 * two shapes the Go providers use — Kinsta's `[]string` of all-supported names
 * and the anonymous `{name, supported, notes}` struct slice everywhere else.
 */
export type ProviderCapabilityInput =
  string | readonly [name: string, supported: boolean, notes?: string];

/**
 * Normalize capability declarations. An empty `notes` string becomes an absent
 * note, matching the Go `notes != "" ? &notes : nil` rule. Order is preserved:
 * the capability list is documented output, not a set.
 */
export function providerCapabilities(
  entries: readonly ProviderCapabilityInput[],
): ProviderCapability[] {
  return entries.map((entry) => {
    if (typeof entry === "string") return { name: entry, supported: true };
    const [name, supported, notes] = entry;
    return notes === undefined || notes === ""
      ? { name, supported }
      : { name, supported, notes };
  });
}

/**
 * The normalized result of a mutating provider action.
 *
 * `status` is the provider-reported status when the response body carries one,
 * falling back to the HTTP status (Go's `buildActionResult`). `raw` is the
 * parsed response body — Go keeps it as `json.RawMessage` (verbatim bytes);
 * HQ keeps the parsed JSON value, which round-trips identically apart from
 * insignificant whitespace and object key order. An empty response body is
 * `null`, the same value Go's `parseJSONBody` produces.
 */
export interface ActionResult {
  readonly provider: ProviderKind;
  /** Capability-style action name, e.g. `sites.create`, `cache.clear-edge`. */
  readonly action: string;
  readonly status: number;
  readonly message?: string;
  readonly operationId?: string;
  readonly raw: unknown;
}

/** The normalized status of a long-running provider operation. */
export interface OperationStatus {
  readonly provider: ProviderKind;
  readonly operationId: string;
  readonly status: number;
  readonly done: boolean;
  readonly failed: boolean;
  readonly message?: string;
  readonly raw: unknown;
}

/**
 * How a new site is provisioned. Go models this as an unexported `int` enum
 * (`SiteCreateWordPress`, `SiteCreatePlain`, `SiteCreateClone`); the mode is
 * never serialized, so HQ uses readable string literals instead.
 */
export const SITE_CREATE_MODES = ["wordpress", "plain", "clone"] as const;

export type SiteCreateMode = (typeof SITE_CREATE_MODES)[number];

export function isSiteCreateMode(value: unknown): value is SiteCreateMode {
  return (
    typeof value === "string" &&
    (SITE_CREATE_MODES as readonly string[]).includes(value)
  );
}

/** How a new environment is provisioned. */
export const ENVIRONMENT_CREATE_MODES = [
  "wordpress",
  "plain",
  "clone",
] as const;

export type EnvironmentCreateMode = (typeof ENVIRONMENT_CREATE_MODES)[number];

export function isEnvironmentCreateMode(
  value: unknown,
): value is EnvironmentCreateMode {
  return (
    typeof value === "string" &&
    (ENVIRONMENT_CREATE_MODES as readonly string[]).includes(value)
  );
}

/** Which cache layer to clear. */
export const CACHE_KINDS = ["site", "edge", "cdn"] as const;

export type CacheKind = (typeof CACHE_KINDS)[number];

export function isCacheKind(value: unknown): value is CacheKind {
  return (
    typeof value === "string" &&
    (CACHE_KINDS as readonly string[]).includes(value)
  );
}

/** Human-readable provider names, as they appear in Go's error messages. */
export const PROVIDER_LABELS: Readonly<Record<ProviderKind, string>> = {
  kinsta: "Kinsta",
  instawp: "InstaWP",
  pantheon: "Pantheon",
  pressable: "Pressable",
  wpengine: "WP Engine",
  rocketnet: "Rocket.net",
  hostinger: "Hostinger",
  cloudways: "Cloudways",
};

export function providerLabel(provider: ProviderKind): string {
  return PROVIDER_LABELS[provider];
}

/** A JSON object as emitted to stdout or an HTTP response body. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * Wire serializers. Each one reproduces the Go struct tags exactly, including
 * `omitempty`: an absent optional field is omitted from the object rather than
 * emitted as `null`. `ProviderValidation.companyId` is the one pointer field
 * without `omitempty` in the Go source, so it is always present.
 */
export function serializeProviderValidation(
  validation: ProviderValidation,
): JsonObject {
  return {
    provider: validation.provider,
    status: validation.status,
    company_id: validation.companyId,
    credential: validation.credential,
  };
}

export function serializeHostingEnvironment(
  environment: HostingEnvironment,
): JsonObject {
  const json: Record<string, unknown> = {
    id: environment.id,
    name: environment.name,
    display_name: environment.displayName,
    is_blocked: environment.isBlocked,
    is_premium: environment.isPremium,
  };
  if (environment.wordpressVersion !== undefined)
    json.wordpress_version = environment.wordpressVersion;
  if (environment.primaryDomain !== undefined)
    json.primary_domain = environment.primaryDomain;
  return json;
}

export function serializeHostingSite(site: HostingSite): JsonObject {
  const json: Record<string, unknown> = {
    id: site.id,
    name: site.name,
    display_name: site.displayName,
    status: site.status,
  };
  if (site.primaryDomain !== undefined)
    json.primary_domain = site.primaryDomain;
  if (site.environments !== undefined)
    json.environments = site.environments.map(serializeHostingEnvironment);
  return json;
}

export function serializeProviderCapability(
  capability: ProviderCapability,
): JsonObject {
  const json: Record<string, unknown> = {
    name: capability.name,
    supported: capability.supported,
  };
  if (capability.notes !== undefined) json.notes = capability.notes;
  return json;
}

export function serializeActionResult(result: ActionResult): JsonObject {
  const json: Record<string, unknown> = {
    provider: result.provider,
    action: result.action,
    status: result.status,
  };
  if (result.message !== undefined) json.message = result.message;
  if (result.operationId !== undefined) json.operation_id = result.operationId;
  json.raw = result.raw;
  return json;
}

export function serializeOperationStatus(status: OperationStatus): JsonObject {
  const json: Record<string, unknown> = {
    provider: status.provider,
    operation_id: status.operationId,
    status: status.status,
    done: status.done,
    failed: status.failed,
  };
  if (status.message !== undefined) json.message = status.message;
  json.raw = status.raw;
  return json;
}

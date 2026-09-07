// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WP Engine Hosting Platform API client, ported from
 * `internal/providers/wpengine.go`.
 *
 * WP Engine models a *site* as a container of *installs*; Novamira maps one
 * install onto one `HostingEnvironment`, so every environment-scoped call in
 * this module addresses `/installs/{install_id}` while site-scoped calls
 * address `/sites/{site_id}`.
 *
 * Deviations from the Go source, each flagged again where it occurs:
 *
 * - Credential resolution (the `WPE_API_PASSWORD` -> `WPENGINE_PASSWORD` and
 *   `WPE_API_USER_ID` -> `WPENGINE_USERNAME` fallbacks that `NewWPEngineClient`
 *   performs itself) lives in `factory.ts`; this module only consumes the
 *   `identity` and `secret` it is handed and never reads the environment.
 * - HTTP transport, retry and error mapping come from the shared `HttpClient`,
 *   so a non-2xx response raises a taxonomy `CliError` instead of Go's
 *   `WP Engine API request to %s failed with %d: %s` string.
 * - Response normalization is tolerant where Go's `encoding/json` is strict: a
 *   result element of an unexpected shape is skipped rather than failing the
 *   whole page.
 */

import { CliError } from "../../errors.js";
import {
  type ActionBody,
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedOperation,
  unsupportedReadRequest,
} from "../client.js";
import { DEFAULT_WPENGINE_API_USER_ID_ENV } from "../../config/schema.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import {
  type HttpClient,
  type HttpMethod,
  basicAuth,
  jsonBody,
} from "../http-client.js";
import {
  type ActionResult,
  type CacheKind,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderCapability,
  type ProviderValidation,
  type Query,
  providerCapabilities,
} from "../types.js";

const PROVIDER = "wpengine" as const;

/** WP Engine's maximum `limit` for its offset-paginated collections. */
const PAGE_SIZE = 100;

/** Every list read below asks for a single full page, as the Go client does. */
const FIRST_PAGE: Query = [
  ["limit", String(PAGE_SIZE)],
  ["offset", "0"],
];

type JsonRecord = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Construct the WP Engine client for a hosting profile.
 *
 * The API user id is the profile's `companyId`, else `WPE_API_USER_ID`, else
 * `WPENGINE_USERNAME` — the factory has already applied that order and exposes
 * the winner as `context.identity`.
 */
export const createWpEngineClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  const apiUserId = context.identity;
  if (apiUserId === undefined || apiUserId === "") {
    throw new CliError(
      "credential_missing",
      `The WP Engine API user id is required; set ${DEFAULT_WPENGINE_API_USER_ID_ENV} or give the profile a company id.`,
      { details: { provider: PROVIDER, profile: context.profileName } },
    );
  }
  if (context.secret.length === 0) {
    throw new CliError(
      "credential_missing",
      "The WP Engine API password is required.",
      { details: { provider: PROVIDER, profile: context.profileName } },
    );
  }
  // The only place the credential is revealed: building the Basic header. The
  // shared client scrubs both the password and the encoded pair from
  // diagnostics and error messages.
  const http = context.createHttpClient({
    auth: basicAuth(apiUserId, context.secret.reveal()),
  });
  return new WpEngineClient(http, apiUserId, context.credentialSource);
};

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

class WpEngineClient implements ProviderClient {
  readonly provider = PROVIDER;

  readonly #http: HttpClient;
  readonly #apiUserId: string;
  readonly #credentialSource: string;

  constructor(http: HttpClient, apiUserId: string, credentialSource: string) {
    this.#http = http;
    this.#apiUserId = apiUserId;
    this.#credentialSource = credentialSource;
  }

  async validate(): Promise<ProviderValidation> {
    // Go decodes into `wpEngineAccountsResponse`; HQ only needs the request to
    // succeed and the payload to be an object, which is what a decode failure
    // would have caught.
    requireObject(
      await this.#http.json({
        path: "/accounts",
        query: [
          ["limit", "1"],
          ["offset", "0"],
        ],
      }),
      "/accounts",
    );
    return {
      provider: PROVIDER,
      status: "active",
      companyId: this.#apiUserId,
      credential: this.#credentialSource,
    };
  }

  /**
   * WP Engine scopes every collection to the authenticated API user, so the
   * `companyId` option is accepted and ignored exactly as Go's `ListSites`
   * ignores its `companyID` argument.
   */
  async listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const includeEnvironments = options?.includeEnvironments ?? false;
    const sites: HostingSite[] = [];
    await this.#eachPage("/sites", (results) => {
      for (const entry of results) {
        const site = asRecord(entry);
        if (site !== undefined)
          sites.push(siteToHosting(site, includeEnvironments));
      }
    });
    return sites;
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const path = `/sites/${escapePathSegment(siteId)}`;
    const site = requireObject(await this.#http.json({ path }), path);
    return siteToHosting(site, true);
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    if (siteId !== "") {
      const site = await this.getSite(siteId);
      // `getSite` always includes environments, so the Go `nil` branch here is
      // only reachable as an empty list.
      return [...(site.environments ?? [])];
    }
    const environments: HostingEnvironment[] = [];
    await this.#eachPage("/installs", (results) => {
      for (const entry of results) {
        const install = asRecord(entry);
        if (install !== undefined) environments.push(installToHosting(install));
      }
    });
    return environments;
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return capabilities();
      case "site-domains":
        return this.#http.json({
          path: `/installs/${escapePathSegment(request.envId)}/domains`,
          query: FIRST_PAGE,
        });
      // WP Engine has one backup collection; the downloadable variant reads the
      // same endpoint, as in Go.
      case "backups":
      case "downloadable-backups":
        return this.#http.json({
          path: `/installs/${escapePathSegment(request.envId)}/backups`,
          query: FIRST_PAGE,
        });
      // Deliberately not mapped onto the Hosting Platform API.
      case "regions":
      case "activity":
      case "site-domain-verification":
      case "dns-domains":
      case "dns-records":
      case "logs":
      case "redirects":
      case "denied-ips":
      case "plugins":
      case "themes":
      case "company-plugins":
      case "company-themes":
      case "analytics-usage":
      case "analytics-env":
      case "file-list":
        throw unsupportedReadRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  async action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site": {
        if (request.mode === "clone")
          throw unsupportedOperation(PROVIDER, "sites.clone");
        return this.#sendAction(
          "sites.create",
          "POST",
          "/sites",
          siteBody(request.body),
        );
      }
      case "create-environment": {
        if (request.mode === "clone")
          throw unsupportedOperation(PROVIDER, "envs.clone");
        return this.#sendAction(
          "envs.create",
          "POST",
          "/installs",
          installBody(request.siteId, request.body),
        );
      }
      case "add-domain":
        return this.#sendAction(
          "domains.add",
          "POST",
          `/installs/${escapePathSegment(request.envId)}/domains`,
          domainBody(request.body),
        );
      case "change-primary-domain": {
        const domainId = domainIdFromBody(request.body);
        return this.#sendAction(
          "domains.primary",
          "PATCH",
          `/installs/${escapePathSegment(request.envId)}/domains/${escapePathSegment(domainId)}`,
          { primary: true },
        );
      }
      case "create-backup":
        return this.#sendAction(
          "backups.create",
          "POST",
          `/installs/${escapePathSegment(request.envId)}/backups`,
          backupBody(request.body),
        );
      case "restore-backup": {
        const { backupId, body } = restoreBody(request.body);
        return this.#sendAction(
          "backups.restore",
          "POST",
          `/installs/${escapePathSegment(request.targetEnvId)}/backups/${escapePathSegment(backupId)}/restore`,
          body,
        );
      }
      case "clear-cache": {
        const { installId, body } = cacheBody(request.cache, request.body);
        return this.#sendAction(
          "cache.clear",
          "POST",
          `/installs/${escapePathSegment(installId)}/purge_cache`,
          body,
        );
      }
      // Deliberately not mapped onto the Hosting Platform API.
      case "push-environment":
      case "restart-php":
      case "set-php-version":
      case "update-plugin":
      case "bulk-update-plugins":
      case "update-theme":
      case "bulk-update-themes":
      case "run-wp-cli":
      case "set-denied-ips":
      case "apply-redirects":
        throw unsupportedActionRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  /**
   * The endpoints mapped above either complete inline or return the resource
   * state directly, so there is no operation to poll. Ported verbatim from Go's
   * `OperationStatus`, which also never performs a request.
   */
  operationStatus(operationId: string): Promise<OperationStatus> {
    return Promise.resolve({
      provider: PROVIDER,
      operationId,
      status: 200,
      done: true,
      failed: false,
      message:
        "WP Engine does not support generic async operation status polling",
      raw: null,
    });
  }

  async #sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body?: JsonRecord,
  ): Promise<ActionResult> {
    const response = await this.#http.request({
      path,
      method,
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    });
    const raw = response.data;
    const message = stringField(raw, "message");
    const operationId = stringField(raw, "id");
    return {
      provider: PROVIDER,
      action,
      // Go's WP Engine `sendAction` reports the HTTP status verbatim; it does
      // not consult a `status` field in the payload the way Kinsta's shared
      // `buildActionResult` does.
      status: response.status,
      ...(message === undefined ? {} : { message }),
      ...(operationId === undefined ? {} : { operationId }),
      raw,
    };
  }

  /**
   * Walk an offset-paginated collection. The loop stops on an empty page, on an
   * empty `next` link, or once `offset` reaches the reported `count` — the same
   * three conditions as Go's `eachPage`.
   */
  async #eachPage(
    path: string,
    handle: (results: readonly unknown[]) => void,
  ): Promise<void> {
    let offset = 0;
    for (;;) {
      const raw = requireObject(
        await this.#http.json({
          path,
          query: [
            ["limit", String(PAGE_SIZE)],
            ["offset", String(offset)],
          ],
        }),
        path,
      );
      const results = Array.isArray(raw.results)
        ? (raw.results as readonly unknown[])
        : [];
      handle(results);
      const next = stringField(raw, "next") ?? "";
      if (results.length === 0 || next === "") return;
      offset += results.length;
      const count = numberField(raw, "count") ?? 0;
      if (count > 0 && offset >= count) return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

const NOTE_INSTALL_ENV = "WP Engine installs are exposed as environments";
const NOTE_NATIVE_JSON =
  "use --from-json with WP Engine-native fields for full control";
const NOTE_NOT_MAPPED = "not mapped for WP Engine in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by WP Engine's provider-neutral Novamira mapping";

function capabilities(): ProviderCapability[] {
  return providerCapabilities([
    ["providers.validate", true],
    ["providers.capabilities", true],
    ["sites.list", true],
    ["sites.get", true],
    ["envs.list", true, NOTE_INSTALL_ENV],
    ["envs.get", true, NOTE_INSTALL_ENV],
    ["ops.get", false, NOTE_NOT_MAPPED],
    ["ops.wait", false, NOTE_NOT_MAPPED],
    ["regions.list", false, NOTE_NOT_MAPPED],
    ["activity.list", false, NOTE_NOT_MAPPED],
    ["sites.create", true, `uses POST /sites; ${NOTE_NATIVE_JSON}`],
    ["sites.create-plain", true, `uses POST /sites; ${NOTE_NATIVE_JSON}`],
    ["sites.clone", false, NOTE_UNSUPPORTED],
    ["envs.create", true, `uses POST /installs; ${NOTE_NATIVE_JSON}`],
    ["envs.create-plain", true, `uses POST /installs; ${NOTE_NATIVE_JSON}`],
    ["envs.clone", false, NOTE_UNSUPPORTED],
    ["envs.push", false, NOTE_UNSUPPORTED],
    ["domains.list", true, "uses GET /installs/{install_id}/domains"],
    ["domains.add", true, "uses POST /installs/{install_id}/domains"],
    [
      "domains.primary",
      true,
      "uses PATCH /installs/{install_id}/domains/{domain_id}",
    ],
    ["dns.domains.list", false, NOTE_NOT_MAPPED],
    ["backups.list", true, "uses GET /installs/{install_id}/backups"],
    [
      "backups.create",
      true,
      `uses POST /installs/{install_id}/backups; ${NOTE_NATIVE_JSON}`,
    ],
    [
      "backups.restore",
      true,
      "uses POST /installs/{install_id}/backups/{backup_id}/restore",
    ],
    ["cache.clear", true, "uses POST /installs/{install_id}/purge_cache"],
    ["php.restart", false, NOTE_UNSUPPORTED],
    ["php.set-version", false, NOTE_NOT_MAPPED],
    ["wp.plugins.list", false, NOTE_NOT_MAPPED],
    [
      "wp.plugins.install",
      false,
      "WP Engine exposes WP-CLI through SSH/User Portal, not the Hosting Platform API used by Novamira",
    ],
    ["wp.themes.list", false, NOTE_NOT_MAPPED],
    ["wp-cli.run", false, NOTE_NOT_MAPPED],
    ["logs.get", false, NOTE_NOT_MAPPED],
    ["analytics.usage", false, NOTE_NOT_MAPPED],
    ["analytics.env", false, NOTE_NOT_MAPPED],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function siteToHosting(
  site: JsonRecord,
  includeEnvironments: boolean,
): HostingSite {
  const name = stringField(site, "name") ?? "";
  let primaryDomain: string | undefined;
  let environments: HostingEnvironment[] | undefined;
  if (includeEnvironments) {
    environments = [];
    const installs = Array.isArray(site.installs)
      ? (site.installs as readonly unknown[])
      : [];
    for (const entry of installs) {
      const install = asRecord(entry);
      if (install === undefined) continue;
      const environment = installToHosting(install);
      environments.push(environment);
      // The site inherits the first install domain it finds, as in Go.
      if (
        primaryDomain === undefined &&
        environment.primaryDomain !== undefined
      )
        primaryDomain = environment.primaryDomain;
    }
  }
  return {
    id: stringField(site, "id") ?? "",
    name,
    displayName: name,
    status: site.sandbox === true ? "sandbox" : "active",
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
    ...(environments === undefined ? {} : { environments }),
  };
}

function installToHosting(install: JsonRecord): HostingEnvironment {
  const installName = stringField(install, "name") ?? "";
  const environment = stringField(install, "environment") ?? "";
  const cname = stringField(install, "cname") ?? "";
  const status = stringField(install, "status") ?? "";
  // A declared `primary_domain` wins even when it is empty: Go only falls back
  // to the CNAME when the field is absent or null.
  const declaredDomain = stringField(install, "primary_domain");
  const primaryDomain = declaredDomain ?? (cname === "" ? undefined : cname);
  const wordpressVersion = stringField(install, "wp_version");
  const stableIps = Array.isArray(install.stable_ips)
    ? (install.stable_ips as readonly unknown[])
    : [];
  return {
    id: stringField(install, "id") ?? "",
    name: environment === "" ? installName : environment,
    displayName:
      environment === "" ? installName : `${installName} (${environment})`,
    isBlocked: status !== "" && status !== "active" && status !== "pending",
    isPremium: stableIps.length > 0,
    ...(wordpressVersion === undefined ? {} : { wordpressVersion }),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
  };
}

/* -------------------------------------------------------------------------- */
/* Payload helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Go's shared `objectBody`: a nil body is an empty object, a map is used as-is
 * and anything else is round-tripped through JSON and rejected unless it lands
 * on an object.
 *
 * Deviation: Go hands back — and then mutates — the caller's map. HQ copies, so
 * the request object the CLI or dashboard built is never modified in place.
 */
function objectBody(body: ActionBody): JsonRecord {
  if (body === undefined || body === null) return {};
  if (typeof body === "object" && !Array.isArray(body))
    return { ...(body as JsonRecord) };
  throw usageError("The WP Engine request body must be a JSON object.");
}

/**
 * Go renders body values with `fmt.Sprintf("%v", v)` and then rejects `""` and
 * the `"<nil>"` rendering of a nil. HQ collapses both into the empty string:
 * only JSON scalars produce text, and every caller treats `""` as absent.
 */
function scalarText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? String(value) : "";
    case "boolean":
      return String(value);
    case "bigint":
      return value.toString();
    default:
      return "";
  }
}

/** `name` falls back to `display_name` then `site_name`, as in Go. */
function applyNameFallback(body: JsonRecord): void {
  if ("name" in body) return;
  for (const key of ["display_name", "site_name"]) {
    if (!(key in body)) continue;
    const value = body[key];
    if (scalarText(value) !== "") {
      body.name = value;
      return;
    }
  }
}

function siteBody(body: ActionBody): JsonRecord {
  const payload = objectBody(body);
  applyNameFallback(payload);
  return payload;
}

function installBody(siteId: string, body: ActionBody): JsonRecord {
  const payload = objectBody(body);
  if (siteId !== "" && !("site_id" in payload)) payload.site_id = siteId;
  applyNameFallback(payload);
  return payload;
}

function domainBody(body: ActionBody): JsonRecord {
  const payload = objectBody(body);
  // Novamira's neutral `domain_name` seeds WP Engine's native `name`. Go copies
  // it without an emptiness check.
  if (!("name" in payload) && "domain_name" in payload)
    payload.name = payload.domain_name;
  return payload;
}

function backupBody(body: ActionBody): JsonRecord {
  const payload = objectBody(body);
  if (!("description" in payload) && "tag" in payload) {
    const tag = payload.tag;
    if (scalarText(tag) !== "") payload.description = tag;
  }
  return payload;
}

function cacheBody(
  cache: CacheKind,
  body: ActionBody,
): { readonly installId: string; readonly body: JsonRecord } {
  const payload = objectBody(body);
  const installId = extractSiteId(payload);
  if (installId === "")
    throw usageError(
      "WP Engine needs an env/environment_id to clear a cache for.",
    );
  let type = cacheKindToType(cache);
  const declared = scalarText(payload.type);
  if ("type" in payload && declared !== "") type = declared;
  return { installId, body: { type } };
}

function cacheKindToType(cache: CacheKind): string {
  switch (cache) {
    case "site":
      return "page";
    case "edge":
      return "all";
    case "cdn":
      return "cdn";
    default:
      return assertNever(cache);
  }
}

/**
 * The neutral keys a request body may carry an install id under, in Go's
 * `extractSiteID` order. The first key that is *present* wins, even when its
 * value renders empty.
 */
const SITE_ID_KEYS = ["site_id", "siteId", "id", "environment_id", "envId"];

function extractSiteId(body: JsonRecord): string {
  for (const key of SITE_ID_KEYS) if (key in body) return scalarText(body[key]);
  return "";
}

function domainIdFromBody(body: ActionBody): string {
  const payload = objectBody(body);
  for (const key of ["domain_id", "id"]) {
    const text = key in payload ? scalarText(payload[key]) : "";
    if (text !== "") return text;
  }
  throw usageError(
    "WP Engine needs a domain_id or id to change the primary domain.",
  );
}

function restoreBody(body: ActionBody): {
  readonly backupId: string;
  readonly body: JsonRecord;
} {
  const payload = objectBody(body);
  for (const key of ["backup_id", "id"]) {
    const text = key in payload ? scalarText(payload[key]) : "";
    if (text === "") continue;
    return {
      backupId: text,
      body: Object.fromEntries(
        Object.entries(payload).filter(([name]) => name !== key),
      ),
    };
  }
  throw usageError("WP Engine needs a backup_id or id to restore a backup.");
}

function usageError(message: string): CliError {
  return new CliError("usage_error", message, {
    details: { provider: PROVIDER },
  });
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                               */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Mirrors Go's "failed to decode WP Engine response from %s" decode failure. */
function requireObject(value: unknown, path: string): JsonRecord {
  const record = asRecord(value);
  if (record === undefined)
    throw new CliError(
      "provider_error",
      "The WP Engine API returned an unexpected response shape.",
      { details: { provider: PROVIDER, path } },
    );
  return record;
}

/** Go's `jsonStringField`: the named field when it is a JSON string. */
function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

/**
 * Percent-escape one path segment. `encodeURIComponent` escapes `/` and every
 * reserved delimiter Go's `url.PathEscape` escapes; the two differ only on a
 * handful of sub-delimiters that no WP Engine identifier contains.
 */
function escapePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

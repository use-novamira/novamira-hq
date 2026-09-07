// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Kinsta provider client, ported from `internal/providers/kinsta.go`.
 *
 * Kinsta is the reference provider: it maps every member of both request
 * unions, so this module has no `unsupportedReadRequest` /
 * `unsupportedActionRequest` case at all — every `switch` arm is a real
 * endpoint and the `default` arm is the `assertNever` exhaustiveness guard.
 *
 * Deviations from the Go source are marked with `Deviation:` comments where
 * they occur. The recurring ones are:
 *
 * - transport. Go owns a bare `http.Client`, formats its own query string and
 *   turns a non-2xx status into `fmt.Errorf("Kinsta API request to %s failed
 *   with %d: %s")`. HQ delegates all of that to the shared `HttpClient`, which
 *   already applies the `CliError` taxonomy (401/403 → `credential_invalid`,
 *   404 → `not_found`, 429 → `rate_limited`, ...), redacts the bearer token
 *   from diagnostics, and preserves query-pair order exactly like Go's
 *   `buildQuery`.
 * - path segments are percent-encoded. Go interpolates ids straight into the
 *   path with `fmt.Sprintf`; every id Kinsta issues is a UUID, so encoding is a
 *   no-op in practice while removing a path-injection shape.
 * - scalar leniency. Go decodes site and environment payloads into structs, so
 *   a single mistyped scalar (`"is_blocked": 0`) fails the whole listing. HQ
 *   falls back to the Go zero value for scalars and only rejects a structurally
 *   wrong payload (an object where an array was promised, and the reverse).
 */

import { CliError } from "../../errors.js";
import type { ProviderKind } from "../../config/schema.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  assertNever,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import {
  type HttpClient,
  type HttpMethod,
  dynamicAuth,
  jsonBody,
} from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
  type Query,
  providerCapabilities,
  serializeProviderCapability,
} from "../types.js";

const PROVIDER: ProviderKind = "kinsta";

/**
 * The ordered capability list of `KinstaClient.capabilities`, verbatim. Every
 * entry is supported and carries no notes, which is why the Go source models it
 * as a `[]string` rather than the `{name, supported, notes}` slice the other
 * providers use.
 */
const KINSTA_CAPABILITIES: readonly string[] = [
  "providers.validate",
  "providers.capabilities",
  "regions.list",
  "activity.list",
  "sites.list",
  "sites.get",
  "sites.create",
  "sites.create-plain",
  "sites.clone",
  "envs.list",
  "envs.get",
  "envs.create",
  "envs.create-plain",
  "envs.clone",
  "envs.push",
  "domains.list",
  "domains.add",
  "domains.verify",
  "domains.primary",
  "dns.domains.list",
  "dns.records.list",
  "backups.list",
  "backups.downloadable",
  "backups.create",
  "backups.restore",
  "cache.clear",
  "php.restart",
  "php.set-version",
  "redirects.list",
  "redirects.apply",
  "denied-ips.list",
  "denied-ips.set",
  "wp.plugins.list",
  "wp.plugins.install",
  "wp.plugins.update",
  "wp.plugins.update-all",
  "wp.themes.list",
  "wp.themes.update",
  "wp.themes.update-all",
  "wp-cli.run",
  "logs.get",
  "analytics.usage",
  "analytics.env",
  "ops.get",
  "ops.wait",
];

/** `usageMetricPath`: the metric doubles as the path segment. */
const USAGE_METRICS: ReadonlySet<string> = new Set([
  "visits",
  "bandwidth",
  "cdn-bandwidth",
]);

/** `envAnalyticsMetricPath`. */
const ENVIRONMENT_ANALYTICS_METRICS: ReadonlySet<string> = new Set([
  "cdn-bandwidth",
  "visits",
  "bandwidth",
  "diskspace",
  "top-countries",
  "top-cities",
  "top-client-ips",
  "visits-dispersion",
  "response-codes",
]);

/** The JSON pointers `bulkUpdateBody` walks into a plugin/theme inventory. */
const PLUGIN_INVENTORY_POINTER = "/environment/container_info/wp_plugins/data";
const THEME_INVENTORY_POINTER = "/environment/container_info/wp_themes/data";

/**
 * Kinsta reports a finished-but-failed operation as HTTP 500 with a JSON body,
 * so `operationStatus` accepts it instead of raising `provider_error`. Go spells
 * the same rule as an explicit `httpStatus != 500` guard before its error path.
 */
const OPERATION_STATUS_ACCEPTED: readonly number[] = [500];

class KinstaClient implements ProviderClient {
  readonly provider = PROVIDER;

  readonly #http: HttpClient;
  readonly #credentialSource: string;
  readonly #companyId: string | undefined;

  constructor(context: ProviderClientContext) {
    this.#http = context.createHttpClient({
      // The only place the secret is revealed: building `Authorization`. The
      // token is handed to the client as a literal secret so it is scrubbed
      // from diagnostics and error details.
      auth: dynamicAuth(() => {
        const token = context.secret.reveal();
        return {
          headers: { authorization: `Bearer ${token}` },
          secrets: [token],
        };
      }),
    });
    this.#credentialSource = context.credentialSource;
    this.#companyId = context.companyId;
  }

  async validate(): Promise<ProviderValidation> {
    const response = await this.#http.json({ path: "/validate" });
    const body = responseObject(response, "/validate");
    return {
      provider: PROVIDER,
      status: scalarString(body.status),
      // Go always returns a non-nil pointer here, even for an absent `company`,
      // so the serialized `company_id` stays a string rather than `null`.
      companyId: scalarString(body.company),
      credential: this.#credentialSource,
    };
  }

  async listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const companyId = await this.#resolveCompanyId(options?.companyId);
    const path = "/sites";
    const response = await this.#get(path, [
      ["company", companyId],
      // Go formats the bool with `%v`, so the parameter is always sent.
      [
        "include_environments",
        options?.includeEnvironments === true ? "true" : "false",
      ],
    ]);
    const company = optionalObject(
      responseObject(response, path),
      "company",
      path,
    );
    const sites = optionalArray(company ?? {}, "sites", path) ?? [];
    return sites.map((site) => toHostingSite(site, path));
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const path = `/sites/${segment(siteId)}`;
    const response = await this.#get(path);
    const site = optionalObject(responseObject(response, path), "site", path);
    return toHostingSite(site ?? {}, path);
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    const path = `/sites/${segment(siteId)}/environments`;
    const response = await this.#get(path);
    const site = optionalObject(responseObject(response, path), "site", path);
    const environments = optionalArray(site ?? {}, "environments", path) ?? [];
    return environments.map((environment) =>
      toHostingEnvironment(environment, path),
    );
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        // Go marshals `[]ProviderCapability`; the serializer reproduces those
        // struct tags, including `notes,omitempty`.
        return providerCapabilities(KINSTA_CAPABILITIES).map(
          serializeProviderCapability,
        );

      case "regions": {
        const companyId = await this.#resolveCompanyId(request.companyId);
        return this.#get(`/company/${segment(companyId)}/available-regions`);
      }

      case "activity": {
        const companyId = await this.#resolveCompanyId(request.companyId);
        return this.#get(
          `/company/${segment(companyId)}/activity-logs`,
          request.query,
        );
      }

      case "site-domains":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/domains`,
        );

      case "site-domain-verification":
        return this.#get(
          `/sites/environments/domains/${segment(request.siteDomainId)}/verification-records`,
        );

      case "dns-domains": {
        const companyId = await this.#resolveCompanyId(request.companyId);
        return this.#get("/domains", [["company", companyId]]);
      }

      case "dns-records":
        return this.#get(`/domains/${segment(request.domainId)}/dns-records`);

      case "backups":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/backups`,
        );

      case "downloadable-backups":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/downloadable-backups`,
        );

      case "logs":
        return this.#get(`/sites/environments/${segment(request.envId)}/logs`, [
          ["file_name", request.fileName],
          ["lines", wholeNumber(request.lines, "log line count")],
        ]);

      case "redirects":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/redirect-rules`,
          request.query,
        );

      case "denied-ips":
        return this.#get("/sites/tools/denied-ips", [
          ["environment_id", request.envId],
        ]);

      case "plugins":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/wp-plugins`,
        );

      case "themes":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/wp-themes`,
        );

      case "company-plugins": {
        const companyId = await this.#resolveCompanyId(request.companyId);
        return this.#get(`/company/${segment(companyId)}/wp-plugins`);
      }

      case "company-themes": {
        const companyId = await this.#resolveCompanyId(request.companyId);
        return this.#get(`/company/${segment(companyId)}/wp-themes`);
      }

      case "analytics-usage": {
        const metric = usageMetric(request.metric);
        return this.#get(
          `/sites/${segment(request.siteId)}/usage/${metric}/this-month`,
        );
      }

      case "analytics-env": {
        const metric = environmentAnalyticsMetric(request.metric);
        const query = request.query ?? [];
        const scoped = query.some(([name]) => name === "company_id")
          ? query
          : [...query, ["company_id", await this.#resolveCompanyId()] as const];
        return this.#get(
          `/sites/environments/${segment(request.envId)}/analytics/${metric}`,
          scoped,
        );
      }

      case "file-list":
        return this.#get(
          `/sites/environments/${segment(request.envId)}/file-list`,
        );

      default:
        return assertNever(request);
    }
  }

  async action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site": {
        const body = await this.#bodyWithCompany(request.body);
        switch (request.mode) {
          case "wordpress":
            return this.#send("sites.create", "POST", "/sites", body);
          case "plain":
            return this.#send(
              "sites.create-plain",
              "POST",
              "/sites/plain",
              body,
            );
          case "clone":
            return this.#send("sites.clone", "POST", "/sites/clone", body);
          default:
            return assertNever(request.mode);
        }
      }

      case "create-environment": {
        const base = `/sites/${segment(request.siteId)}/environments`;
        switch (request.mode) {
          case "wordpress":
            return this.#send("envs.create", "POST", base, request.body);
          case "plain":
            return this.#send(
              "envs.create-plain",
              "POST",
              `${base}/plain`,
              request.body,
            );
          case "clone":
            return this.#send(
              "envs.clone",
              "POST",
              `${base}/clone`,
              request.body,
            );
          default:
            return assertNever(request.mode);
        }
      }

      case "push-environment":
        return this.#send(
          "envs.push",
          "PUT",
          `/sites/${segment(request.siteId)}/environments`,
          request.body,
        );

      case "clear-cache":
        switch (request.cache) {
          case "site":
            return this.#send(
              "cache.clear",
              "POST",
              "/sites/tools/clear-cache",
              request.body,
            );
          case "edge":
            return this.#send(
              "cache.clear-edge",
              "POST",
              "/sites/edge-caching/clear",
              request.body,
            );
          case "cdn":
            return this.#send(
              "cache.clear-cdn",
              "POST",
              "/sites/cdn/clear-cache",
              request.body,
            );
          default:
            return assertNever(request.cache);
        }

      case "restart-php":
        // Go builds the body from the request rather than forwarding one.
        return this.#send("php.restart", "POST", "/sites/tools/restart-php", {
          environment_id: request.envId,
        });

      case "set-php-version":
        return this.#send(
          "php.set-version",
          "PUT",
          "/sites/tools/modify-php-version",
          request.body,
        );

      case "add-domain":
        return this.#send(
          "domains.add",
          "POST",
          `/sites/environments/${segment(request.envId)}/domains`,
          request.body,
        );

      case "change-primary-domain":
        return this.#send(
          "domains.primary",
          "PUT",
          `/sites/environments/${segment(request.envId)}/change-primary-domain`,
          request.body,
        );

      case "create-backup":
        return this.#send(
          "backups.create",
          "POST",
          `/sites/environments/${segment(request.envId)}/manual-backups`,
          request.body,
        );

      case "restore-backup":
        return this.#send(
          "backups.restore",
          "POST",
          `/sites/environments/${segment(request.targetEnvId)}/backups/restore`,
          request.body,
        );

      case "update-plugin":
        return this.#send(
          "wp.plugins.update",
          "PUT",
          `/sites/environments/${segment(request.envId)}/plugins`,
          request.body,
        );

      case "bulk-update-plugins": {
        const body = await this.#bulkUpdateBody(
          request.envId,
          request.body,
          "plugins",
          PLUGIN_INVENTORY_POINTER,
        );
        return this.#send(
          "wp.plugins.update-all",
          "PUT",
          `/sites/environments/${segment(request.envId)}/plugins/bulk-update`,
          body,
        );
      }

      case "update-theme":
        return this.#send(
          "wp.themes.update",
          "PUT",
          `/sites/environments/${segment(request.envId)}/themes`,
          request.body,
        );

      case "bulk-update-themes": {
        const body = await this.#bulkUpdateBody(
          request.envId,
          request.body,
          "themes",
          THEME_INVENTORY_POINTER,
        );
        return this.#send(
          "wp.themes.update-all",
          "PUT",
          `/sites/environments/${segment(request.envId)}/themes/bulk-update`,
          body,
        );
      }

      case "run-wp-cli":
        return this.#send(
          "wp-cli.run",
          "POST",
          `/sites/environments/${segment(request.envId)}/run-wp-cli-command`,
          request.body,
        );

      case "set-denied-ips":
        return this.#send(
          "denied-ips.set",
          "PUT",
          "/sites/tools/denied-ips",
          request.body,
        );

      case "apply-redirects":
        return this.#send(
          "redirects.apply",
          "POST",
          `/sites/environments/${segment(request.envId)}/redirect-rules`,
          request.body,
        );

      default:
        return assertNever(request);
    }
  }

  async operationStatus(operationId: string): Promise<OperationStatus> {
    const response = await this.#http.request({
      path: `/operations/${segment(operationId)}`,
      acceptStatuses: OPERATION_STATUS_ACCEPTED,
    });
    const raw = response.data;
    const reported = jsonStatusField(raw);
    const status = reported === 0 ? response.status : reported;
    const message = jsonStringField(raw, "message");
    return {
      provider: PROVIDER,
      operationId,
      status,
      done: response.status === 200 || status === 200,
      failed: response.status === 500 || status >= 500,
      ...(message === undefined ? {} : { message }),
      raw,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                              */
  /* ---------------------------------------------------------------------- */

  async #get(path: string, query?: Query): Promise<unknown> {
    return this.#http.json({
      path,
      ...(query === undefined || query.length === 0 ? {} : { query }),
    });
  }

  async #send(
    action: string,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<ActionResult> {
    // Go sends a request body only for a non-nil `any`, and `json.Unmarshal`
    // of a JSON `null` payload yields exactly that nil, so both `undefined`
    // and `null` mean "no body" here.
    const response = await this.#http.request({
      path,
      method,
      ...(body === undefined || body === null ? {} : { body: jsonBody(body) }),
    });
    return buildActionResult(action, response.status, response.data);
  }

  /** `resolveCompanyID`: requested, then the profile's, then `/validate`. */
  async #resolveCompanyId(requested?: string): Promise<string> {
    if (requested !== undefined && requested !== "") return requested;
    if (this.#companyId !== undefined) return this.#companyId;
    const validation = await this.validate();
    // Deviation: Go guards on a nil pointer that its own `Validate` can never
    // produce. HQ treats an absent or empty `company` as the same failure,
    // because sending `?company=` would silently query the wrong scope.
    if (validation.companyId === null || validation.companyId === "") {
      throw new CliError(
        "provider_error",
        "Kinsta validation did not return a company id; set the profile's company id and try again.",
      );
    }
    return validation.companyId;
  }

  /** `bodyWithCompany`: default the `company` key of a create-site payload. */
  async #bodyWithCompany(body: unknown): Promise<Record<string, unknown>> {
    const target = objectBody(body);
    if (Object.hasOwn(target, "company")) return target;
    return { ...target, company: await this.#resolveCompanyId() };
  }

  /**
   * `bulkUpdateBody`: keep a caller-supplied, non-empty collection, otherwise
   * read the environment's inventory and collect every item that has an update
   * available.
   */
  async #bulkUpdateBody(
    envId: string,
    body: unknown,
    collection: "plugins" | "themes",
    pointer: string,
  ): Promise<Record<string, unknown>> {
    const target = objectBody(body);
    const supplied = target[collection];
    // Deviation: Go additionally re-decodes a `json.RawMessage` here, which is
    // a Go decoding artifact — HQ's request bodies are already parsed values.
    if (Array.isArray(supplied) && supplied.length > 0) return target;

    const inventory = await this.read(
      collection === "plugins"
        ? { kind: "plugins", envId }
        : { kind: "themes", envId },
    );
    const items = collectUpdatableNames(inventory, pointer);
    if (items.length === 0) {
      // Go raises "no plugins with available updates found"; `not_found` is the
      // taxonomy entry for "the thing you asked to act on is not there".
      throw new CliError(
        "not_found",
        `No ${collection} with available updates were found in this Kinsta environment.`,
        { details: { provider: PROVIDER, environmentId: envId } },
      );
    }
    return { ...target, [collection]: items };
  }
}

/** The registry entry the composition root wires up. */
export const createKinstaClient: ProviderClientFactory = (context) =>
  new KinstaClient(context);

/* -------------------------------------------------------------------------- */
/* payload normalization                                                      */
/* -------------------------------------------------------------------------- */

function toHostingSite(value: unknown, path: string): HostingSite {
  const record = responseObject(value, path);
  const site: HostingSite = {
    id: scalarString(record.id),
    name: scalarString(record.name),
    displayName: scalarString(record.display_name),
    status: scalarString(record.status),
  };

  const raw = optionalArray(record, "environments", path);
  // `kinstaSiteToHosting` attaches environments only when the site carries at
  // least one, so an empty array stays an absent field rather than `[]`.
  if (raw === undefined || raw.length === 0) return site;

  const environments = raw.map((environment) =>
    toHostingEnvironment(environment, path),
  );
  const primaryDomain = environments.find(
    (environment) => environment.primaryDomain !== undefined,
  )?.primaryDomain;
  return {
    ...site,
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
    environments,
  };
}

function toHostingEnvironment(
  value: unknown,
  path: string,
): HostingEnvironment {
  const record = responseObject(value, path);
  const wordpressVersion = record.wordpress_version;
  const domain = optionalObject(record, "primaryDomain", path);
  return {
    id: scalarString(record.id),
    name: scalarString(record.name),
    displayName: scalarString(record.display_name),
    isBlocked: record.is_blocked === true,
    isPremium: record.is_premium === true,
    ...(typeof wordpressVersion === "string" ? { wordpressVersion } : {}),
    // Go copies the domain's name even when it is empty, because it tests the
    // pointer rather than the string.
    ...(domain === undefined
      ? {}
      : { primaryDomain: scalarString(domain.name) }),
  };
}

/** `buildActionResult`. */
function buildActionResult(
  action: string,
  httpStatus: number,
  raw: unknown,
): ActionResult {
  const reported = jsonStatusField(raw);
  const message = jsonStringField(raw, "message");
  const operationId = jsonStringField(raw, "operation_id");
  return {
    provider: PROVIDER,
    action,
    status: reported === 0 ? httpStatus : reported,
    ...(message === undefined ? {} : { message }),
    ...(operationId === undefined ? {} : { operationId }),
    raw,
  };
}

/**
 * `jsonStatusField`: the body's `status`, or `0` when it is absent, not a
 * number, not a whole number, or outside Go's 0-65535 acceptance window.
 */
function jsonStatusField(raw: unknown): number {
  const record = asRecord(raw);
  if (record === undefined) return 0;
  const value = record.status;
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  if (value < 0 || value > 65535) return 0;
  return value;
}

/** `jsonStringField`. */
function jsonStringField(raw: unknown, key: string): string | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** `objectBody`. A copy is returned so the caller's payload is never mutated. */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  const record = asRecord(body);
  if (record === undefined) {
    throw new CliError(
      "usage_error",
      "The Kinsta request body must be a JSON object.",
      { details: { provider: PROVIDER } },
    );
  }
  return { ...record };
}

/** `collectUpdatableNames`. */
function collectUpdatableNames(
  raw: unknown,
  pointer: string,
): { readonly name: string }[] {
  const node = jsonPointer(raw, pointer);
  if (!Array.isArray(node)) return [];
  const names: { readonly name: string }[] = [];
  for (const item of node) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const updatable =
      record.update === "available" ||
      (Object.hasOwn(record, "update_version") &&
        record.update_version !== null &&
        record.update_version !== undefined);
    if (!updatable) continue;
    const name = record.name;
    if (typeof name !== "string") continue;
    names.push({ name });
  }
  return names;
}

/**
 * `jsonPointer`. Only object tokens are walked — Go returns nil for an array
 * node, and both pointers used here address object members. The `~1` before
 * `~0` unescaping order is Go's; it matters only for a `~01` token.
 */
function jsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return root;
  const parts = (pointer.startsWith("/") ? pointer.slice(1) : pointer).split(
    "/",
  );
  let current: unknown = root;
  for (const part of parts) {
    const token = part.replaceAll("~1", "/").replaceAll("~0", "~");
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[token];
  }
  return current;
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A JSON object, or `undefined` for anything else (including an array). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/** Go's zero value for a `string` struct field. */
function scalarString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function responseObject(value: unknown, path: string): Record<string, unknown> {
  // A JSON `null` decodes into a Go struct without error, leaving zero values.
  if (value === null || value === undefined) return {};
  const record = asRecord(value);
  if (record === undefined) throw decodeError(path);
  return record;
}

function optionalObject(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  const nested = asRecord(value);
  if (nested === undefined) throw decodeError(path);
  return nested;
}

function optionalArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw decodeError(path);
  return value as unknown[];
}

function decodeError(path: string): CliError {
  return new CliError(
    "provider_error",
    `The Kinsta API returned an unexpected response shape from ${path}.`,
    { details: { provider: PROVIDER, path } },
  );
}

/** Percent-encode an id before it becomes a path segment. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Go's `%d` over a `uint32`/`uint64`. The unions type these as `number`, so the
 * whole-number guarantee has to be enforced here instead of by the type system.
 */
function wholeNumber(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliError(
      "usage_error",
      `The Kinsta ${label} must be a non-negative whole number.`,
      { details: { provider: PROVIDER, value } },
    );
  }
  return String(value);
}

function usageMetric(metric: string): string {
  if (!USAGE_METRICS.has(metric)) {
    throw new CliError(
      "usage_error",
      `Kinsta does not support the "${metric}" usage metric.`,
      {
        details: {
          provider: PROVIDER,
          metric,
          metrics: [...USAGE_METRICS],
        },
      },
    );
  }
  return metric;
}

function environmentAnalyticsMetric(metric: string): string {
  if (!ENVIRONMENT_ANALYTICS_METRICS.has(metric)) {
    throw new CliError(
      "usage_error",
      `Kinsta does not support the "${metric}" environment analytics metric.`,
      {
        details: {
          provider: PROVIDER,
          metric,
          metrics: [...ENVIRONMENT_ANALYTICS_METRICS],
        },
      },
    );
  }
  return metric;
}

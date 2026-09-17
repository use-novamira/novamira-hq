// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Cloudways provider client, ported from `internal/providers/cloudways.go`.
 *
 * Cloudways exchanges an account email plus an API key for a short-lived OAuth
 * bearer token, so the module supplies `dynamicAuth` over a small token cache
 * rather than a static header. The API key is revealed exactly once per refresh,
 * inside the token exchange that builds the authorization header.
 *
 * Two Cloudways quirks shape everything below:
 *
 * - The API takes **every** field as a query parameter, even for `POST` and
 *   `DELETE`. Go's `sendRaw` flattens the request body into sorted query pairs
 *   and sends no HTTP body at all; this port does the same, so the wire format
 *   is byte-identical apart from the percent-encoding note on `queryValue`.
 * - There is no environment concept. An application is exposed as one synthetic
 *   environment whose id is `server_id:app_id`, which is also the reference the
 *   `--env` flag carries back in.
 *
 * Deviations from the Go source are noted where they occur. The two systemic
 * ones:
 *
 * - Error mapping. Go builds its own `Cloudways API request to %s failed with
 *   %d: %s` string with a Cloudways-specific message extractor that also reads
 *   `errors[]` and `fields{}`. HQ's shared `HttpClient` owns HTTP failure
 *   mapping (status to `ErrorCode`, remote message extraction, redaction), so
 *   this module does not re-implement it; a Cloudways `errors`/`fields` error
 *   body therefore surfaces as the truncated raw body instead of a synthesized
 *   summary. Everything else about the failure is strictly richer.
 * - Retries. Go retries nothing. HQ's client retries safe methods (GET/HEAD)
 *   only, which cannot produce a second side effect, and this module opts no
 *   mutating request into `idempotent`.
 */

import { CliError } from "../../errors.js";
import {
  cloudwaysPlugins,
  cloudwaysSetupTarget,
  setupCloudwaysNovamira,
} from "./cloudways-setup.js";
import {
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../../output/redact.js";
import {
  DEFAULT_CLOUDWAYS_EMAIL_ENV,
  type ProviderKind,
} from "../../config/schema.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import {
  type HttpClient,
  type HttpMethod,
  dynamicAuth,
  formBody,
} from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderCapability,
  type ProviderCapabilityInput,
  type ProviderValidation,
  type Query,
  type QueryParameter,
  providerCapabilities,
  serializeProviderCapability,
} from "../types.js";

const PROVIDER: ProviderKind = "cloudways";

/** Go's fallback when the OAuth response omits or zeroes `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
/** Go refreshes a minute early, unless that would make the lifetime negative. */
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

const SYNTHETIC_ENV_NOTE =
  "Cloudways applications are exposed as one synthetic environment using server_id:app_id";
const NATIVE_FIELDS_NOTE =
  "use --from-json with Cloudways-native field names where generic flags do not cover the request";
const NOT_MAPPED_NOTE = "not mapped for Cloudways in Novamira";

const CAPABILITY_ENTRIES: readonly ProviderCapabilityInput[] = [
  [
    "novamira.setup",
    true,
    "Installs and activates Novamira through WP Manager; AI Abilities may need enabling in WordPress before connecting.",
  ],
  ["providers.validate", true],
  ["providers.capabilities", true],
  ["sites.list", true, "uses GET /apps"],
  ["sites.get", true, "uses GET /apps and filters locally"],
  ["envs.list", true, SYNTHETIC_ENV_NOTE],
  ["envs.get", true, SYNTHETIC_ENV_NOTE],
  ["ops.get", true, "uses GET /operation/{id}"],
  ["ops.wait", true, "uses GET /operation/{id}"],
  ["regions.list", true, "uses GET /regions"],
  ["activity.list", false, NOT_MAPPED_NOTE],
  ["sites.create", true, `uses POST /app; ${NATIVE_FIELDS_NOTE}`],
  ["sites.create-plain", true, `uses POST /app; ${NATIVE_FIELDS_NOTE}`],
  [
    "sites.clone",
    true,
    `uses POST /app/clone or /app/cloneToOtherServer; ${NATIVE_FIELDS_NOTE}`,
  ],
  [
    "envs.create",
    true,
    `uses POST /staging/app/cloneApp; ${NATIVE_FIELDS_NOTE}`,
  ],
  ["envs.create-plain", false, SYNTHETIC_ENV_NOTE],
  [
    "envs.clone",
    true,
    `uses POST /staging/app/cloneApp; ${NATIVE_FIELDS_NOTE}`,
  ],
  [
    "envs.push",
    false,
    "Cloudways provider-native sync fields do not implement Novamira HQ's granular push contract",
  ],
  ["domains.list", false, NOT_MAPPED_NOTE],
  [
    "domains.add",
    true,
    "uses POST /app/manage/aliases; sends complete aliases list",
  ],
  ["domains.primary", true, "uses POST /app/manage/cname"],
  ["backups.list", false, NOT_MAPPED_NOTE],
  [
    "backups.create",
    true,
    "uses POST /server/manage/backup for server-level backup or /app/manage/backup when app_id is supplied",
  ],
  ["cache.clear", true, "uses POST /service/varnish with action=purge"],
  [
    "php.restart",
    true,
    "discovers the versioned php*-fpm service and uses POST /service/state",
  ],
  ["php.set-version", false, NOT_MAPPED_NOTE],
  ["wp.plugins.list", true, "uses Cloudways WP Manager"],
  [
    "wp.plugins.install",
    false,
    "Cloudways exposes app SSH/SFTP credentials but no mapped API command-run endpoint",
  ],
  ["wp.themes.list", false, NOT_MAPPED_NOTE],
  ["wp-cli.run", false, NOT_MAPPED_NOTE],
  ["logs.get", false, NOT_MAPPED_NOTE],
  ["analytics.usage", true, "uses Cloudways server/app monitor endpoints"],
  [
    "analytics.env",
    false,
    "Cloudways monitor detail is not reliably mapped in Novamira",
  ],
];

const CAPABILITIES: readonly ProviderCapability[] =
  providerCapabilities(CAPABILITY_ENTRIES);

/**
 * Constructs the Cloudways client. Mirrors `NewCloudwaysClient`: the account
 * email is the profile's `companyId` or `CLOUDWAYS_EMAIL` (the factory resolves
 * that order into `context.identity`), and both halves are required up front.
 */
export const createCloudwaysClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  const email = context.identity?.trim() ?? "";
  if (email === "") {
    throw new CliError(
      "credential_missing",
      `The Cloudways account email is required; set ${DEFAULT_CLOUDWAYS_EMAIL_ENV} or the profile's company id.`,
      {
        details: {
          provider: PROVIDER,
          identityEnv: DEFAULT_CLOUDWAYS_EMAIL_ENV,
        },
      },
    );
  }
  // `length` is a non-secret property of `SecretValue`, so the emptiness check
  // Go performs on the resolved API key costs no `reveal()` here.
  if (context.secret.length === 0) {
    throw new CliError(
      "credential_missing",
      "The Cloudways API key is empty.",
      {
        details: { provider: PROVIDER, credential: context.credentialSource },
      },
    );
  }

  return new CloudwaysClient(context, email);
};

interface CachedToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

/**
 * The one class in this module. It exists only to hold the token cache and the
 * `HttpClient` next to the `ProviderClient` methods; every request variant is
 * dispatched through a discriminated-union `switch`, never through subclassing.
 */
class CloudwaysClient implements ProviderClient {
  readonly provider: ProviderKind = PROVIDER;

  readonly #context: ProviderClientContext;
  readonly #email: string;
  readonly #http: HttpClient;
  #token: CachedToken | undefined;
  /** In-flight refresh, so concurrent requests share one exchange (Go's mutex). */
  #refresh: Promise<string> | undefined;

  constructor(context: ProviderClientContext, email: string) {
    this.#context = context;
    this.#email = email;
    this.#http = context.createHttpClient({
      auth: dynamicAuth(async () => {
        const token = await this.#ensureToken();
        return {
          headers: { authorization: `Bearer ${token}` },
          secrets: [token],
        };
      }),
    });
  }

  async validate(): Promise<ProviderValidation> {
    await this.#ensureToken();
    return {
      provider: PROVIDER,
      status: "active",
      companyId: this.#email,
      credential: this.#context.credentialSource,
    };
  }

  async listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    // Go ignores companyID: a Cloudways token is already scoped to one account.
    const includeEnvironments = options?.includeEnvironments ?? false;
    const apps = await this.#listApps();
    return apps.map((app) => appToSite(app, includeEnvironments));
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const [, appRef] = splitRef(siteId);
    const apps = await this.#listApps();
    for (const app of apps) {
      const id = appId(app);
      // Deviation: Go also matches `app.id() == appID` when `appID` is empty,
      // so an application with no id at all matches any colon-free reference.
      // The empty case is guarded here; every non-empty case is unchanged.
      if (
        id === siteId ||
        (appRef !== "" && id === appRef) ||
        environmentId(appServerId(app), id) === siteId
      ) {
        return appToSite(app, true);
      }
    }
    throw new CliError(
      "not_found",
      `The Cloudways application "${siteId}" was not found.`,
      { details: { provider: PROVIDER, siteId } },
    );
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    const site = await this.getSite(siteId);
    return [...(site.environments ?? [])];
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "plugins": {
        const [server, app] = cloudwaysSetupTarget(request.envId);
        return cloudwaysPlugins(
          await this.#readJson(`/plugins/${server}/${app}`, []),
        );
      }
      case "capabilities":
        return CAPABILITIES.map(serializeProviderCapability);
      case "regions": {
        const regions = await this.#readJson("/regions", []);
        return regions;
      }
      case "analytics-usage": {
        if (request.siteId === "") {
          throw new CliError(
            "usage_error",
            "Cloudways requires a site for analytics usage.",
            { details: { provider: PROVIDER } },
          );
        }
        const [serverId, appRef] = splitRef(request.siteId);
        if (appRef === "") {
          const usage = await this.#readJson(
            `/server/${encodeURIComponent(serverId)}/diskUsage`,
            [],
          );
          return usage;
        }
        const query: QueryParameter[] = [
          ["server_id", serverId],
          ["app_id", appRef],
        ];
        if (request.metric !== "") query.push(["type", request.metric]);
        const summary = await this.#readJson("/app/monitor/summary", query);
        return summary;
      }
      case "analytics-env": {
        const query = envQuery(request.envId, request.query);
        if (request.metric !== "") query.push(["target", request.metric]);
        const detail = await this.#readJson("/app/monitor/detail", query);
        return detail;
      }
      // Deliberate gaps. Go answers `backups` with its own message and the rest
      // through the `default` arm; both are the same `provider_unsupported`.
      case "activity":
      case "site-domains":
      case "site-domain-verification":
      case "dns-domains":
      case "dns-records":
      case "backups":
      case "downloadable-backups":
      case "logs":
      case "redirects":
      case "denied-ips":
      case "themes":
      case "company-plugins":
      case "company-themes":
      case "file-list":
        throw unsupportedReadRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  async action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site": {
        if (request.mode === "clone") {
          const body = mapFromBody(request.body);
          const path =
            stringFromMap(body, "destination_server_id") === ""
              ? "/app/clone"
              : "/app/cloneToOtherServer";
          return this.#sendAction("sites.clone", "POST", path, body);
        }
        const action =
          request.mode === "plain" ? "sites.create-plain" : "sites.create";
        return this.#sendAction(action, "POST", "/app", request.body);
      }
      case "create-environment":
        // Go maps every mode onto the staging clone endpoint; the capability
        // list marks `envs.create-plain` unsupported rather than branching.
        return this.#sendAction(
          "envs.create",
          "POST",
          "/staging/app/cloneApp",
          request.body,
        );
      case "clear-cache":
        // Cloudways has one cache layer, so `request.cache` does not branch.
        return this.#sendAction(
          "cache.clear",
          "POST",
          "/service/varnish",
          cacheBody(request.body),
        );
      case "restart-php": {
        const service = await this.#phpFpmService(request.envId);
        const body = serviceBody(request.envId, {
          service,
          state: "restart",
        });
        return this.#sendAction("php.restart", "POST", "/service/state", body);
      }
      case "add-domain":
        return this.#sendAction(
          "domains.add",
          "POST",
          "/app/manage/aliases",
          domainBody(request.envId, request.body),
        );
      case "change-primary-domain": {
        const body = domainBody(request.envId, request.body);
        if (stringFromMap(body, "cname") === "") {
          const domain = stringFromMap(body, "domain", "primary_domain");
          if (domain !== "") body.cname = domain;
        }
        return this.#sendAction(
          "domains.primary",
          "POST",
          "/app/manage/cname",
          body,
        );
      }
      case "create-backup": {
        const body = serviceBody(request.envId, request.body);
        const path =
          stringFromMap(body, "app_id") === ""
            ? "/server/manage/backup"
            : "/app/manage/backup";
        return this.#sendAction("backups.create", "POST", path, body);
      }
      // Deliberate provider gaps.
      case "push-environment":
      case "restore-backup":
      case "set-php-version":
      case "update-plugin":
      case "bulk-update-plugins":
      case "update-theme":
      case "bulk-update-themes":
      case "run-wp-cli":
      case "set-denied-ips":
      case "apply-redirects":
        throw unsupportedActionRequest(PROVIDER, request);
      case "setup-novamira":
        return setupCloudwaysNovamira(
          this.#http,
          request.envId,
          request.signal,
        );
      default:
        return assertNever(request);
    }
  }

  async operationStatus(operationId: string): Promise<OperationStatus> {
    const { status, data } = await this.#send(
      "GET",
      `/operation/${encodeURIComponent(operationId)}`,
      [["id", operationId]],
      undefined,
    );
    const raw = redactSecretValues(data);
    const fields = operationFields(raw);
    return {
      provider: PROVIDER,
      operationId,
      status,
      done: fields.done,
      failed: fields.failed,
      ...(fields.message === undefined ? {} : { message: fields.message }),
      raw,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Authentication                                                         */
  /* ---------------------------------------------------------------------- */

  async #ensureToken(): Promise<string> {
    const cached = this.#token;
    if (cached !== undefined && Date.now() < cached.expiresAtMs) {
      return cached.value;
    }
    this.#refresh ??= this.#exchangeToken().finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }

  async #exchangeToken(): Promise<string> {
    // The one place the credential is revealed: building the bearer token that
    // becomes the Authorization header of every other request.
    const apiKey = this.#context.secret.reveal();
    const response = await this.#http.json({
      path: "/oauth/access_token",
      method: "POST",
      anonymous: true,
      secrets: [apiKey],
      // Go sends `url.Values.Encode()`, which sorts keys; kept identical here.
      body: formBody({
        api_key: apiKey,
        email: this.#email,
        grant_type: "password",
      }),
    });

    const accessToken = stringField(response, "access_token");
    if (accessToken === "") {
      throw new CliError(
        "credential_invalid",
        "The Cloudways OAuth response did not contain an access token.",
        { details: { provider: PROVIDER } },
      );
    }

    const reported = numberField(response, "expires_in");
    const lifetime =
      reported === undefined || reported <= 0
        ? DEFAULT_TOKEN_LIFETIME_SECONDS
        : Math.floor(reported);
    const margin = lifetime - TOKEN_REFRESH_MARGIN_SECONDS;
    const refreshAfter = margin <= 0 ? lifetime : margin;
    this.#token = {
      value: accessToken,
      expiresAtMs: Date.now() + refreshAfter * 1000,
    };
    return accessToken;
  }

  /* ---------------------------------------------------------------------- */
  /* Transport                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Go's `sendRaw`: append the request body to the query as sorted pairs and
   * send no HTTP body, whatever the method.
   */
  async #send(
    method: HttpMethod,
    path: string,
    query: Query,
    body: unknown,
  ): Promise<{ readonly status: number; readonly data: unknown }> {
    const response = await this.#http.request({
      path,
      method,
      query: [...query, ...bodyQuery(body)],
    });
    return { status: response.status, data: response.data };
  }

  async #readJson(path: string, query: Query): Promise<unknown> {
    const { data } = await this.#send("GET", path, query, undefined);
    return data;
  }

  async #sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body: unknown,
  ): Promise<ActionResult> {
    const { status, data } = await this.#send(method, path, [], body);
    const raw = redactSecretValues(data);
    const message = messageField(raw);
    const operationId = operationIdField(raw);
    return {
      provider: PROVIDER,
      action,
      // Go reports the HTTP status here, unlike Kinsta's `buildActionResult`,
      // which prefers a `status` field from the body.
      status,
      ...(message === undefined ? {} : { message }),
      ...(operationId === undefined ? {} : { operationId }),
      raw,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Inventory                                                              */
  /* ---------------------------------------------------------------------- */

  async #listApps(): Promise<Record<string, unknown>[]> {
    const data = await this.#readJson("/server", []);
    const apps: Record<string, unknown>[] = [];
    for (const server of serversFrom(data)) {
      const rawApps = server.apps;
      if (!Array.isArray(rawApps)) continue;
      for (const app of rawApps) {
        if (!isJsonObject(app)) continue;
        const merged: Record<string, unknown> = { ...app };
        if (flexString(merged.server_id) === "") {
          merged.server_id = flexString(server.id);
        }
        if (stringOf(merged.status) === "") {
          merged.status = stringOf(server.status);
        }
        apps.push(merged);
      }
    }
    return apps;
  }

  /**
   * Cloudways names the PHP-FPM service after its version (`php8.2-fpm`), so the
   * restart action has to discover it. Highest name in sort order wins, and a
   * service reported as `unknown` is not installed.
   */
  async #phpFpmService(envId: string): Promise<string> {
    const data = await this.#readJson("/service", envQuery(envId));
    const services = isJsonObject(data) ? data.services : undefined;
    const status = isJsonObject(services) ? services.status : undefined;
    const names = isJsonObject(status)
      ? Object.keys(status).filter(
          (name) =>
            name.startsWith("php") &&
            name.endsWith("-fpm") &&
            // Go compares `fmt.Sprint(state) != "unknown"`; only the JSON string
            // "unknown" can render as that.
            status[name] !== "unknown",
        )
      : [];
    const service = names.sort().at(-1);
    if (service === undefined) {
      throw new CliError(
        "not_found",
        `The Cloudways PHP-FPM service was not found for environment "${envId}".`,
        { details: { provider: PROVIDER, envId } },
      );
    }
    return service;
  }
}

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

/** Go's `cloudwaysBodyQuery`: sorted pairs, empty key dropped. */
function bodyQuery(body: unknown): QueryParameter[] {
  if (body === undefined || body === null) return [];
  const map = mapFromBody(body);
  return Object.keys(map)
    .sort()
    .filter((key) => key !== "")
    .map((key) => [key, queryValue(map[key])] as const);
}

/**
 * Go's `cloudwaysQueryValue`.
 *
 * Deviation: percent-encoding is `URLSearchParams`', not Go's `url.QueryEscape`.
 * The two agree on every character that appears in a Cloudways field except
 * `~` (Go leaves it literal, HQ escapes it) and `*` (the reverse). Both forms
 * decode to the same bytes.
 */
function queryValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return numberText(value);
  return jsonText(value);
}

/**
 * `JSON.stringify` is declared to return `string` but yields `undefined` for a
 * function or a symbol, neither of which Go could have produced; an empty
 * parameter is the closest match.
 */
function jsonText(value: unknown): string {
  const encoded: unknown = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

/** Go renders an integral float as an integer and everything else verbatim. */
function numberText(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return BigInt(value).toString();
  }
  return String(value);
}

/**
 * Go's `mapFromBody`. Deviation: the returned map is always a copy, so the
 * body-shaping helpers below never mutate the caller's object the way the Go
 * original does for a `map[string]any` argument.
 */
function mapFromBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (isJsonObject(body)) return { ...body };
  let decoded: unknown;
  try {
    const encoded = jsonText(body);
    decoded = encoded === "" ? undefined : (JSON.parse(encoded) as unknown);
  } catch {
    decoded = undefined;
  }
  if (!isJsonObject(decoded)) {
    throw new CliError(
      "usage_error",
      "The Cloudways request body must be a JSON object.",
      { details: { provider: PROVIDER } },
    );
  }
  return { ...decoded };
}

/** Go's `stringFromMap`: first key present as a string or a number. */
function stringFromMap(
  map: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string {
  for (const key of keys) {
    if (!Object.hasOwn(map, key)) continue;
    const value = map[key];
    if (typeof value === "string") return value;
    // Go formats a JSON number as int64, truncating toward zero.
    if (typeof value === "number") return numberText(Math.trunc(value));
  }
  return "";
}

/** Go's `cloudwaysSplitRef`: split on the first colon only. */
function splitRef(reference: string): [string, string] {
  const index = reference.indexOf(":");
  return index === -1
    ? [reference, ""]
    : [reference.slice(0, index), reference.slice(index + 1)];
}

function environmentId(serverId: string, applicationId: string): string {
  return serverId === "" ? applicationId : `${serverId}:${applicationId}`;
}

/** Go's `cloudwaysEnvQuery`: both halves of `server_id:app_id` are required. */
function envQuery(envId: string, extra?: Query): QueryParameter[] {
  const [serverId, appRef] = splitRef(envId);
  if (serverId === "" || appRef === "") {
    throw new CliError(
      "usage_error",
      "Cloudways requires the environment id in server_id:app_id form.",
      { details: { provider: PROVIDER, envId } },
    );
  }
  return [["server_id", serverId], ["app_id", appRef], ...(extra ?? [])];
}

/** Go's `cloudwaysServiceBody`: merge the env reference into the body map. */
function serviceBody(envId: string, body: unknown): Record<string, unknown> {
  const map = mapFromBody(body);
  let [serverId, appRef] = splitRef(envId);
  if (serverId === "") serverId = stringFromMap(map, "server_id");
  if (appRef === "") appRef = stringFromMap(map, "app_id", "appId");
  if (serverId === "") {
    throw new CliError(
      "usage_error",
      "Cloudways requires server_id, either as --env server_id:app_id or as a server_id body field.",
      { details: { provider: PROVIDER, envId } },
    );
  }
  map.server_id = serverId;
  if (appRef !== "") map.app_id = appRef;
  return map;
}

/** Go's `cloudwaysCacheBody`: the env reference travels inside the body. */
function cacheBody(body: unknown): Record<string, unknown> {
  const map = mapFromBody(body);
  const merged = serviceBody(
    stringFromMap(map, "environment_id", "env_id"),
    map,
  );
  if (stringFromMap(merged, "action") === "") merged.action = "purge";
  return merged;
}

/** Go's `cloudwaysDomainBody`: Cloudways replaces the whole alias list. */
function domainBody(envId: string, body: unknown): Record<string, unknown> {
  const merged = serviceBody(envId, body);
  if (stringFromMap(merged, "aliases") === "") {
    const domain = stringFromMap(merged, "domain", "domains");
    if (domain !== "") merged.aliases = domain;
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Response shaping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Go's `redactCloudwaysSecrets`. Cloudways returns app, database and SSH
 * passwords inline in operation and credential payloads, so every value under a
 * secret-looking key is replaced before the payload leaves this module.
 * Deviation: a new structure is built instead of mutating in place.
 */
function redactSecretValues(value: unknown): unknown {
  let safe: unknown;
  if (Array.isArray(value)) safe = value.map(redactSecretValues);
  else if (isJsonObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? "redacted" : redactSecretValues(child);
    }
    safe = result;
  } else safe = value;
  registerSensitiveValues(safe, registeredSensitiveValues(value));
  return safe;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("private_key")
  );
}

/** Go's `cloudwaysMessageField`. */
function messageField(raw: unknown): string | undefined {
  for (const key of ["message", "msg", "status"]) {
    const value = stringField(raw, key);
    if (value !== "") return value;
  }
  return undefined;
}

/** Go's `cloudwaysOperationID`, including its nested and list fallbacks. */
function operationIdField(raw: unknown): string | undefined {
  if (!isJsonObject(raw)) return undefined;
  for (const key of ["operation_id", "id"]) {
    const value = stringField(raw, key);
    if (value !== "") return value;
  }
  for (const key of ["operation", "server"]) {
    const nested = raw[key];
    if (!isJsonObject(nested)) continue;
    for (const nestedKey of ["operation_id", "id"]) {
      const value = nested[nestedKey];
      if (typeof value === "string" && value !== "") return value;
      if (typeof value === "number") return numberText(value);
    }
    const operations = nested.operations;
    if (!Array.isArray(operations)) continue;
    const first: unknown = operations[0];
    if (!isJsonObject(first)) continue;
    const id = flexString(first.id);
    if (id !== "") return id;
  }
  return undefined;
}

interface OperationFields {
  readonly done: boolean;
  readonly failed: boolean;
  readonly message: string | undefined;
}

/**
 * Go's `cloudwaysOperationFields`. Go ignores the unmarshal error and keeps
 * whatever decoded, so each field is read defensively rather than as a unit —
 * a Cloudways payload with a boolean top-level `status` must not blank out the
 * nested operation fields.
 */
function operationFields(raw: unknown): OperationFields {
  const root = isJsonObject(raw) ? raw : {};
  const operation = isJsonObject(root.operation) ? root.operation : {};

  let status = stringOf(operation.status).toLowerCase();
  if (status === "") status = stringOf(root.status).toLowerCase();

  const done =
    intBool(operation.is_completed) ||
    ["completed", "done", "success", "failed", "error"].includes(status);
  const failed =
    intBool(operation.is_failed) || status === "failed" || status === "error";

  let message = stringOf(operation.message);
  if (message === "") message = stringOf(root.message);

  return { done, failed, message: message === "" ? undefined : message };
}

/** Go's `intBool`: `1`/`"1"`/`"yes"`/`true` and friends all mean true. */
function intBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  switch (value.trim().toLowerCase()) {
    case "":
    case "false":
    case "0":
    case "no":
      return false;
    case "true":
    case "1":
    case "yes":
      return true;
    default: {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? false : parsed !== 0;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Site normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Go's `cloudwaysServersResponse.UnmarshalJSON`: a bare array, `{"servers":[…]}`
 * and `{"data":{"servers":[…]}}` are all accepted.
 */
function serversFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isJsonObject);
  if (!isJsonObject(data)) return [];
  const direct = Array.isArray(data.servers)
    ? data.servers.filter(isJsonObject)
    : [];
  if (direct.length > 0) return direct;
  const nested = isJsonObject(data.data) ? data.data.servers : undefined;
  return Array.isArray(nested) ? nested.filter(isJsonObject) : direct;
}

function appId(app: Readonly<Record<string, unknown>>): string {
  return firstNonEmpty(
    flexString(app.id),
    flexString(app.app_id),
    flexString(app.application_id),
  );
}

function appServerId(app: Readonly<Record<string, unknown>>): string {
  return flexString(app.server_id);
}

function appPrimaryDomain(app: Readonly<Record<string, unknown>>): string {
  return firstNonEmpty(
    stringOf(app.primary_domain),
    stringOf(app.cname),
    stringOf(app.c_name),
    stringOf(app.url),
    stringOf(app.fqdn),
    stringOf(app.app_fqdn),
  );
}

/** Only reported when the application is a WordPress install (Go's guard). */
function appWordpressVersion(app: Readonly<Record<string, unknown>>): string {
  const version = firstNonEmpty(
    stringOf(app.wordpress_version),
    stringOf(app.app_version),
  );
  if (version === "") return "";
  const kind = firstNonEmpty(
    stringOf(app.application),
    stringOf(app.installed_app),
  ).toLowerCase();
  return kind.includes("wordpress") ? version : "";
}

function appToSite(
  app: Readonly<Record<string, unknown>>,
  includeEnvironments: boolean,
): HostingSite {
  const id = appId(app);
  const label = stringOf(app.label);
  const appLabel = stringOf(app.app_label);
  const rawName = stringOf(app.name);
  const application = stringOf(app.application);
  const status = firstNonEmpty(stringOf(app.status), "active");
  const primaryDomain = appPrimaryDomain(app);

  const site: HostingSite = {
    id,
    name: firstNonEmpty(rawName, appLabel, label, application, id),
    displayName: firstNonEmpty(label, appLabel, rawName, application, id),
    status,
    ...(primaryDomain === "" ? {} : { primaryDomain }),
  };
  if (!includeEnvironments) return site;

  const wordpressVersion = appWordpressVersion(app);
  const environment: HostingEnvironment = {
    id: environmentId(appServerId(app), id),
    name: firstNonEmpty(application, "live"),
    displayName: application === "" ? "Live" : application,
    isBlocked: isBlockedStatus(status),
    isPremium: false,
    ...(wordpressVersion === "" ? {} : { wordpressVersion }),
    ...(primaryDomain === "" ? {} : { primaryDomain }),
  };
  return { ...site, environments: [environment] };
}

function isBlockedStatus(status: string): boolean {
  switch (status.toLowerCase()) {
    case "":
    case "active":
    case "running":
    case "enabled":
    case "live":
      return false;
    default:
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* JSON helpers                                                               */
/* -------------------------------------------------------------------------- */

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Go decodes a mistyped `string` field as `""` and carries on; so does this. */
function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Go's `flexString`: a JSON string or number, anything else empty. */
function flexString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return numberText(value);
  }
  return "";
}

/** Go's `jsonStringField`: the named field, only when it is a JSON string. */
function stringField(source: unknown, key: string): string {
  return isJsonObject(source) ? stringOf(source[key]) : "";
}

function numberField(source: unknown, key: string): number | undefined {
  if (!isJsonObject(source)) return undefined;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstNonEmpty(...values: readonly string[]): string {
  for (const value of values) {
    if (value !== "") return value;
  }
  return "";
}

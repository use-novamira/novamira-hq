// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Pressable provider client, ported from `internal/providers/pressable.go`.
 *
 * Pressable authenticates with an OAuth2 `client_credentials` exchange: the
 * profile's credential is the `client_secret` and the non-secret `client_id`
 * comes from the profile's `companyId` or `PRESSABLE_CLIENT_ID`, both already
 * resolved by the factory into `context.identity`. The short-lived bearer token
 * is cached in the closure and refreshed 60 seconds before it expires, which is
 * why the client installs a `dynamicAuth` provider rather than `bearerAuth`.
 *
 * Pressable models a site as a single unit: there is no environment resource,
 * and a staging site is a separate top-level site. Both `listSites` and
 * `getSite` therefore synthesize exactly one environment per site, sharing the
 * site's id — the Go behaviour, and the reason `envId` and `siteId` are used
 * interchangeably when building request paths below.
 */

import { CliError } from "../../errors.js";
import {
  redactAssociatedText,
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../../output/redact.js";
import { DEFAULT_PRESSABLE_CLIENT_ID_ENV } from "../../config/schema.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadLogsRequest,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedReadRequest,
  wpCliWithoutBinary,
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
  jsonBody,
} from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderCapabilityInput,
  type ProviderValidation,
  type Query,
  providerCapabilities,
  serializeProviderCapability,
} from "../types.js";

const PROVIDER = "pressable" as const;

/** Pressable's `/sites` page size, matching the Go client's fixed `per_page`. */
const SITES_PAGE_SIZE = 50;

/** Path of the OAuth2 token endpoint, relative to the API origin. */
const DEFAULT_TOKEN_PATH = "/auth/token";

/** Assumed token lifetime when the response omits or zeroes `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** Refresh this long before the reported expiry (Go's 60-second margin). */
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

/** Pressable's maximum activity page size. */
const ACTIVITY_MAX_PAGE_SIZE = 50;

const ACTIVITY_DEFAULT_PAGE_SIZE = 10;

const NOTE_NOT_MAPPED = "not mapped for Pressable in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by Pressable's provider-neutral Novamira mapping";

/** Ported verbatim, and in order, from `PressableClient.capabilities`. */
const PRESSABLE_CAPABILITIES: readonly ProviderCapabilityInput[] = [
  "providers.validate",
  "providers.capabilities",
  "sites.list",
  "sites.get",
  ["envs.list", false, NOTE_NOT_MAPPED],
  ["envs.get", false, NOTE_NOT_MAPPED],
  ["ops.get", false, NOTE_NOT_MAPPED],
  ["ops.wait", false, NOTE_NOT_MAPPED],
  ["regions.list", true, "uses the Pressable datacenters endpoint"],
  ["activity.list", true, "uses the Pressable activity logs endpoint"],
  ["sites.create", true, "uses POST /sites"],
  ["sites.create-plain", true, "uses POST /sites"],
  ["sites.clone", false, NOTE_UNSUPPORTED],
  ["sites.delete", true, "uses DELETE /sites/{site_id}"],
  ["sites.reset", false, NOTE_UNSUPPORTED],
  ["envs.create", false, NOTE_NOT_MAPPED],
  ["envs.create-plain", false, NOTE_NOT_MAPPED],
  ["envs.clone", false, NOTE_NOT_MAPPED],
  ["envs.push", false, NOTE_NOT_MAPPED],
  ["envs.delete", false, NOTE_NOT_MAPPED],
  ["domains.list", true, "uses GET /sites/{site_id}/domains"],
  ["dns.domains.list", true, "uses GET /dns/zones"],
  ["backups.list", true, "uses GET /sites/{site_id}/backups"],
  ["cache.clear", true, "uses DELETE /sites/{id}/object-cache"],
  ["php.restart", false, NOTE_UNSUPPORTED],
  ["php.set-version", false, NOTE_NOT_MAPPED],
  ["wp.plugins.list", true, "uses GET /sites/{site_id}/plugins"],
  ["wp.plugins.install", true, "uses POST /sites/{id}/wordpress/wpcli"],
  ["wp.themes.list", false, NOTE_NOT_MAPPED],
  ["wp-cli.run", true, "uses POST /sites/{id}/wordpress/wpcli"],
  ["logs.get", true, "uses GET /sites/{site_id}/php-logs or /webserver-logs"],
  ["analytics.usage", true, "uses GET /sites/{site_id}/statistics"],
  ["analytics.env", false, NOTE_NOT_MAPPED],
  ["access.ssh", false, NOTE_NOT_MAPPED],
  ["access.sftp", true, "uses GET /sites/{site_id}/ftp"],
];

interface CachedToken {
  readonly value: string;
  /** Epoch milliseconds after which the token must be exchanged again. */
  readonly expiresAt: number;
}

interface ActivityRequest {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Construct a Pressable client. The `client_secret` is revealed only while
 * building the token-exchange body; nothing else in this module reads it.
 */
export const createPressableClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  const clientId = (context.identity ?? "").trim();
  if (clientId === "") {
    throw new CliError(
      "credential_missing",
      `Pressable requires a client id; set the profile's companyId or ${DEFAULT_PRESSABLE_CLIENT_ID_ENV}.`,
      { details: { provider: PROVIDER, env: DEFAULT_PRESSABLE_CLIENT_ID_ENV } },
    );
  }
  if (context.secret.length === 0) {
    throw new CliError(
      "credential_missing",
      "Pressable requires a client secret.",
      { details: { provider: PROVIDER, credential: context.credentialSource } },
    );
  }

  const tokenUrl = resolveTokenUrl(context);
  let cached: CachedToken | undefined;
  let inFlight: Promise<string> | undefined;

  const http: HttpClient = context.createHttpClient({
    auth: dynamicAuth(async () => {
      const token = await accessToken();
      return {
        headers: { authorization: `Bearer ${token}` },
        secrets: [token],
      };
    }),
  });

  async function accessToken(): Promise<string> {
    const current = cached;
    if (current !== undefined && Date.now() < current.expiresAt) {
      return current.value;
    }
    // Go serializes the exchange behind a mutex; a shared in-flight promise is
    // the single-threaded equivalent, so concurrent calls exchange once.
    inFlight ??= exchangeToken().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function exchangeToken(): Promise<string> {
    const secret = context.secret.reveal();
    const response = await http.request({
      path: tokenUrl,
      method: "POST",
      anonymous: true,
      secrets: [secret],
      body: formBody({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }),
    });
    const payload = asObject(response.data);
    const token = stringField(payload, "access_token");
    if (token === undefined || token === "") {
      throw new CliError(
        "provider_error",
        "The Pressable token response did not contain an access_token.",
        { details: { provider: PROVIDER, status: response.status } },
      );
    }
    const reported = numberField(payload, "expires_in");
    const lifetime =
      reported === undefined || reported <= 0
        ? DEFAULT_TOKEN_LIFETIME_SECONDS
        : reported;
    cached = {
      value: token,
      expiresAt: Date.now() + (lifetime - TOKEN_REFRESH_MARGIN_SECONDS) * 1000,
    };
    return token;
  }

  /* ---------------------------------------------------------------------- */
  /* Requests                                                               */
  /* ---------------------------------------------------------------------- */

  async function readJson(path: string): Promise<unknown> {
    return http.json({ path });
  }

  async function postJson(path: string, body: unknown): Promise<unknown> {
    return http.json({ path, method: "POST", body: jsonBody(body) });
  }

  /** Fetch an envelope and enforce Go's `message == "Success"` check. */
  async function getEnvelope(
    path: string,
    query?: Query,
  ): Promise<Readonly<Record<string, unknown>>> {
    const data = await http.json({
      path,
      ...(query === undefined ? {} : { query }),
    });
    const envelope = asObject(data);
    const message = stringField(envelope, "message") ?? "";
    if (message !== "Success") {
      const safeMessage = redactAssociatedText(message, data);
      const error = new CliError(
        "provider_error",
        `The Pressable API request to ${path} failed: ${safeMessage}`,
        { details: { provider: PROVIDER, path, message: safeMessage } },
      );
      registerSensitiveValues(error, registeredSensitiveValues(data));
      throw error;
    }
    return envelope;
  }

  async function sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<ActionResult> {
    // Go parses the response body before checking the status and reports a
    // decode failure first; the shared HTTP client raises the status failure
    // itself, with the provider's message already extracted and redacted.
    const response = await http.request({
      path,
      method,
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    });
    const raw = response.data ?? null;
    const message = stringField(asObject(raw), "message");
    return {
      provider: PROVIDER,
      action,
      status: response.status,
      ...(message === undefined ? {} : { message }),
      raw,
    };
  }

  /**
   * Pressable deletes one domain per request. A single id keeps that response
   * verbatim; several are aggregated into one envelope-shaped result.
   */
  async function deleteDomains(
    envId: string,
    body: unknown,
  ): Promise<ActionResult> {
    const domainIds = domainIdsFromBody(body);
    const first = domainIds[0];
    if (domainIds.length === 1 && first !== undefined) {
      return sendAction(
        "domains.delete",
        "DELETE",
        `/sites/${escapePath(envId)}/domains/${escapePath(first)}`,
      );
    }
    const results: unknown[] = [];
    for (const domainId of domainIds) {
      const result = await sendAction(
        "domains.delete",
        "DELETE",
        `/sites/${escapePath(envId)}/domains/${escapePath(domainId)}`,
      );
      results.push(result.raw);
    }
    return {
      provider: PROVIDER,
      action: "domains.delete",
      status: 200,
      message: "Success",
      raw: { message: "Success", data: results, errors: null },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* ProviderClient                                                         */
  /* ---------------------------------------------------------------------- */

  async function validate(): Promise<ProviderValidation> {
    const data = await http.json({ path: "/account" });
    const envelope = asObject(data);
    const message = stringField(envelope, "message") ?? "";
    if (message !== "Success") {
      const safeMessage = redactAssociatedText(message, data);
      const error = new CliError(
        "provider_error",
        `Pressable API validation failed: ${safeMessage}`,
        { details: { provider: PROVIDER, message: safeMessage } },
      );
      registerSensitiveValues(error, registeredSensitiveValues(data));
      throw error;
    }
    return {
      provider: PROVIDER,
      status: "active",
      companyId: stringField(asObject(envelope.data), "email") ?? "",
      credential: context.credentialSource,
    };
  }

  async function listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const includeEnvironments = options?.includeEnvironments ?? false;
    const sites: HostingSite[] = [];
    let page = 1;
    for (;;) {
      const envelope = await getEnvelope("/sites", [
        ["page", String(page)],
        ["per_page", String(SITES_PAGE_SIZE)],
      ]);
      const data = envelope.data;
      if (Array.isArray(data)) {
        for (const entry of data) {
          sites.push(toHostingSite(asObject(entry), includeEnvironments));
        }
      }
      const pageInfo = envelope.page;
      if (typeof pageInfo !== "object" || pageInfo === null) break;
      const info = pageInfo as Record<string, unknown>;
      const currentPage = integerField(info, "currentPage") ?? 0;
      const lastPage = integerField(info, "lastPage") ?? 0;
      if (currentPage >= lastPage) break;
      const nextPage = integerField(info, "nextPage") ?? 0;
      // Go only stops on `nextPage == 0`; requiring forward progress as well
      // keeps a malformed cursor from looping this client forever.
      if (nextPage <= page) break;
      page = nextPage;
    }
    return sites;
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    // An empty id would address `/sites/` — the *list* endpoint, whose `data` is
    // an array. `asObject` would flatten that to `{}` and `toHostingSite` would
    // hand back a site with id `0` and one synthetic `live` environment: a
    // fabricated answer to a question Pressable was never asked. Go escaped this
    // only by accident, failing to unmarshal the array; refuse it outright.
    if (siteId === "") {
      throw new CliError(
        "usage_error",
        "A site id is required to address a Pressable site.",
        { details: { provider: PROVIDER } },
      );
    }
    const path = `/sites/${escapePath(siteId)}`;
    const envelope = await getEnvelope(path);
    return toHostingSite(asObject(envelope.data), true);
  }

  async function listEnvironments(
    siteId: string,
  ): Promise<HostingEnvironment[]> {
    const site = await getSite(siteId);
    return [...(site.environments ?? [])];
  }

  async function read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return providerCapabilities(PRESSABLE_CAPABILITIES).map(
          serializeProviderCapability,
        );
      case "regions":
        return readJson("/sites/datacenters");
      case "site-domains":
        return readJson(`/sites/${escapePath(request.envId)}/domains`);
      case "backups":
        return readJson(`/sites/${escapePath(request.envId)}/backups`);
      case "plugins":
        return readJson(`/sites/${escapePath(request.envId)}/plugins`);
      case "logs":
        // Pressable's log endpoints take no line count, so `lines` is ignored
        // exactly as it is in the Go client.
        return readJson(logPath(request));
      case "analytics-usage":
        return readJson(`/sites/${escapePath(request.siteId)}/statistics`);
      case "sftp-accounts":
        return readJson(`/sites/${escapePath(request.envId)}/ftp`);
      case "dns-domains":
        return readJson("/dns/zones");
      case "activity": {
        const activity = activityRequest(request.query ?? []);
        return postJson(activity.path, activity.body);
      }
      case "site-domain-verification":
      case "dns-records":
      case "downloadable-backups":
      case "redirects":
      case "denied-ips":
      case "themes":
      case "company-plugins":
      case "company-themes":
      case "ssh-status":
      case "ssh-allowlist":
      case "ssh-config":
      case "ssh-password":
      case "analytics-env":
      case "file-list":
        throw unsupportedReadRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  async function action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site":
        // Every create mode maps to POST /sites; Pressable has no clone or
        // plain-site variant, and the Go client ignores the mode as well.
        return sendAction("sites.create", "POST", "/sites", request.body);
      case "delete-site":
        return sendAction(
          "sites.delete",
          "DELETE",
          `/sites/${escapePath(request.siteId)}`,
        );
      case "clear-cache": {
        const siteId = extractSiteId(request.body);
        if (siteId === "") {
          throw new CliError(
            "usage_error",
            "Pressable requires a site id in the body for cache.clear.",
            { details: { provider: PROVIDER, action: request.kind } },
          );
        }
        return sendAction(
          "cache.clear",
          "DELETE",
          `/sites/${escapePath(siteId)}/object-cache`,
        );
      }
      case "add-domain":
        return sendAction(
          "domains.add",
          "POST",
          `/sites/${escapePath(request.envId)}/domains`,
          request.body,
        );
      case "delete-domains":
        return deleteDomains(request.envId, request.body);
      case "run-wp-cli":
        return sendAction(
          "wp-cli.run",
          "POST",
          `/sites/${escapePath(request.envId)}/wordpress/wpcli`,
          wpCliBody(request.body),
        );
      case "reset-site":
      case "create-environment":
      case "push-environment":
      case "delete-environment":
      case "restart-php":
      case "set-php-version":
      case "change-primary-domain":
      case "create-backup":
      case "restore-backup":
      case "delete-backup":
      case "update-plugin":
      case "bulk-update-plugins":
      case "update-theme":
      case "bulk-update-themes":
      case "set-denied-ips":
      case "apply-redirects":
      case "dns-record-create":
      case "dns-record-update":
      case "dns-record-delete":
      case "set-ssh-status":
      case "set-ssh-password-status":
      case "generate-ssh-password":
      case "set-ssh-allowlist":
      case "change-ssh-password-expiration":
      case "toggle-sftp-accounts":
      case "add-sftp-account":
      case "remove-sftp-account":
        throw unsupportedActionRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  /**
   * Pressable has no generic operation endpoint: job status comes back inline
   * with the action, so every operation reports as completed.
   */
  async function operationStatus(
    operationId: string,
  ): Promise<OperationStatus> {
    return Promise.resolve({
      provider: PROVIDER,
      operationId,
      status: 200,
      done: true,
      failed: false,
      message: "Pressable does not support async operation status polling",
      raw: null,
    });
  }

  return {
    provider: PROVIDER,
    validate,
    listSites,
    getSite,
    listEnvironments,
    read,
    action,
    operationStatus,
    // Pressable's WP-CLI endpoint only queues a job id, never command output.
    wpCliResultsObservable: () => false,
  };
};

/* -------------------------------------------------------------------------- */
/* Token URL                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the OAuth2 token endpoint against the profile's API origin.
 *
 * Go stores the token URL as an independent absolute constant. HQ's HTTP client
 * refuses to leave the configured API origin, and `PROVIDER_DEFAULTS` always
 * carries the production token URL even for a profile with a custom
 * `apiBaseUrl`, so the configured URL contributes only its path: pointing the
 * profile at a mock or a proxy moves the token exchange with it.
 */
function resolveTokenUrl(context: ProviderClientContext): string {
  const origin = new URL(context.baseUrl).origin;
  const configured = (context.tokenUrl ?? "").trim();
  if (configured === "") return `${origin}${DEFAULT_TOKEN_PATH}`;
  if (!URL.canParse(configured)) {
    return `${origin}${configured.startsWith("/") ? "" : "/"}${configured}`;
  }
  const parsed = new URL(configured);
  return `${origin}${parsed.pathname}${parsed.search}`;
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function toHostingSite(
  site: Readonly<Record<string, unknown>>,
  includeEnvironment: boolean,
): HostingSite {
  const id = siteIdentifier(site.id);
  const name = stringField(site, "name") ?? "";
  const displayName = stringField(site, "displayName") ?? "";
  const label = displayName === "" ? name : displayName;
  const state = stringField(site, "state") ?? "";
  const primaryDomain = firstNonEmpty(stringField(site, "url"), name);
  const base: HostingSite = {
    id,
    name,
    displayName: label,
    status: stateToStatus(state),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
  };
  if (!includeEnvironment) return base;
  const environment: HostingEnvironment = {
    id,
    name: environmentName(
      booleanField(site, "staging"),
      booleanField(site, "sandbox"),
    ),
    displayName: label,
    isBlocked: state === "disabled",
    isPremium: booleanField(site, "ecommerce"),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
  };
  return { ...base, environments: [environment] };
}

/**
 * Pressable reports the site id as a JSON number. Go decodes it into an `int64`
 * and formats it back; JavaScript numbers are exact for every id Pressable
 * issues, and a string id (which Go would reject outright) is kept verbatim.
 */
function siteIdentifier(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "0";
}

function stateToStatus(state: string): string {
  switch (state.toLowerCase()) {
    case "live":
    case "active":
      return "active";
    case "disabled":
    case "suspended":
      return "suspended";
    case "deleted":
      return "deleted";
    default:
      return state === "" ? "unknown" : state.toLowerCase();
  }
}

function environmentName(staging: boolean, sandbox: boolean): string {
  if (staging) return "staging";
  if (sandbox) return "sandbox";
  return "live";
}

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

function logPath(request: ReadLogsRequest): string {
  switch (request.fileName) {
    case "error":
      return `/sites/${escapePath(request.envId)}/logs/php`;
    case "access":
      return `/sites/${escapePath(request.envId)}/logs/webserver`;
    default:
      throw new CliError(
        "usage_error",
        'Pressable supports only the "error" and "access" log files.',
        {
          details: {
            provider: PROVIDER,
            fileName: request.fileName,
            supported: ["error", "access"],
          },
        },
      );
  }
}

/**
 * Translate the neutral activity query into Pressable's POST body. The order of
 * the query pairs is significant: `offset` is converted to a page number using
 * the page size seen so far, exactly as the Go loop does.
 */
function activityRequest(query: Query): ActivityRequest {
  const body: Record<string, unknown> = {
    page: 1,
    per_page: ACTIVITY_DEFAULT_PAGE_SIZE,
  };
  const filters: Record<string, unknown>[] = [];
  let siteId = "";

  for (const [key, value] of query) {
    if (value === "") continue;
    switch (key) {
      case "limit": {
        const limit = parseIntegerStrict(value);
        if (limit === undefined || limit < 1) {
          throw new CliError(
            "usage_error",
            `Invalid Pressable activity limit "${value}".`,
            { details: { provider: PROVIDER, limit: value } },
          );
        }
        body.per_page = Math.min(limit, ACTIVITY_MAX_PAGE_SIZE);
        break;
      }
      case "offset": {
        const offset = parseIntegerStrict(value);
        if (offset === undefined || offset < 0) {
          throw new CliError(
            "usage_error",
            `Invalid Pressable activity offset "${value}".`,
            { details: { provider: PROVIDER, offset: value } },
          );
        }
        const current = body.per_page;
        const size =
          typeof current === "number" && current >= 1
            ? current
            : ACTIVITY_DEFAULT_PAGE_SIZE;
        body.page = Math.floor(offset / size) + 1;
        break;
      }
      case "site_id":
        siteId = value;
        break;
      case "category":
        filters.push({ field: "action", operator: "contains", value });
        break;
      case "id_initiated_by":
        filters.push({ field: "account_email", operator: "equals", value });
        break;
      default:
        throw new CliError(
          "provider_unsupported",
          `Pressable does not support the "${key}" activity filter.`,
          { details: { provider: PROVIDER, filter: key } },
        );
    }
  }

  if (filters.length > 0) body.filters = filters;
  return {
    path:
      siteId === ""
        ? "/account/logs/activity"
        : `/sites/${escapePath(siteId)}/logs/activity`,
    body,
  };
}

function domainIdsFromBody(body: unknown): string[] {
  const missing = new CliError(
    "usage_error",
    "Pressable requires domain_id, id, or domain_ids for domains.delete.",
    { details: { provider: PROVIDER, action: "delete-domains" } },
  );
  if (body === undefined || body === null) throw missing;
  const object = objectBody(body);
  if ("domain_ids" in object) return domainIdList(object.domain_ids);
  if ("domain_id" in object) return [singleDomainId(object.domain_id)];
  if ("id" in object) return [singleDomainId(object.id)];
  throw missing;
}

function domainIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new CliError(
      "usage_error",
      "Pressable requires domain_ids to be an array.",
      { details: { provider: PROVIDER, action: "delete-domains" } },
    );
  }
  if (value.length === 0) {
    throw new CliError(
      "usage_error",
      "Pressable requires at least one domain id.",
      { details: { provider: PROVIDER, action: "delete-domains" } },
    );
  }
  return value.map((entry) => singleDomainId(entry));
}

/**
 * Go renders any value with `%v` and rejects only `""` and `"<nil>"`, which lets
 * a nested object through as its Go-syntax rendering. HQ accepts a string or a
 * finite number and rejects everything else as a usage error.
 */
function singleDomainId(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  if (rendered === "") {
    throw new CliError(
      "usage_error",
      "Pressable requires a non-empty domain id.",
      { details: { provider: PROVIDER, action: "delete-domains" } },
    );
  }
  return rendered;
}

/** The site id a cache-clear body carries, under any of the accepted names. */
function extractSiteId(body: unknown): string {
  if (body === undefined || body === null) return "";
  let object: Readonly<Record<string, unknown>>;
  try {
    object = objectBody(body);
  } catch {
    return "";
  }
  for (const key of ["site_id", "siteId", "id", "environment_id", "envId"]) {
    if (!(key in object)) continue;
    const value = object[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return "";
  }
  return "";
}

function wpCliBody(body: unknown): Readonly<Record<string, unknown>> {
  const object = objectBody(body);
  if ("wp_command" in object) {
    const command = object.wp_command;
    // Novamira-neutral format: {"wp_command": "wp plugin list"}.
    return {
      commands: [
        wpCliWithoutBinary(typeof command === "string" ? command : ""),
      ],
    };
  }
  // Already Pressable-native: {"commands": [...]}.
  if ("commands" in object) return object;
  throw new CliError(
    "usage_error",
    "Pressable requires wp_command or a commands array for wp-cli.run.",
    { details: { provider: PROVIDER, action: "run-wp-cli" } },
  );
}

/* -------------------------------------------------------------------------- */
/* Value helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Go's `objectBody`: a JSON object, an empty object for nil, else an error. */
function objectBody(body: unknown): Readonly<Record<string, unknown>> {
  if (body === undefined || body === null) return {};
  if (typeof body === "object" && !Array.isArray(body)) {
    return body as Readonly<Record<string, unknown>>;
  }
  throw new CliError("usage_error", "The request body must be a JSON object.", {
    details: { provider: PROVIDER },
  });
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function integerField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = numberField(object, key);
  return value === undefined ? undefined : Math.trunc(value);
}

function booleanField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return object[key] === true;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** Go's `strconv.Atoi`: an optionally signed run of digits, nothing else. */
function parseIntegerStrict(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Go escapes path segments with `url.PathEscape`. `encodeURIComponent` escapes a
 * strict superset (it also percent-encodes `$&+,;:=@`), which every provider API
 * decodes identically, and it never lets an id break out of its segment.
 */
function escapePath(value: string): string {
  return encodeURIComponent(value);
}

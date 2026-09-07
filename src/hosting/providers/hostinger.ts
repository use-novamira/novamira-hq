// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Hostinger provider client, ported from
 * `internal/providers/hostinger.go`.
 *
 * Hostinger's public API is account-shaped rather than site-shaped: a "website"
 * is a vhost on a hosting account, there is no environment concept, and there is
 * no operation-status endpoint. The Go client therefore synthesizes one `live`
 * environment per website, exposes WordPress installations as environments when
 * the account has any, and reports the rest of the provider-neutral surface as
 * unsupported. This port keeps that mapping verbatim; the deviations from the Go
 * source are called out in comments where they occur.
 *
 * Authentication is a bearer API token. `companyId` on the profile is *not* a
 * tenant id here — it is the hosting account username that the account-scoped
 * endpoints (`/accounts/{username}/...`) need, and for `regions.list` it is
 * reinterpreted once more as a Hostinger `order_id`.
 */

import { Buffer } from "node:buffer";

import { CliError } from "../../errors.js";
import {
  type ActionRequest,
  type ProviderClient,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedOperation,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import {
  type HttpBody,
  type HttpClient,
  type HttpMethod,
  bearerAuth,
  jsonBody,
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
  providerCapabilities,
} from "../types.js";
import type { ListSitesOptions } from "../client.js";

const PROVIDER = "hostinger" as const;

/** Go paginates websites 50 at a time (`ListSites`, `listWebsites`). */
const PAGE_SIZE = "50";

/**
 * Deviation from the Go source: `listWebsites` loops until the provider reports
 * a page beyond the total, with no upper bound. A provider that keeps answering
 * `current_page: 1` would spin forever, so this port stops after a generous
 * number of pages (2500 * 50 = 125_000 websites).
 */
const MAX_PAGES = 2_500;

const NOTE_SYNTHETIC_ENV =
  "Hostinger websites are exposed as one synthetic environment; WordPress installations are listed as environments when discoverable";
const NOTE_NATIVE_JSON =
  "use --from-json with Hostinger-native fields for full control";
const NOTE_NOT_MAPPED = "not mapped for Hostinger in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by Hostinger's provider-neutral Novamira mapping";

const CAPABILITIES: readonly ProviderCapabilityInput[] = [
  ["providers.validate", true],
  ["providers.capabilities", true],
  ["sites.list", true, "uses GET /api/hosting/v1/websites"],
  ["sites.get", true, "uses GET /api/hosting/v1/websites filtered by domain"],
  ["envs.list", true, NOTE_SYNTHETIC_ENV],
  ["envs.get", true, NOTE_SYNTHETIC_ENV],
  ["ops.get", false, NOTE_NOT_MAPPED],
  ["ops.wait", false, NOTE_NOT_MAPPED],
  [
    "regions.list",
    true,
    "uses GET /api/hosting/v1/datacenters; pass Hostinger order_id via --company",
  ],
  ["activity.list", false, NOTE_NOT_MAPPED],
  [
    "sites.create",
    true,
    `uses POST /api/hosting/v1/websites; ${NOTE_NATIVE_JSON}`,
  ],
  [
    "sites.create-plain",
    true,
    `uses POST /api/hosting/v1/websites; ${NOTE_NATIVE_JSON}`,
  ],
  ["sites.clone", false, NOTE_UNSUPPORTED],
  [
    "envs.create",
    true,
    `uses POST /api/hosting/v1/accounts/{username}/wordpress/installations; ${NOTE_NATIVE_JSON}`,
  ],
  ["envs.create-plain", false, NOTE_UNSUPPORTED],
  ["envs.clone", false, NOTE_UNSUPPORTED],
  ["envs.push", false, NOTE_UNSUPPORTED],
  [
    "domains.list",
    true,
    "uses GET /api/hosting/v1/accounts/{username}/websites/{domain}/parked-domains",
  ],
  [
    "domains.add",
    true,
    "uses POST /api/hosting/v1/accounts/{username}/websites/{domain}/parked-domains",
  ],
  ["domains.primary", false, NOTE_NOT_MAPPED],
  ["dns.domains.list", true, "uses GET /api/domains/v1/portfolio"],
  ["dns.records.list", true, "uses GET /api/dns/v1/zones/{domain}"],
  ["backups.list", false, NOTE_NOT_MAPPED],
  ["cache.clear", false, NOTE_UNSUPPORTED],
  ["php.restart", false, NOTE_UNSUPPORTED],
  ["php.set-version", false, NOTE_UNSUPPORTED],
  ["wp.plugins.list", false, NOTE_NOT_MAPPED],
  [
    "wp.plugins.install",
    false,
    "Hostinger exposes WP-CLI through SSH/hPanel, not the public API mapped by Novamira",
  ],
  ["wp.themes.list", false, NOTE_NOT_MAPPED],
  ["wp-cli.run", false, NOTE_NOT_MAPPED],
  ["logs.get", false, NOTE_NOT_MAPPED],
  ["analytics.usage", false, NOTE_NOT_MAPPED],
  ["analytics.env", false, NOTE_NOT_MAPPED],
];

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/** `hostingerWebsite`; `order_id`, `root_directory` and `parent_domain` are unused. */
interface HostingerWebsite {
  readonly domain: string;
  readonly vhostType: string;
  readonly isEnabled: boolean;
  readonly username: string;
}

/** `hostingerMeta`. */
interface HostingerMeta {
  readonly currentPage: number;
  readonly perPage: number;
  readonly total: number;
}

/** `hostingerWordPressInstallation`; `directory` and `validation_error` are unused. */
interface HostingerInstallation {
  readonly id: string;
  readonly username: string;
  readonly domain: string;
  readonly siteTitle: string;
  readonly url: string;
  readonly isValid: boolean;
}

/**
 * Deviation from the Go source: Go decodes into typed structs and fails the
 * whole request when a field has the wrong JSON type. This port reads each field
 * defensively and falls back to the Go zero value, so one odd field in one
 * website does not sink an entire listing.
 */
function parseWebsite(value: unknown): HostingerWebsite {
  const record = asRecord(value) ?? {};
  return {
    domain: stringOf(record.domain),
    vhostType: stringOf(record.vhost_type),
    isEnabled: booleanOf(record.is_enabled),
    username: stringOf(record.username),
  };
}

function parseInstallation(value: unknown): HostingerInstallation {
  const record = asRecord(value) ?? {};
  return {
    id: stringOf(record.id),
    username: stringOf(record.username),
    domain: stringOf(record.domain),
    siteTitle: stringOf(record.site_title),
    url: stringOf(record.url),
    isValid: booleanOf(record.is_valid),
  };
}

interface HostingerWebsitesResponse {
  readonly data: readonly HostingerWebsite[];
  readonly meta: HostingerMeta;
}

function parseWebsitesResponse(value: unknown): HostingerWebsitesResponse {
  const record = asRecord(value) ?? {};
  const meta = asRecord(record.meta) ?? {};
  return {
    data: Array.isArray(record.data) ? record.data.map(parseWebsite) : [],
    meta: {
      currentPage: integerOf(meta.current_page),
      perPage: integerOf(meta.per_page),
      total: integerOf(meta.total),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Hostinger `ProviderClient`. The registry wires this module by the exported
 * `createHostingerClient` name; nothing here reads configuration, the
 * environment, or credential storage.
 */
class HostingerClient implements ProviderClient {
  readonly provider = PROVIDER;

  readonly #http: HttpClient;
  /**
   * Go builds every request URL as `strings.TrimRight(baseURL, "/") + path`.
   * This port does the same and hands the shared client an absolute URL, which
   * it accepts as long as the origin matches. Letting the client join the path
   * itself would emit a double slash for a base URL that has no path of its own
   * — and Hostinger's default base URL, `https://developers.hostinger.com`, has
   * none.
   */
  readonly #baseUrl: string;
  readonly #credentialSource: string;
  /** Hostinger account username from the profile's `companyId`, when set. */
  readonly #username: string | undefined;

  constructor(context: ProviderClientContext) {
    if (context.secret.length === 0) {
      throw new CliError(
        "credential_missing",
        "The Hostinger API token is empty.",
        {
          details: { provider: PROVIDER, credential: context.credentialSource },
        },
      );
    }
    this.#http = context.createHttpClient({
      // The only place the secret is revealed.
      auth: bearerAuth(context.secret.reveal()),
    });
    this.#baseUrl = context.baseUrl.replace(/\/+$/, "");
    this.#credentialSource = context.credentialSource;
    // Go's `NewHostingerClient` reads `profile.CompanyID` directly rather than
    // the factory's wider `identity` chain, and Hostinger declares no identity
    // environment variable, so the two agree.
    this.#username = context.companyId;
  }

  async validate(): Promise<ProviderValidation> {
    const response = parseWebsitesResponse(
      await this.#http.json({
        path: this.#url("/api/hosting/v1/websites"),
        query: [
          ["page", "1"],
          ["per_page", "1"],
        ],
      }),
    );
    const first = response.data[0];
    const username =
      this.#username ??
      (first !== undefined && first.username !== ""
        ? first.username
        : undefined);
    return {
      provider: PROVIDER,
      status: "active",
      // `company_id` carries no `omitempty` in Go, so an unknown account is null.
      companyId: username ?? null,
      credential: this.#credentialSource,
    };
  }

  async listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const includeEnvironments = options?.includeEnvironments ?? false;
    const username = options?.companyId ?? this.#username;
    const query: [string, string][] = [
      ["page", "1"],
      ["per_page", PAGE_SIZE],
    ];
    if (username !== undefined && username !== "")
      query.push(["username", username]);
    return (await this.#listWebsites(query)).map((website) =>
      websiteToSite(website, includeEnvironments),
    );
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const websites = await this.#listWebsites([
      ["page", "1"],
      ["per_page", PAGE_SIZE],
      ["domain", siteId],
    ]);
    const exact = websites.find((website) => website.domain === siteId);
    if (exact !== undefined) return websiteToSite(exact, true);
    const only = websites.length === 1 ? websites[0] : undefined;
    if (only !== undefined) return websiteToSite(only, true);
    throw websiteNotFound(siteId);
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    const websites = await this.#listWebsites([
      ["page", "1"],
      ["per_page", PAGE_SIZE],
      ["domain", siteId],
    ]);
    const website = websites[0];
    if (website === undefined) throw websiteNotFound(siteId);

    const query: [string, string][] = [
      ["domain", website.domain],
      ["ownership", "all"],
    ];
    if (website.username !== "") query.push(["username", website.username]);
    const payload = await this.#http.json({
      path: this.#url("/api/hosting/v1/wordpress/installations"),
      query,
    });
    const installations = Array.isArray(payload)
      ? payload.map(parseInstallation)
      : [];
    if (installations.length > 0)
      return installations.map(installationToEnvironment);
    return [...(websiteToSite(website, true).environments ?? [])];
  }

  async read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return this.#capabilities();
      case "regions": {
        // Hostinger's datacenter listing is scoped by order, not by account, and
        // Go refuses to guess: `--company` carries the order id here.
        const orderId = request.companyId;
        if (orderId === undefined || orderId === "")
          throw new CliError(
            "usage_error",
            "Hostinger requires an order_id via --company for regions.list.",
            { details: { provider: PROVIDER, request: request.kind } },
          );
        return this.#http.json({
          path: this.#url("/api/hosting/v1/datacenters"),
          query: [["order_id", orderId]],
        });
      }
      case "dns-domains":
        return this.#http.json({
          path: this.#url("/api/domains/v1/portfolio"),
        });
      case "dns-records":
        return this.#http.json({
          path: this.#url(`/api/dns/v1/zones/${pathEscape(request.domainId)}`),
        });
      case "site-domains": {
        const ref = resolveEnvRef(request.envId, undefined, this.#username);
        return this.#http.json({
          path: this.#url(
            `/api/hosting/v1/accounts/${pathEscape(ref.username)}/websites/${pathEscape(ref.domain)}/parked-domains`,
          ),
        });
      }
      // Deliberately unmapped: Hostinger's public API exposes none of these, and
      // the capability table above reports each one as unsupported.
      case "activity":
      case "site-domain-verification":
      case "backups":
      case "downloadable-backups":
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
      case "create-site":
        if (request.mode === "clone")
          throw unsupportedOperation(PROVIDER, "sites.clone");
        // Go maps `wordpress` and `plain` onto the same endpoint and lets the
        // request body decide; `--from-json` is the documented escape hatch.
        return this.#sendAction(
          "sites.create",
          "POST",
          this.#url("/api/hosting/v1/websites"),
          request.body,
        );
      case "create-environment": {
        // Go ignores `Mode` here even though the capability table reports
        // `envs.create-plain` and `envs.clone` as unsupported; the endpoint only
        // ever creates a WordPress installation. Kept as-is.
        const ref = resolveEnvRef("", request.body, this.#username);
        return this.#sendAction(
          "envs.create",
          "POST",
          this.#url(
            `/api/hosting/v1/accounts/${pathEscape(ref.username)}/wordpress/installations`,
          ),
          ref.body,
        );
      }
      case "add-domain": {
        const ref = resolveEnvRef(request.envId, request.body, this.#username);
        return this.#sendAction(
          "domains.add",
          "POST",
          this.#url(
            `/api/hosting/v1/accounts/${pathEscape(ref.username)}/websites/${pathEscape(ref.domain)}/parked-domains`,
          ),
          ref.body,
        );
      }
      // Deliberately unmapped, mirroring Go's `default` arm.
      case "push-environment":
      case "clear-cache":
      case "restart-php":
      case "set-php-version":
      case "change-primary-domain":
      case "create-backup":
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
   * Hostinger exposes no operation resource at all, so there is nothing an
   * operation id could be looked up against. Go returns the same refusal.
   *
   * The `operationId` parameter is dropped rather than accepted and ignored: a
   * method with fewer parameters still satisfies `ProviderClient`, so the
   * signature itself says the id is unusable here.
   */
  operationStatus(): Promise<OperationStatus> {
    return Promise.reject(unsupportedOperation(PROVIDER, "operation status"));
  }

  #url(path: string): string {
    return this.#baseUrl + path;
  }

  #capabilities(): ProviderCapability[] {
    return providerCapabilities(CAPABILITIES);
  }

  /** `listWebsites`: follow `meta` until the reported page covers the total. */
  async #listWebsites(query: Query): Promise<HostingerWebsite[]> {
    const all: HostingerWebsite[] = [];
    let page: [string, string][] = query.map(([name, value]) => [name, value]);
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const response = parseWebsitesResponse(
        await this.#http.json({
          path: this.#url("/api/hosting/v1/websites"),
          query: page,
        }),
      );
      all.push(...response.data);
      const { currentPage, perPage, total } = response.meta;
      if (currentPage <= 0 || perPage <= 0 || currentPage * perPage >= total)
        break;
      page = setQuery(page, "page", String(currentPage + 1));
    }
    return all;
  }

  /** `sendAction`: normalize one mutating call into an `ActionResult`. */
  async #sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body: unknown,
  ): Promise<ActionResult> {
    const response = await this.#http.request({
      path,
      method,
      ...requestBody(body),
    });
    const operationId = jsonStringField(response.data, "id");
    return {
      provider: PROVIDER,
      action,
      // Go reports the HTTP status verbatim here; unlike Kinsta's
      // `buildActionResult` it never lifts a `status` field out of the body.
      status: response.status,
      ...(operationId === undefined ? {} : { operationId }),
      raw: response.data,
    };
  }
}

/**
 * The provider registry entry point. Construction is synchronous: Hostinger
 * needs no token exchange.
 */
export const createHostingerClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => new HostingerClient(context);

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** `hostingerWebsiteToHosting`. */
function websiteToSite(
  website: HostingerWebsite,
  includeEnvironments: boolean,
): HostingSite {
  const displayName =
    website.vhostType === ""
      ? website.domain
      : `${website.domain} (${website.vhostType})`;
  const site: HostingSite = {
    id: website.domain,
    name: website.domain,
    displayName,
    status: website.isEnabled ? "active" : "disabled",
    primaryDomain: website.domain,
  };
  if (!includeEnvironments) return site;
  return {
    ...site,
    environments: [
      {
        id: environmentId(website.username, website.domain),
        name: "live",
        displayName: "Live",
        isBlocked: !website.isEnabled,
        isPremium: false,
        primaryDomain: website.domain,
      },
    ],
  };
}

/** `hostingerWordPressToEnvironment`. */
function installationToEnvironment(
  installation: HostingerInstallation,
): HostingEnvironment {
  const id =
    installation.id === ""
      ? environmentId(installation.username, installation.domain)
      : installation.id;
  const name =
    installation.siteTitle === ""
      ? installation.domain
      : installation.siteTitle;
  return {
    id,
    name,
    displayName: name,
    isBlocked: !installation.isValid,
    isPremium: false,
    primaryDomain:
      installation.url === "" ? installation.domain : installation.url,
  };
}

/** `hostingerEnvironmentID`. */
function environmentId(username: string, domain: string): string {
  return username === "" ? domain : `${username}:${domain}`;
}

function websiteNotFound(siteId: string): CliError {
  return new CliError(
    "not_found",
    `Hostinger website "${siteId}" was not found.`,
    {
      details: { provider: PROVIDER, siteId },
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Env references and request bodies                                          */
/* -------------------------------------------------------------------------- */

interface HostingerEnvRef {
  readonly username: string;
  readonly domain: string;
  /** The body read as a field map; the account endpoints send this verbatim. */
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * `hostingerEnvRef`: an env id is `username:domain`, `domain`, or absent, and
 * the request body may supply either half under several Hostinger-native names.
 */
function resolveEnvRef(
  envId: string,
  body: unknown,
  defaultUsername: string | undefined,
): HostingerEnvRef {
  const fields = objectFromBody(body);
  let username = stringFromMap(fields, "username", "account_username");
  let domain = stringFromMap(fields, "domain", "website", "site_id");

  if (envId !== "") {
    const separator = envId.indexOf(":");
    if (separator >= 0) {
      if (username === "") username = envId.slice(0, separator);
      if (domain === "") domain = envId.slice(separator + 1);
    } else if (domain === "") {
      domain = envId;
    }
  }
  if (username === "" && defaultUsername !== undefined)
    username = defaultUsername;
  if (username === "")
    throw new CliError(
      "usage_error",
      "Hostinger requires a username in the request body, --company, or --env username:domain.",
      { details: { provider: PROVIDER, envId } },
    );
  // Go's last-resort fallback: an env id of `user:` leaves the domain empty, so
  // the whole reference is reused as the website name.
  if (domain === "" && envId !== "") domain = envId;
  return { username, domain, body: fields };
}

/** `mapFromBody`: read an arbitrary action body as a Hostinger field map. */
function objectFromBody(body: unknown): Readonly<Record<string, unknown>> {
  if (body === undefined || body === null) return {};
  const direct = asRecord(body);
  if (direct !== undefined) return direct;
  // Go round-trips anything else through JSON and fails when the result is not
  // a JSON object.
  let round: unknown;
  try {
    round = JSON.parse(JSON.stringify(body)) as unknown;
  } catch (cause) {
    throw new CliError(
      "usage_error",
      "The Hostinger request body is not valid JSON.",
      {
        cause,
        details: { provider: PROVIDER },
      },
    );
  }
  const parsed = asRecord(round);
  if (parsed === undefined)
    throw new CliError(
      "usage_error",
      "The Hostinger request body must be a JSON object.",
      {
        details: { provider: PROVIDER },
      },
    );
  return parsed;
}

/**
 * `stringFromMap`: the first key that holds a string or a number, with numbers
 * truncated toward zero the way Go's `int64(float64)` conversion is.
 */
function stringFromMap(
  fields: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string {
  for (const key of keys) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(Math.trunc(value));
  }
  return "";
}

/** Go sends no request body for a nil body and a JSON body for anything else. */
function requestBody(body: unknown): { readonly body?: HttpBody } {
  return body === undefined || body === null ? {} : { body: jsonBody(body) };
}

/** `jsonStringField`: the named field of a JSON object, when it is a string. */
function jsonStringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record[key];
  return typeof field === "string" ? field : undefined;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** `setQuery`: replace a parameter in place, preserving order, or append it. */
function setQuery(
  query: readonly (readonly [string, string])[],
  name: string,
  value: string,
): [string, string][] {
  const next = query.map(([key, current]): [string, string] => [key, current]);
  const existing = next.find((pair) => pair[0] === name);
  if (existing === undefined) {
    next.push([name, value]);
    return next;
  }
  existing[1] = value;
  return next;
}

/**
 * The unreserved and sub-delimiter bytes Go's `url.PathEscape` leaves alone in a
 * path segment. `encodeURIComponent` is not a substitute: it escapes `$&+:=@`
 * and leaves `!'()*` unescaped, which is the opposite of Go on both counts.
 */
const PATH_SEGMENT_SAFE = /^[A-Za-z0-9\-_.~$&+:=@]$/;

function pathEscape(value: string): string {
  let escaped = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    escaped = PATH_SEGMENT_SAFE.test(character)
      ? escaped + character
      : `${escaped}%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanOf(value: unknown): boolean {
  return value === true;
}

function integerOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

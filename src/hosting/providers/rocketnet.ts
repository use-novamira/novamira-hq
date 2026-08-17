// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Rocket.net provider client, ported from `internal/providers/rocketnet.go`.
 *
 * Rocket.net exchanges a username and a password for a JWT on `POST /v1/login`
 * and then expects `Authorization: Bearer <jwt>` on every other request. HQ keeps
 * the password in the profile's credential reference and takes the non-secret
 * username from the profile's `companyId`, falling back to `ROCKETNET_USERNAME`
 * — both resolved by the factory, which is why this module never reads
 * `process.env`, configuration, or credential storage itself. The password is
 * revealed exactly once per token exchange, inside `login()`.
 *
 * Rocket.net has no environment concept: a site *is* its environment, so every
 * site is normalized into exactly one synthetic `HostingEnvironment` whose id is
 * the site id. Several provider-neutral requests therefore have no Rocket.net
 * equivalent; each one gets an explicit `case` that reports
 * `provider_unsupported` rather than falling through to `assertNever`.
 *
 * Deviations from the Go source are marked `Deviation:` where they occur.
 */

import { CliError } from "../../errors.js";
import {
  redactAssociatedText,
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../../output/redact.js";
import { DEFAULT_ROCKETNET_USERNAME_ENV } from "../../config/schema.js";
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
  wpCliWithoutBinary,
} from "../client.js";
import type { ProviderClientFactory } from "../factory.js";
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
  type ProviderCapabilityInput,
  type ProviderValidation,
  type Query,
  providerCapabilities,
} from "../types.js";

const PROVIDER = "rocketnet" as const;
const LABEL = "Rocket.net";

/** Rocket.net documents token expiry as 7 days; refresh a little early. */
const TOKEN_LIFETIME_MS = (6 * 24 + 23) * 60 * 60 * 1000;

/** Rocket.net's own maximum page size for `GET /v1/sites`. */
const SITES_PAGE_SIZE = 100;

/**
 * The capability table, verbatim from `RocketNetClient.capabilities`.
 *
 * It is documented output, so the entries and their order are preserved even
 * where they overstate the mapping: `domains.verify` is declared supported
 * although Go's `Read` switch has no `ReadSiteDomainVerification` case, and
 * `wp.plugins.list` / `wp.plugins.install` describe endpoints the provisioning
 * layer drives rather than the request unions.
 */
const CAPABILITIES: readonly ProviderCapabilityInput[] = (() => {
  const singleEnv = "Rocket.net sites are exposed as one synthetic environment";
  const notMapped = "not mapped for Rocket.net in Novamira";
  const unsupported =
    "not supported by Rocket.net's provider-neutral Novamira mapping";
  const taskListing = "uses Rocket.net account or site task listing";
  return [
    "providers.validate",
    "providers.capabilities",
    "sites.list",
    "sites.get",
    ["envs.list", true, singleEnv],
    ["envs.get", true, singleEnv],
    ["ops.get", true, taskListing],
    ["ops.wait", true, taskListing],
    ["regions.list", true, "uses GET /v1/sites/all_locations"],
    [
      "activity.list",
      true,
      "uses GET /v1/sites/{site_id}/activity/events when site_id is supplied",
    ],
    ["sites.create", true, "uses POST /v1/sites"],
    [
      "sites.create-plain",
      true,
      "uses POST /v1/sites with site_type/static_site payload fields",
    ],
    [
      "sites.clone",
      true,
      "uses POST /v1/sites/{id}/clone; source site id must be in body.source_site_id",
    ],
    ["sites.delete", true, "uses DELETE /v1/sites/{id}"],
    ["sites.reset", false, unsupported],
    ["envs.create", true, "uses POST /v1/sites/{site_id}/staging"],
    ["envs.create-plain", false, singleEnv],
    ["envs.clone", true, "uses POST /v1/sites/{site_id}/staging"],
    ["envs.push", true, "uses POST /v1/sites/{site_id}/staging/publish"],
    ["envs.delete", true, "uses DELETE /v1/sites/{id}/staging"],
    ["domains.list", true, "uses GET /v1/sites/{site_id}/domains"],
    ["domains.add", true, "uses POST /v1/sites/{site_id}/domains"],
    [
      "domains.delete",
      true,
      "uses DELETE /v1/sites/{site_id}/domains/{domain_id}",
    ],
    ["domains.verify", true, "uses GET /v1/sites/{site_id}/maindomain/recheck"],
    ["domains.primary", true, "uses PUT /v1/sites/{site_id}/maindomain"],
    ["dns.domains.list", false, notMapped],
    ["dns.records.list", false, notMapped],
    ["dns.records.create", false, notMapped],
    ["dns.records.update", false, notMapped],
    ["dns.records.delete", false, notMapped],
    ["backups.list", true, "uses GET /v1/sites/{site_id}/backup"],
    [
      "backups.downloadable",
      false,
      "Rocket.net backup downloads require a token from the backup response",
    ],
    ["backups.create", true, "uses POST /v1/sites/{site_id}/backup"],
    [
      "backups.restore",
      true,
      "uses POST /v1/sites/{site_id}/backup/{backup_id}/restore",
    ],
    [
      "backups.delete",
      false,
      "Rocket.net requires site_id as well as backup_id; the current provider-neutral command only passes backup_id",
    ],
    [
      "cache.clear",
      true,
      "uses POST /v1/sites/{site_id}/cache/purge_everything or /cache/purge",
    ],
    ["php.restart", false, unsupported],
    ["php.set-version", false, notMapped],
    ["redirects.list", false, notMapped],
    ["redirects.apply", false, notMapped],
    ["denied-ips.list", false, notMapped],
    ["denied-ips.set", false, notMapped],
    ["wp.plugins.list", true, "uses GET /v1/sites/{site_id}/plugins"],
    ["wp.plugins.install", true, "uses POST /v1/sites/{site_id}/wpcli"],
    ["wp.plugins.update", true, "uses PUT /v1/sites/{site_id}/plugins"],
    ["wp.plugins.update-all", true, "uses PUT /v1/sites/{site_id}/plugins"],
    ["wp.themes.list", true, "uses GET /v1/sites/{site_id}/themes"],
    ["wp.themes.update", true, "uses PUT /v1/sites/{site_id}/themes"],
    ["wp.themes.update-all", true, "uses PUT /v1/sites/{site_id}/themes"],
    ["wp-cli.run", true, "uses POST /v1/sites/{site_id}/wpcli"],
    ["logs.get", true, "uses GET /v1/sites/{site_id}/access_logs"],
    [
      "analytics.usage",
      true,
      "uses GET /v1/sites/{site_id}/usage or account usage endpoints",
    ],
    ["analytics.env", true, "uses Rocket.net reporting endpoints"],
    ["access.ssh", true, "uses GET /v1/sites/{site_id}/ssh/keys"],
    ["access.sftp", true, "uses GET /v1/sites/{site_id}/ftp/accounts"],
  ];
})();

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export const createRocketNetClient: ProviderClientFactory = (context) => {
  const username = (context.identity ?? "").trim();
  if (username === "") {
    throw new CliError(
      "credential_missing",
      `The ${LABEL} username is required; set ${DEFAULT_ROCKETNET_USERNAME_ENV} or the profile's company id.`,
      { details: { provider: PROVIDER, credential: context.credentialSource } },
    );
  }
  // `SecretValue.length` avoids revealing the password just to test it.
  if (context.secret.length === 0) {
    throw new CliError(
      "credential_missing",
      `The ${LABEL} password is empty.`,
      {
        details: { provider: PROVIDER, credential: context.credentialSource },
      },
    );
  }

  /**
   * Go's `urlFor`: the API root joined with an absolute Rocket.net path.
   *
   * Deviation: this concatenates against `context.baseUrl` (which the factory
   * has already stripped of trailing slashes) and hands the shared client an
   * absolute, same-origin URL, instead of passing the bare `/v1/...` path.
   * Rocket.net's API root is an origin with no path — `https://api.rocket.net`
   * — and `HttpClient` normalizes that base to `https://api.rocket.net/`, so a
   * path-relative request would be sent to `//v1/...`. Building the URL here
   * keeps every request on the exact path Rocket.net documents.
   */
  const endpoint = (path: string): string => `${context.baseUrl}${path}`;

  let token: string | undefined;
  let tokenExpiresAt = 0;
  let pendingLogin: Promise<string> | undefined;

  const http: HttpClient = context.createHttpClient({
    auth: dynamicAuth(async () => {
      const bearer = await ensureToken();
      return {
        headers: { authorization: `Bearer ${bearer}` },
        secrets: [bearer],
      };
    }),
  });

  /**
   * Go guards the token with a mutex; the single-threaded runtime needs only a
   * shared in-flight promise so concurrent requests exchange the credential once.
   */
  async function ensureToken(): Promise<string> {
    if (token !== undefined && Date.now() < tokenExpiresAt) return token;
    pendingLogin ??= login().finally(() => {
      pendingLogin = undefined;
    });
    return pendingLogin;
  }

  async function login(): Promise<string> {
    // The one place the credential is revealed: the token exchange body is this
    // provider's authorization construction.
    const password = context.secret.reveal();
    const data = await http.json({
      path: endpoint("/v1/login"),
      method: "POST",
      anonymous: true,
      body: jsonBody({ username, password }),
      secrets: [password],
    });
    const issued = isRecord(data) ? data.token : undefined;
    if (typeof issued !== "string" || issued === "") {
      throw new CliError(
        "credential_invalid",
        `The ${LABEL} login response did not contain a token.`,
        { details: { provider: PROVIDER } },
      );
    }
    token = issued;
    tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
    return issued;
  }

  /** `GET` returning the redacted, parsed body (Go's `readJSON`). */
  async function readJson(path: string, query?: Query): Promise<unknown> {
    const response = await http.request({
      path: endpoint(path),
      ...(query === undefined ? {} : { query }),
    });
    return redactSecrets(response.data);
  }

  /** `GET` returning a decoded envelope object (Go's `get` + struct decode). */
  async function getEnvelope(
    path: string,
    query?: Query,
  ): Promise<Record<string, unknown>> {
    const data = await http.json({
      path: endpoint(path),
      ...(query === undefined ? {} : { query }),
    });
    if (!isRecord(data)) {
      throw new CliError(
        "provider_error",
        `The ${LABEL} API response from ${path} is not a JSON object.`,
        { details: { provider: PROVIDER, path } },
      );
    }
    return data;
  }

  async function sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body?: ActionBody,
  ): Promise<ActionResult> {
    // Go marshals a body only when the `any` is non-nil; `null` is that `nil`.
    const hasBody = body !== undefined && body !== null;
    const response = await http.request({
      path: endpoint(path),
      method,
      ...(hasBody ? { body: jsonBody(body) } : {}),
    });
    const raw = redactSecrets(response.data);
    const message = messageField(raw);
    const operationId = operationIdField(raw);
    return {
      provider: PROVIDER,
      action,
      status: response.status,
      ...(message === undefined ? {} : { message }),
      ...(operationId === undefined ? {} : { operationId }),
      raw,
    };
  }

  async function deleteDomains(
    envId: string,
    body: ActionBody,
  ): Promise<ActionResult> {
    const domainIds = domainIdsFrom(body);
    const first = domainIds[0];
    if (domainIds.length === 1 && first !== undefined) {
      return sendAction(
        "domains.delete",
        "DELETE",
        `/v1/sites/${escapePath(envId)}/domains/${escapePath(first)}`,
      );
    }
    const results: unknown[] = [];
    for (const domainId of domainIds) {
      const result = await sendAction(
        "domains.delete",
        "DELETE",
        `/v1/sites/${escapePath(envId)}/domains/${escapePath(domainId)}`,
      );
      results.push(result.raw);
    }
    return {
      provider: PROVIDER,
      action: "domains.delete",
      status: 200,
      raw: { success: true, result: results },
    };
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    const path = `/v1/sites/${escapePath(siteId)}`;
    const envelope = await getEnvelope(path);
    requireSuccess(envelope, path);
    return siteFromPayload(envelope.result, true);
  }

  const client: ProviderClient = {
    provider: PROVIDER,

    async validate(): Promise<ProviderValidation> {
      const path = "/v1/account/me";
      const envelope = await getEnvelope(path);
      if (envelope.success !== true) {
        const error = new CliError(
          "provider_error",
          redactAssociatedText(
            `${LABEL} API validation failed: ${joinMessages(envelope.messages)}`,
            envelope,
          ),
          { details: { provider: PROVIDER, path } },
        );
        registerSensitiveValues(error, registeredSensitiveValues(envelope));
        throw error;
      }
      const result = isRecord(envelope.result) ? envelope.result : {};
      const clientRecord = isRecord(result.client) ? result.client : {};
      const email = stringValue(clientRecord.email);
      return {
        provider: PROVIDER,
        status: "active",
        companyId: email === "" ? username : email,
        credential: context.credentialSource,
      };
    },

    async listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
      const includeEnvironments = options?.includeEnvironments ?? false;
      const path = "/v1/sites";
      const sites: HostingSite[] = [];
      for (let page = 1; ; page += 1) {
        const envelope = await getEnvelope(path, [
          ["page", String(page)],
          ["per_page", String(SITES_PAGE_SIZE)],
        ]);
        requireSuccess(envelope, path);
        const result = Array.isArray(envelope.result)
          ? (envelope.result as unknown[])
          : [];
        for (const entry of result)
          sites.push(siteFromPayload(entry, includeEnvironments));
        const metadata = isRecord(envelope.metadata)
          ? envelope.metadata
          : undefined;
        if (metadata === undefined) break;
        const pageSize = numberValue(metadata.page_size);
        const total = numberValue(metadata.total);
        if (pageSize <= 0 || result.length < pageSize || sites.length >= total)
          break;
      }
      return sites;
    },

    getSite,

    async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
      const site = await getSite(siteId);
      return [...(site.environments ?? [])];
    },

    async read(request: ReadRequest): Promise<unknown> {
      switch (request.kind) {
        case "capabilities":
          return providerCapabilities(CAPABILITIES);
        case "regions":
          return readJson("/v1/sites/all_locations");
        case "activity": {
          const query = request.query ?? [];
          const siteId = queryValue(query, "site_id");
          if (siteId === "")
            return readJson("/v1/account/tasks", activityQuery(query, false));
          return readJson(
            `/v1/sites/${escapePath(siteId)}/activity/events`,
            activityQuery(query, true),
          );
        }
        case "site-domains":
          return readJson(`/v1/sites/${escapePath(request.envId)}/domains`);
        case "backups":
          return readJson(`/v1/sites/${escapePath(request.envId)}/backup`);
        case "plugins":
          return readJson(`/v1/sites/${escapePath(request.envId)}/plugins`);
        case "themes":
          return readJson(`/v1/sites/${escapePath(request.envId)}/themes`);
        case "logs":
          return readJson(
            `/v1/sites/${escapePath(request.envId)}/access_logs`,
            logQuery(request.fileName, request.lines),
          );
        case "sftp-accounts":
          return readJson(
            `/v1/sites/${escapePath(request.envId)}/ftp/accounts`,
          );
        case "ssh-status":
        case "ssh-allowlist":
        case "ssh-config": {
          const envId =
            request.kind === "ssh-config"
              ? request.envId === ""
                ? request.siteId
                : request.envId
              : request.envId;
          if (envId === "") {
            throw new CliError(
              "usage_error",
              `${LABEL} requires an environment or site id for SSH reads.`,
              { details: { provider: PROVIDER, request: request.kind } },
            );
          }
          return readJson(`/v1/sites/${escapePath(envId)}/ssh/keys`);
        }
        case "analytics-usage":
          return request.siteId === ""
            ? readJson("/v1/account/usage")
            : readJson(`/v1/sites/${escapePath(request.siteId)}/usage`);
        case "analytics-env": {
          const path = analyticsPath(request.envId, request.metric);
          return readJson(path, forwardQuery(request.query ?? []));
        }
        case "file-list":
          return readJson(
            `/v1/sites/${escapePath(request.envId)}/file_manager/files`,
          );
        // Deliberate gaps: Rocket.net has no provider-neutral mapping for these.
        // `site-domain-verification` is one of them even though the capability
        // table advertises `domains.verify`, exactly as in the Go source.
        case "site-domain-verification":
        case "dns-domains":
        case "dns-records":
        case "downloadable-backups":
        case "redirects":
        case "denied-ips":
        case "company-plugins":
        case "company-themes":
        case "ssh-password":
          throw unsupportedReadRequest(PROVIDER, request);
        default:
          return assertNever(request);
      }
    },

    async action(request: ActionRequest): Promise<ActionResult> {
      switch (request.kind) {
        case "create-site": {
          if (request.mode === "clone") {
            const { body, sourceSiteId } = cloneBody(request.body);
            return sendAction(
              "sites.clone",
              "POST",
              `/v1/sites/${escapePath(sourceSiteId)}/clone`,
              body,
            );
          }
          return sendAction(
            request.mode === "plain" ? "sites.create-plain" : "sites.create",
            "POST",
            "/v1/sites",
            request.body,
          );
        }
        case "delete-site":
          return sendAction(
            "sites.delete",
            "DELETE",
            `/v1/sites/${escapePath(request.siteId)}`,
          );
        case "create-environment":
          // Go maps every environment create mode onto the staging endpoint.
          return sendAction(
            "envs.create",
            "POST",
            `/v1/sites/${escapePath(request.siteId)}/staging`,
            request.body,
          );
        case "push-environment":
          return sendAction(
            "envs.push",
            "POST",
            `/v1/sites/${escapePath(request.siteId)}/staging/publish`,
            request.body,
          );
        case "delete-environment":
          return sendAction(
            "envs.delete",
            "DELETE",
            `/v1/sites/${escapePath(request.envId)}/staging`,
          );
        case "clear-cache": {
          const siteId = extractSiteId(request.body);
          if (siteId === "") {
            throw new CliError(
              "usage_error",
              `${LABEL} requires "site_id" in the request body for cache.clear.`,
              { details: { provider: PROVIDER, action: request.kind } },
            );
          }
          const prefix = `/v1/sites/${escapePath(siteId)}/cache`;
          return request.cache === "site"
            ? sendAction("cache.clear", "POST", `${prefix}/purge_everything`)
            : sendAction(
                "cache.clear",
                "POST",
                `${prefix}/purge`,
                request.body,
              );
        }
        case "add-domain":
          return sendAction(
            "domains.add",
            "POST",
            `/v1/sites/${escapePath(request.envId)}/domains`,
            request.body,
          );
        case "delete-domains":
          return deleteDomains(request.envId, request.body);
        case "change-primary-domain":
          return sendAction(
            "domains.primary",
            "PUT",
            `/v1/sites/${escapePath(request.envId)}/maindomain`,
            request.body,
          );
        case "create-backup":
          return sendAction(
            "backups.create",
            "POST",
            `/v1/sites/${escapePath(request.envId)}/backup`,
            backupCreateBody(request.body),
          );
        case "restore-backup": {
          const restore = restoreBackupBody(request.targetEnvId, request.body);
          return sendAction(
            "backups.restore",
            "POST",
            `/v1/sites/${escapePath(restore.siteId)}/backup/${escapePath(restore.backupId)}/restore`,
            restore.body,
          );
        }
        case "update-plugin":
          return sendAction(
            "wp.plugins.update",
            "PUT",
            `/v1/sites/${escapePath(request.envId)}/plugins`,
            request.body,
          );
        case "bulk-update-plugins":
          return sendAction(
            "wp.plugins.update-all",
            "PUT",
            `/v1/sites/${escapePath(request.envId)}/plugins`,
            request.body,
          );
        case "update-theme":
          return sendAction(
            "wp.themes.update",
            "PUT",
            `/v1/sites/${escapePath(request.envId)}/themes`,
            request.body,
          );
        case "bulk-update-themes":
          return sendAction(
            "wp.themes.update-all",
            "PUT",
            `/v1/sites/${escapePath(request.envId)}/themes`,
            request.body,
          );
        case "run-wp-cli":
          return sendAction(
            "wp-cli.run",
            "POST",
            `/v1/sites/${escapePath(request.envId)}/wpcli`,
            wpCliBody(request.body),
          );
        case "add-sftp-account":
          return sendAction(
            "access.sftp.add",
            "POST",
            `/v1/sites/${escapePath(request.envId)}/ftp/accounts`,
            request.body,
          );
        // Rocket.net can perform these two, but not from the provider-neutral
        // payload: both endpoints are addressed by site id, which the request
        // does not carry. Go raises the same refusal with a longer sentence.
        case "delete-backup":
          throw unsupportedOperation(
            PROVIDER,
            'the "delete-backup" action, which needs the site id as well as the backup id',
          );
        case "remove-sftp-account":
          throw unsupportedOperation(
            PROVIDER,
            'the "remove-sftp-account" action, which needs the site id and the account username',
          );
        // Deliberate gaps with no Rocket.net endpoint at all.
        case "reset-site":
        case "restart-php":
        case "set-php-version":
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
          throw unsupportedActionRequest(PROVIDER, request);
        default:
          return assertNever(request);
      }
    },

    async operationStatus(operationId: string): Promise<OperationStatus> {
      const [siteId, taskId] = splitOperationId(operationId);
      const path =
        siteId === ""
          ? "/v1/account/tasks"
          : `/v1/sites/${escapePath(siteId)}/tasks`;
      const response = await http.request({
        path: endpoint(path),
        query: [["task_id", taskId]],
      });
      const raw = redactSecrets(response.data);
      const task = taskFields(raw);
      const state = task.status.toUpperCase();
      return {
        provider: PROVIDER,
        operationId,
        status: response.status,
        done: state === "DONE" || state === "ERROR",
        failed: state === "ERROR",
        ...(task.message === undefined ? {} : { message: task.message }),
        raw,
      };
    },
  };

  return client;
};

/* -------------------------------------------------------------------------- */
/* Envelope helpers                                                           */
/* -------------------------------------------------------------------------- */

function requireSuccess(envelope: Record<string, unknown>, path: string): void {
  if (envelope.success === true) return;
  const error = new CliError(
    "provider_error",
    redactAssociatedText(
      `${LABEL} API request to ${path} failed: ${joinMessages(envelope.messages)}`,
      envelope,
    ),
    { details: { provider: PROVIDER, path } },
  );
  registerSensitiveValues(error, registeredSensitiveValues(envelope));
  throw error;
}

function joinMessages(value: unknown): string {
  if (!Array.isArray(value)) return "(no message)";
  const messages = (value as unknown[]).map((entry) => formatValue(entry));
  return messages.length === 0 ? "(no message)" : messages.join("; ");
}

/* -------------------------------------------------------------------------- */
/* Site normalization                                                         */
/* -------------------------------------------------------------------------- */

function siteFromPayload(
  value: unknown,
  includeEnvironments: boolean,
): HostingSite {
  const record = isRecord(value) ? value : {};
  const id = flexString(record.id);
  const label = stringValue(record.label);
  const displayDomain = stringValue(record.display_domain);
  const domain = stringValue(record.domain);
  const rocketUrl = stringValue(record.rocket_url);
  const rawStatus = stringValue(record.status);

  const displayName = firstNonEmpty(label, displayDomain, domain, id);
  const name = domain === "" ? displayName : domain;
  const primaryDomain = firstNonEmpty(displayDomain, domain, rocketUrl);

  const site: HostingSite = {
    id,
    name,
    displayName,
    status: normalizeStatus(rawStatus),
    ...(primaryDomain === "" ? {} : { primaryDomain }),
  };
  if (!includeEnvironments) return site;

  const lowered = rawStatus.toLowerCase();
  const wordpressVersion = wordpressVersionOf(record);
  const environment: HostingEnvironment = {
    id,
    name: environmentName(flexString(record.production)),
    displayName,
    isBlocked: lowered === "locked" || lowered === "disabled",
    isPremium: record.site_type === 1,
    ...(wordpressVersion === undefined ? {} : { wordpressVersion }),
    ...(primaryDomain === "" ? {} : { primaryDomain }),
  };
  return { ...site, environments: [environment] };
}

function normalizeStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "active":
    case "ready":
    case "live":
      return "active";
    case "pending":
    case "creating":
    case "new":
      return "pending";
    case "deleted":
      return "deleted";
    case "disabled":
    case "suspended":
    case "locked":
      return "suspended";
    default:
      return status === "" ? "unknown" : status.toLowerCase();
  }
}

function environmentName(production: string): string {
  return production !== "" && production !== "0" ? "staging" : "live";
}

function wordpressVersionOf(
  record: Record<string, unknown>,
): string | undefined {
  const metadata = record.metadata;
  if (!isRecord(metadata)) return undefined;
  for (const key of ["wordpress_version", "wp_version"]) {
    if (!(key in metadata)) continue;
    const text = formatValue(metadata[key]);
    if (text !== "" && text !== "<nil>") return text;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Response field extraction                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Go decodes these payloads into anonymous structs, so a field whose JSON type
 * does not match makes the whole decode fail and the helper yield "nothing".
 * `MISMATCH` reproduces that: it is the "this envelope does not decode" signal,
 * which is what makes a `result` array fall through to the task-list reader.
 */
const MISMATCH = Symbol("rocketnet.mismatch");

type Mismatch = typeof MISMATCH;

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | Mismatch {
  const value = record[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : MISMATCH;
}

function stringArrayField(
  record: Record<string, unknown>,
  key: string,
): string | Mismatch {
  const value = record[key];
  if (value === undefined || value === null) return "";
  if (!Array.isArray(value)) return MISMATCH;
  const entries: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") return MISMATCH;
    entries.push(entry);
  }
  return entries.join("; ");
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | Mismatch {
  const value = record[key];
  if (value === undefined || value === null) return {};
  return isRecord(value) ? value : MISMATCH;
}

/** Go's `rocketNetMessageField`. */
function messageField(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const message = stringField(raw, "message");
  const messages = stringArrayField(raw, "messages");
  const result = recordField(raw, "result");
  if (message === MISMATCH || messages === MISMATCH || result === MISMATCH)
    return undefined;
  const resultMessage = stringField(result, "message");
  const resultStatus = stringField(result, "status");
  if (resultMessage === MISMATCH || resultStatus === MISMATCH) return undefined;
  for (const candidate of [message, messages, resultMessage, resultStatus])
    if (candidate !== "") return candidate;
  return undefined;
}

/** Go's `rocketNetOperationID`. */
function operationIdField(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const taskId = stringField(raw, "task_id");
  const result = recordField(raw, "result");
  if (taskId === MISMATCH || result === MISMATCH) return undefined;
  const resultTaskId = stringField(result, "task_id");
  if (resultTaskId === MISMATCH) return undefined;
  for (const candidate of [taskId, resultTaskId])
    if (candidate !== "") return candidate;
  return undefined;
}

interface TaskFields {
  readonly status: string;
  readonly message: string | undefined;
}

/** Go's `rocketNetTaskFields`, including its strict decode of `result[0]`. */
function taskFields(raw: unknown): TaskFields {
  const task = firstTask(raw);
  if (task !== undefined) {
    const message = task.message === "" ? task.description : task.message;
    return {
      status: task.taskStatus === "" ? task.status : task.taskStatus,
      message: message === "" ? undefined : message,
    };
  }
  return { status: "", message: messageField(raw) };
}

interface RawTask {
  readonly taskStatus: string;
  readonly status: string;
  readonly message: string;
  readonly description: string;
}

function firstTask(raw: unknown): RawTask | undefined {
  if (!isRecord(raw)) return undefined;
  const result = raw.result;
  if (!Array.isArray(result) || result.length === 0) return undefined;
  const entry = (result as unknown[])[0];
  if (!isRecord(entry)) return undefined;
  const fields = {
    // `id` is decoded only so a non-string id fails the whole decode, as it
    // does in Go. Rocket.net returns task ids as strings.
    id: stringField(entry, "id"),
    taskStatus: stringField(entry, "task_status"),
    status: stringField(entry, "status"),
    message: stringField(entry, "message"),
    description: stringField(entry, "description"),
  };
  if (Object.values(fields).includes(MISMATCH)) return undefined;
  return {
    taskStatus: fields.taskStatus as string,
    status: fields.status as string,
    message: fields.message as string,
    description: fields.description as string,
  };
}

/** Go's `rocketNetSplitOperationID`: first `:` wins, else first `/`. */
function splitOperationId(operationId: string): [string, string] {
  for (const separator of [":", "/"]) {
    const index = operationId.indexOf(separator);
    if (index >= 0)
      return [
        operationId.slice(0, index),
        operationId.slice(index + separator.length),
      ];
  }
  return ["", operationId];
}

/* -------------------------------------------------------------------------- */
/* Query mapping                                                              */
/* -------------------------------------------------------------------------- */

function queryValue(query: Query, key: string): string {
  for (const [name, value] of query) if (name === key) return value;
  return "";
}

function forwardQuery(query: Query, ...excluded: readonly string[]): Query {
  return query.filter(
    ([name, value]) => value !== "" && !excluded.includes(name),
  );
}

function logQuery(fileName: string, lines: number): Query {
  if (fileName !== "" && fileName !== "access") {
    throw unsupportedOperation(
      PROVIDER,
      `the "${fileName}" log file; only "access" is available`,
    );
  }
  const query: [string, string][] = [["duration", "1h"]];
  if (lines > 0) query.push(["per_page", String(Math.trunc(lines))]);
  return query;
}

/** Go's `rocketNetActivityQuery`. */
function activityQuery(query: Query, siteEvents: boolean): Query {
  const out: [string, string][] = [];
  let limit = 10;
  let offset = 0;
  for (const pair of query) {
    const [key, value] = pair;
    if (value === "" || key === "site_id") continue;
    switch (key) {
      case "limit": {
        const parsed = parseInteger(value);
        if (parsed !== undefined && parsed > 0) limit = parsed;
        break;
      }
      case "offset": {
        const parsed = parseInteger(value);
        if (parsed !== undefined && parsed >= 0) offset = parsed;
        break;
      }
      case "category":
        out.push([siteEvents ? "event_type" : "task_type", value]);
        break;
      case "id_initiated_by":
        if (siteEvents) out.push(["author", value]);
        break;
      case "language":
      case "id_api_key":
        break;
      default:
        out.push([key, value]);
        break;
    }
  }
  out.push(["page", String(Math.trunc(offset / limit) + 1)]);
  out.push(["per_page", String(limit)]);
  return out;
}

/** Go's `rocketNetAnalyticsPath`. */
function analyticsPath(envId: string, metric: string): string {
  const site = `/v1/sites/${escapePath(envId)}`;
  switch (metric) {
    case "":
    case "usage":
      return `${site}/usage`;
    case "bandwidth":
      return `${site}/reporting/bandwidth`;
    case "bandwidth-usage":
      return `${site}/reporting/bandwidth/usage`;
    case "requests":
    case "total-requests":
      return `${site}/reporting/total_requests`;
    case "cdn-requests":
      return `/v1/reporting/sites/${escapePath(envId)}/cdn/requests`;
    default:
      throw unsupportedOperation(PROVIDER, `the analytics metric "${metric}"`);
  }
}

/** Go's `strconv.Atoi`: a full-string signed decimal integer, or nothing. */
function parseInteger(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/* -------------------------------------------------------------------------- */
/* Request body mapping                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Go's `objectBody`. Deviation: Go hands back the caller's own map and then
 * mutates it with `delete`; HQ copies first, so an action body is never
 * modified behind the caller's back.
 */
function objectBody(body: ActionBody): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (isRecord(body)) return { ...body };
  throw new CliError(
    "usage_error",
    `The ${LABEL} request body must be a JSON object.`,
    { details: { provider: PROVIDER } },
  );
}

interface CloneTarget {
  readonly body: Record<string, unknown>;
  readonly sourceSiteId: string;
}

function cloneBody(body: ActionBody): CloneTarget {
  const record = objectBody(body);
  for (const key of ["source_site_id", "sourceSiteID", "site_id", "id"]) {
    if (!(key in record)) continue;
    const sourceSiteId = formatValue(record[key]);
    // `delete record[key]` is a dynamic delete; this is the same operation.
    Reflect.deleteProperty(record, key);
    // Go breaks out of the loop (rather than continuing) on an unusable value.
    if (sourceSiteId === "" || sourceSiteId === "<nil>") break;
    return { body: record, sourceSiteId };
  }
  throw new CliError(
    "usage_error",
    `${LABEL} requires "source_site_id" in the request body for sites.clone.`,
    { details: { provider: PROVIDER, action: "create-site" } },
  );
}

interface RestoreTarget {
  readonly siteId: string;
  readonly backupId: string;
  readonly body: Record<string, unknown>;
}

function restoreBackupBody(
  targetEnvId: string,
  body: ActionBody,
): RestoreTarget {
  const record = objectBody(body);
  let siteId = targetEnvId;
  if ("site_id" in record) {
    siteId = formatValue(record.site_id);
    delete record.site_id;
  }
  let backupId = "";
  for (const key of ["backup_id", "id"]) {
    if (!(key in record)) continue;
    backupId = formatValue(record[key]);
    // `delete record[key]` is a dynamic delete; this is the same operation.
    Reflect.deleteProperty(record, key);
    break;
  }
  if (siteId === "" || siteId === "<nil>") {
    throw new CliError(
      "usage_error",
      `${LABEL} requires "site_id" or a target environment for backups.restore.`,
      { details: { provider: PROVIDER, action: "restore-backup" } },
    );
  }
  if (backupId === "" || backupId === "<nil>") {
    throw new CliError(
      "usage_error",
      `${LABEL} requires "backup_id" for backups.restore.`,
      { details: { provider: PROVIDER, action: "restore-backup" } },
    );
  }
  return { siteId, backupId, body: record };
}

function backupCreateBody(body: ActionBody): Record<string, unknown> {
  const record = objectBody(body);
  if (!("label" in record) && "tag" in record) {
    record.label = record.tag;
    delete record.tag;
  }
  if (!("label" in record)) {
    throw new CliError(
      "usage_error",
      `${LABEL} requires "label" (or --tag) for backups.create.`,
      { details: { provider: PROVIDER, action: "create-backup" } },
    );
  }
  return record;
}

function wpCliBody(body: ActionBody): Record<string, unknown> {
  const record = objectBody(body);
  if ("wp_command" in record)
    return { command: wpCliWithoutBinary(formatValue(record.wp_command)) };
  if ("command" in record) return record;
  throw new CliError(
    "usage_error",
    `${LABEL} requires "wp_command" or "command" for wp-cli.run.`,
    { details: { provider: PROVIDER, action: "run-wp-cli" } },
  );
}

/**
 * Go's `rocketNetDomainIDs`: every failure of the shared `domainIDsFromAny`
 * collapses into one message, so the specific reason is deliberately dropped.
 */
function domainIdsFrom(body: ActionBody): string[] {
  const ids = tryDomainIds(body);
  if (ids !== undefined) return ids;
  throw new CliError(
    "usage_error",
    `${LABEL} requires "domain_id", "id", or "domain_ids" for domains.delete.`,
    { details: { provider: PROVIDER, action: "delete-domains" } },
  );
}

function tryDomainIds(body: ActionBody): string[] | undefined {
  if (body === undefined || body === null) return undefined;
  if (!isRecord(body)) return undefined;
  if ("domain_ids" in body) {
    const value = body.domain_ids;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const ids = (value as unknown[]).map((entry) => formatValue(entry));
    return ids.some((id) => id === "" || id === "<nil>") ? undefined : ids;
  }
  for (const key of ["domain_id", "id"]) {
    if (!(key in body)) continue;
    const id = formatValue(body[key]);
    return id === "" || id === "<nil>" ? undefined : [id];
  }
  return undefined;
}

/** Go's `extractSiteID`. */
function extractSiteId(body: ActionBody): string {
  if (body === undefined || body === null || !isRecord(body)) return "";
  for (const key of ["site_id", "siteId", "id", "environment_id", "envId"])
    if (key in body) return formatValue(body[key]);
  return "";
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Go's `redactRocketNetSecrets`. Rocket.net returns generated WordPress admin
 * passwords, SFTP passwords, and API tokens inside otherwise useful payloads,
 * so a key that names a secret is replaced before the value ever reaches
 * stdout, a diagnostic, or the dashboard.
 */
function redactSecrets(value: unknown): unknown {
  let safe: unknown;
  if (Array.isArray(value)) safe = (value as unknown[]).map(redactSecrets);
  else if (isRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value))
      redacted[key] = isSecretKey(key) ? "redacted" : redactSecrets(child);
    safe = redacted;
  } else safe = value;
  registerSensitiveValues(safe, registeredSensitiveValues(value));
  return safe;
}

function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return (
    lowered.includes("password") ||
    lowered.includes("secret") ||
    lowered.includes("token") ||
    lowered.includes("private_key")
  );
}

/* -------------------------------------------------------------------------- */
/* Small value helpers                                                        */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Go's `flexString`, which accepts a JSON string or number for ids that
 * Rocket.net types inconsistently.
 *
 * Deviation: Go keeps the numeric literal verbatim through `json.Number`, while
 * `JSON.parse` has already turned it into a double, so an id beyond 2^53 would
 * lose precision. Rocket.net site ids are 10 digits. Go rejects a boolean here;
 * HQ maps it onto "1"/"0" rather than failing the whole site listing.
 */
function flexString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "";
}

/**
 * Go's `fmt.Sprint` for a decoded JSON value, including the `<nil>` rendering
 * the body helpers test for. Objects and arrays render as JSON rather than in
 * Go's `map[...]` syntax; neither is a valid id, so both are rejected the same.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "<nil>";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function firstNonEmpty(...candidates: readonly string[]): string {
  for (const candidate of candidates) if (candidate !== "") return candidate;
  return "";
}

/**
 * Deviation: Go uses `url.PathEscape`, which leaves `$ & + : = @` unescaped and
 * escapes `! ' ( ) *`. `encodeURIComponent` does the opposite for those seven
 * characters; it is strictly more conservative for everything that could split
 * a path, and Rocket.net ids are numeric or alphanumeric.
 */
function escapePath(value: string): string {
  return encodeURIComponent(value);
}

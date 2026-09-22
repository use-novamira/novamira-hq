// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pantheon Public API provider client, ported from
 * `internal/providers/pantheon.go`.
 *
 * Pantheon does not accept the machine token directly: every authenticated call
 * carries a short-lived session bearer obtained by posting the machine token to
 * `/v0/authorize/machine-token`. The Go client guards that exchange with a
 * mutex; here a single cached promise plays the same role, and the exchange is
 * wired through `dynamicAuth` so the shared `HttpClient` refreshes the header on
 * every request without any call site having to remember to.
 *
 * Two Pantheon-specific shapes leak into the provider-neutral model:
 *
 * - an environment id is `site_id:env_id`, because the Public API always needs
 *   both and the neutral `HostingEnvironment.id` is a single string;
 * - an operation id is `site_id:workflow_id`, for the same reason.
 *
 * `pantheonEnvRef` therefore accepts the composite form, or `site_id` carried
 * inside the request body, and strips the keys it consumed before the remaining
 * body is forwarded to Pantheon.
 *
 * Deviations from the Go source, each also marked where it occurs:
 *
 * - Error construction. Go returns `fmt.Errorf("Pantheon API request to %s
 *   failed with %d: %s", ...)` from every failure path; HQ raises `CliError`s
 *   from the shared taxonomy, and non-2xx HTTP responses are already mapped by
 *   `HttpClient` (404 to `not_found`, 401/403 to `credential_invalid`, ...).
 * - Body mutation. Go's payload helpers mutate the caller's `map[string]any` in
 *   place; the request unions here are `readonly`, so `objectBody` copies first.
 * - Environment ordering. Go ranges over a `map[string]pantheonEnvironment`, so
 *   `ListEnvironments` returns environments in a random order; `Object.entries`
 *   preserves the order the provider sent them, which is strictly better and is
 *   what the ported test asserts.
 * - Path escaping. Go uses `url.PathEscape`, HQ uses `encodeURIComponent`. The
 *   two differ only for characters (`$&+,;=@:`) that cannot appear in a Pantheon
 *   site name, environment name, workflow id, or domain.
 */

import { CliError } from "../../errors.js";
import type { ProviderKind } from "../../config/schema.js";
import {
  type ActionRequest,
  type ListSitesOptions,
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
  type ProviderCapability,
  type ProviderValidation,
  type Query,
  providerCapabilities,
} from "../types.js";

const PROVIDER: ProviderKind = "pantheon";

/** The `client` field Go sends with the machine-token exchange. */
const PANTHEON_CLIENT = "novamira";

/** Go's `fmt.Sprint(nil)`, which several payload helpers compare against. */
const NIL = "<nil>";

/** The three environments every Pantheon site has; anything else is multidev. */
const RESERVED_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "dev",
  "test",
  "live",
]);

const NOTE_ENV =
  "environment-scoped commands need --env site_id:env_id or site_id in --from-json";
const NOTE_NATIVE =
  "use --from-json with Pantheon-native fields for full control";
const NOTE_NOT_MAPPED = "not mapped for Pantheon in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by Pantheon's provider-neutral Novamira mapping";

/** Ported verbatim from `PantheonClient.capabilities`, order included. */
const CAPABILITIES: readonly ProviderCapability[] = providerCapabilities([
  "providers.validate",
  "providers.capabilities",
  ["sites.list", true, "uses GET /v0/users/{user_id}/memberships/sites"],
  "sites.get",
  "envs.list",
  "envs.get",
  [
    "ops.get",
    true,
    "uses site workflow status when operation id is site_id:workflow_id",
  ],
  [
    "ops.wait",
    true,
    "uses site workflow status when operation id is site_id:workflow_id",
  ],
  ["regions.list", false, NOTE_NOT_MAPPED],
  ["activity.list", false, NOTE_NOT_MAPPED],
  ["sites.create", true, `uses POST /v0/sites; ${NOTE_NATIVE}`],
  ["sites.create-plain", true, `uses POST /v0/sites; ${NOTE_NATIVE}`],
  ["sites.clone", false, NOTE_UNSUPPORTED],
  [
    "envs.create",
    true,
    `creates Pantheon multidev environments; ${NOTE_NATIVE}`,
  ],
  [
    "envs.create-plain",
    true,
    `creates Pantheon multidev environments; ${NOTE_NATIVE}`,
  ],
  ["envs.clone", true, "creates Pantheon multidev environments"],
  ["envs.push", false, NOTE_NOT_MAPPED],
  ["domains.list", true, NOTE_ENV],
  ["domains.add", true, NOTE_ENV],
  ["domains.primary", true, NOTE_ENV],
  ["dns.domains.list", false, NOTE_NOT_MAPPED],
  ["backups.list", true, NOTE_ENV],
  ["backups.downloadable", true, NOTE_ENV],
  ["backups.create", true, NOTE_ENV],
  ["backups.restore", true, NOTE_ENV],
  ["cache.clear", true, NOTE_ENV],
  ["php.restart", false, NOTE_NOT_MAPPED],
  ["php.set-version", false, NOTE_NOT_MAPPED],
  ["wp.plugins.list", false, NOTE_NOT_MAPPED],
  [
    "wp.plugins.install",
    false,
    "Pantheon remote WP-CLI is available through Terminus, not the Public API used by Novamira",
  ],
  ["wp.themes.list", false, NOTE_NOT_MAPPED],
  ["wp-cli.run", false, NOTE_NOT_MAPPED],
  ["logs.get", false, NOTE_NOT_MAPPED],
  ["analytics.usage", false, NOTE_NOT_MAPPED],
  [
    "analytics.env",
    true,
    "uses GET /v0/sites/{site_id}/environments/{env_id}/metrics",
  ],
]);

/** The cached result of one machine-token exchange. */
interface PantheonSession {
  readonly session: string;
  readonly userId: string;
}

/** A site/environment pair plus the request body with its keys consumed. */
interface PantheonEnvironmentRef {
  readonly siteId: string;
  readonly envId: string;
  readonly body: Record<string, unknown>;
}

export const createPantheonClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  // Go rejects an empty machine token in `newPantheonClientWith`. The length is
  // public metadata on `SecretValue`, so this check reveals nothing.
  if (context.secret.length === 0) {
    throw new CliError(
      "credential_missing",
      "The Pantheon machine token is required.",
      {
        details: { provider: PROVIDER, credential: context.credentialSource },
      },
    );
  }

  // Go's `PantheonClient.userID` is the profile's company id. HQ's context
  // already folds the (non-existent) Pantheon identity environment variable in,
  // so `companyId` and `identity` are the same value here.
  const configuredUserId = nonEmpty(context.companyId ?? context.identity);

  let sessionPromise: Promise<PantheonSession> | undefined;

  const http: HttpClient = context.createHttpClient({
    auth: dynamicAuth(async () => {
      const { session } = await ensureSession();
      return {
        headers: { authorization: `Bearer ${session}` },
        secrets: [session],
      };
    }),
  });

  /**
   * Go's `ensureSession`, with a cached promise instead of a mutex: concurrent
   * callers share one exchange, and a failure clears the cache so the next call
   * retries rather than replaying a stale rejection.
   */
  async function ensureSession(): Promise<PantheonSession> {
    sessionPromise ??= authorizeMachineToken();
    try {
      return await sessionPromise;
    } catch (error) {
      sessionPromise = undefined;
      throw error;
    }
  }

  async function authorizeMachineToken(): Promise<PantheonSession> {
    // The only place the credential is revealed: Pantheon's token exchange
    // carries it in the request body rather than in a header.
    const machineToken = context.secret.reveal();
    const response = await http.request({
      method: "POST",
      path: urlFor("/v0/authorize/machine-token"),
      body: jsonBody({ machine_token: machineToken, client: PANTHEON_CLIENT }),
      anonymous: true,
      secrets: [machineToken],
    });
    const payload = asRecord(response.data);
    const session = stringField(payload, "session") ?? "";
    if (session === "") {
      throw new CliError(
        "provider_error",
        "The Pantheon authorization response did not contain a session token.",
        { details: { provider: PROVIDER } },
      );
    }
    return { session, userId: stringField(payload, "user_id") ?? "" };
  }

  async function resolveUserId(requested?: string): Promise<string> {
    const explicit = nonEmpty(requested);
    if (explicit !== undefined) return explicit;
    if (configuredUserId !== undefined) return configuredUserId;
    const { userId } = await ensureSession();
    if (userId === "") {
      throw new CliError(
        "provider_error",
        "The Pantheon authorization response did not contain a user_id.",
        { details: { provider: PROVIDER } },
      );
    }
    return userId;
  }

  /**
   * Go's `urlFor`: the API root concatenated with the endpoint path.
   *
   * Deviation from the naive port: the request carries the absolute URL rather
   * than the bare path. `HttpClient` accepts either, but its relative join keeps
   * the trailing slash a root base URL always has (`https://api.pantheon.io`
   * normalizes to `.../`), which would send `//v0/sites`. Pantheon's default
   * base URL has no path segment, so it hits that case on every call.
   * The absolute form stays on the configured origin — the client rejects
   * anything else — and preserves a base URL that does carry a path prefix.
   */
  function urlFor(path: string): string {
    return `${context.baseUrl}${path}`;
  }

  /** Go's `readJSON`: the parsed body of a successful GET. */
  async function readJson(path: string, query?: Query): Promise<unknown> {
    const response = await http.request({
      method: "GET",
      path: urlFor(path),
      ...(query === undefined ? {} : { query }),
    });
    return response.data;
  }

  /**
   * Go's `resolveSiteID`: a value that is not already a UUID is looked up by
   * name, so `--site my-site` works everywhere a site id does.
   */
  async function resolveSiteId(siteId: string): Promise<string> {
    if (siteId === "" || looksLikeUuid(siteId)) return siteId;
    const lookup = asRecord(
      await readJson(`/v0/site-names/${segment(siteId)}`),
    );
    const id = stringField(lookup, "id") ?? "";
    if (id === "") {
      throw new CliError(
        "not_found",
        `The Pantheon site name lookup for "${siteId}" did not return an id.`,
        { details: { provider: PROVIDER, site: siteId } },
      );
    }
    return id;
  }

  async function listEnvironments(
    siteId: string,
  ): Promise<HostingEnvironment[]> {
    if (siteId === "") {
      throw new CliError(
        "usage_error",
        "A site id is required for Pantheon environment listing.",
        { details: { provider: PROVIDER } },
      );
    }
    const payload = asRecord(
      await readJson(`/v0/sites/${segment(siteId)}/environments`),
    );
    return Object.entries(payload).map(([key, value]) => {
      const environment = asRecord(value);
      const id = stringField(environment, "id") ?? "";
      return environmentToHosting(siteId, id === "" ? key : id, environment);
    });
  }

  async function listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const userId = await resolveUserId(options?.companyId);
    const includeEnvironments = options?.includeEnvironments ?? false;
    const payload = await readJson(
      `/v0/users/${segment(userId)}/memberships/sites`,
      [["limit", "100"]],
    );
    if (!Array.isArray(payload)) {
      throw new CliError(
        "provider_error",
        "The Pantheon site membership response was not a list.",
        { details: { provider: PROVIDER } },
      );
    }

    const sites: HostingSite[] = [];
    for (const entry of payload as readonly unknown[]) {
      const membership = asRecord(entry);
      const record = asRecord(membership.site);
      // Go falls back to the membership id when the embedded site has none.
      const id =
        nonEmpty(stringField(record, "id")) ??
        stringField(membership, "id") ??
        "";
      const site = siteToHosting(record, id, includeEnvironments);
      if (includeEnvironments && id !== "") {
        sites.push({ ...site, environments: await listEnvironments(id) });
      } else {
        sites.push(site);
      }
    }
    return sites;
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    const resolved = await resolveSiteId(siteId);
    const record = asRecord(await readJson(`/v0/sites/${segment(resolved)}`));
    // Go re-reads the id from the response and lets `ListEnvironments` reject an
    // empty one, rather than reusing the resolved id.
    const id = stringField(record, "id") ?? "";
    const environments = await listEnvironments(id);
    return { ...siteToHosting(record, id, true), environments };
  }

  async function validate(): Promise<ProviderValidation> {
    const userId = await resolveUserId();
    return {
      provider: PROVIDER,
      status: "active",
      companyId: userId,
      credential: context.credentialSource,
    };
  }

  /** Go's `sendAction`: one mutating call normalized into an `ActionResult`. */
  async function sendAction(
    action: string,
    method: HttpMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    siteId: string,
  ): Promise<ActionResult> {
    const response = await http.request({
      method,
      path: urlFor(path),
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    });
    const raw = response.data;

    let scope = siteId;
    if (action === "sites.create" && siteId !== "") {
      try {
        const resolved = await resolveSiteId(siteId);
        if (resolved !== "") scope = resolved;
      } catch {
        // Go ignores a failed post-create name lookup and keeps the site name.
      }
    }

    const workflowId = jsonStringField(raw, "id");
    const operationId =
      workflowId === undefined
        ? undefined
        : scope === ""
          ? workflowId
          : `${scope}:${workflowId}`;
    const message = jsonStringField(raw, "active_description");

    return {
      provider: PROVIDER,
      action,
      // Go reports the HTTP status here, not a status field from the body.
      status: response.status,
      ...(message === undefined ? {} : { message }),
      ...(operationId === undefined ? {} : { operationId }),
      raw,
    };
  }

  async function read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return CAPABILITIES;
      case "site-domains": {
        const ref = environmentRef(request.envId, undefined);
        return readJson(
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/domains`,
        );
      }
      // Pantheon has no separate downloadable-backup endpoint: both reads go to
      // the backup catalog, exactly as in Go.
      case "backups":
      case "downloadable-backups": {
        const ref = environmentRef(request.envId, undefined);
        return readJson(
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/backups/catalog`,
        );
      }
      case "analytics-env": {
        const ref = environmentRef(request.envId, undefined);
        // `metric` has no Pantheon counterpart; the caller selects the series
        // through the query string instead.
        return readJson(
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/metrics`,
          request.query,
        );
      }
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
      case "file-list":
        throw unsupportedReadRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  async function action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site": {
        if (request.mode === "clone") {
          throw unsupportedOperation(PROVIDER, "sites.clone");
        }
        // Pantheon provisions from an upstream, so the "wordpress" and "plain"
        // modes are the same request; the upstream comes from the body.
        const body = siteCreateBody(request.body);
        return sendAction(
          "sites.create",
          "POST",
          "/v0/sites",
          body,
          stringFromMap(body, "site_name"),
        );
      }
      case "create-environment": {
        // Every create mode makes a multidev environment; Go ignores the mode
        // and does not resolve the site name here either.
        const body = environmentCreateBody(request.body);
        return sendAction(
          "envs.create",
          "POST",
          `/v0/sites/${segment(request.siteId)}/environments`,
          body,
          request.siteId,
        );
      }
      case "add-domain": {
        const ref = environmentRef(request.envId, request.body);
        return sendAction(
          "domains.add",
          "POST",
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/domains`,
          domainBody(ref.body),
          ref.siteId,
        );
      }
      case "change-primary-domain": {
        const ref = environmentRef(request.envId, request.body);
        return sendAction(
          "domains.primary",
          "PUT",
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/domains/primary`,
          primaryDomainBody(ref.body),
          ref.siteId,
        );
      }
      case "create-backup": {
        const ref = environmentRef(request.envId, request.body);
        return sendAction(
          "backups.create",
          "POST",
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/backups`,
          backupCreateBody(ref.body),
          ref.siteId,
        );
      }
      case "restore-backup": {
        const restore = restoreBackupBody(request.targetEnvId, request.body);
        return sendAction(
          "backups.restore",
          "POST",
          `/v0/sites/${segment(restore.siteId)}/environments/${segment(restore.envId)}/backups/${segment(restore.backupId)}/restore`,
          restore.body,
          restore.siteId,
        );
      }
      case "clear-cache": {
        // `cache` is not mapped: Pantheon has one cache-clear endpoint, and the
        // environment always comes from the body because there is no env id on
        // this request variant.
        const ref = environmentRef("", request.body);
        return sendAction(
          "cache.clear",
          "POST",
          `/v0/sites/${segment(ref.siteId)}/environments/${segment(ref.envId)}/cache/clear`,
          cacheBody(ref.body),
          ref.siteId,
        );
      }
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
      case "setup-novamira":
        throw unsupportedActionRequest(PROVIDER, request);
      default:
        return assertNever(request);
    }
  }

  async function operationStatus(
    operationId: string,
  ): Promise<OperationStatus> {
    const separator = operationId.indexOf(":");
    const siteId = separator < 0 ? "" : operationId.slice(0, separator);
    const workflowId = separator < 0 ? "" : operationId.slice(separator + 1);
    if (siteId === "" || workflowId === "") {
      throw new CliError(
        "usage_error",
        "Pantheon requires an operation id in site_id:workflow_id form.",
        { details: { provider: PROVIDER, operationId } },
      );
    }

    const resolvedSiteId = await resolveSiteId(siteId);
    let raw: unknown;
    try {
      raw = await readJson(
        `/v0/sites/${segment(resolvedSiteId)}/workflows/${segment(workflowId)}`,
      );
    } catch (error) {
      // Go falls back to the user's workflow feed, and rethrows the original
      // site-scoped failure when the user id cannot be resolved.
      let userId: string;
      try {
        userId = await resolveUserId();
      } catch {
        throw error;
      }
      raw = await readJson(
        `/v0/users/${segment(userId)}/workflows/${segment(workflowId)}`,
      );
    }

    const reported = jsonStringField(raw, "result");
    const result =
      reported === undefined || reported === "" ? "running" : reported;
    const message = jsonStringField(raw, "active_description");
    return {
      provider: PROVIDER,
      operationId,
      // Go hard-codes 200: reaching here means the workflow read succeeded.
      status: 200,
      done: result === "succeeded" || result === "failed",
      failed: result === "failed",
      ...(message === undefined ? {} : { message }),
      raw,
    };
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
  };
};

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** Go's `pantheonSiteToHosting`. */
function siteToHosting(
  record: Readonly<Record<string, unknown>>,
  id: string,
  includeEnvironments: boolean,
): HostingSite {
  const name = stringField(record, "name") ?? "";
  const label = stringField(record, "label") ?? "";
  const site: HostingSite = {
    id,
    name,
    displayName: label === "" ? name : label,
    status: record.frozen === true ? "frozen" : "active",
  };
  // Go sets an empty slice so the field serializes as `[]`, then overwrites it.
  return includeEnvironments ? { ...site, environments: [] } : site;
}

/** Go's `pantheonEnvironmentToHosting`. */
function environmentToHosting(
  siteId: string,
  envId: string,
  record: Readonly<Record<string, unknown>>,
): HostingEnvironment {
  const reserved = RESERVED_ENVIRONMENTS.has(envId);
  const locked = asRecord(record.lock).locked === true;
  return {
    id: `${siteId}:${envId}`,
    name: envId,
    // Go uses `strings.Title`, which only ever sees "dev", "test" or "live".
    displayName: reserved
      ? envId.charAt(0).toUpperCase() + envId.slice(1)
      : envId,
    isBlocked: record.initialized !== true || locked,
    isPremium: !reserved,
    // Pantheon's Public API reports neither on an environment.
  };
}

/* -------------------------------------------------------------------------- */
/* Payload helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Go's `pantheonEnvRef`. Accepts `site_id:env_id`, a bare environment id with
 * `site_id` in the body, or (when the request variant carries no environment id
 * at all) both halves from the body. Consumed keys are removed from the body so
 * they are not forwarded to Pantheon.
 */
function environmentRef(envId: string, body: unknown): PantheonEnvironmentRef {
  const map = objectBody(body);
  let siteId = takeString(map, ["site_id", "siteId"]) ?? "";
  let resolvedEnvId = envId;
  if (resolvedEnvId === "") {
    resolvedEnvId =
      takeString(map, ["environment_id", "env_id", "envId", "id"]) ?? "";
  }

  const separator = resolvedEnvId.indexOf(":");
  if (separator >= 0) {
    if (siteId === "") siteId = resolvedEnvId.slice(0, separator);
    resolvedEnvId = resolvedEnvId.slice(separator + 1);
  }

  if (siteId === "" || siteId === NIL) {
    throw new CliError(
      "usage_error",
      "Pantheon requires site_id in the request body, or an environment reference of the form site_id:env_id.",
      { details: { provider: PROVIDER } },
    );
  }
  if (resolvedEnvId === "" || resolvedEnvId === NIL) {
    throw new CliError("usage_error", "Pantheon requires an environment id.", {
      details: { provider: PROVIDER, site: siteId },
    });
  }
  return { siteId, envId: resolvedEnvId, body: map };
}

/** Go's `pantheonSiteBody`. `name` is copied to `site_name`, not moved. */
function siteCreateBody(body: unknown): Record<string, unknown> {
  const map = objectBody(body);
  if (!Object.hasOwn(map, "label") && Object.hasOwn(map, "display_name")) {
    map.label = map.display_name;
    Reflect.deleteProperty(map, "display_name");
  }
  if (!Object.hasOwn(map, "site_name") && Object.hasOwn(map, "name")) {
    map.site_name = map.name;
  }
  return map;
}

/** Go's `pantheonCreateEnvBody`. */
function environmentCreateBody(body: unknown): Record<string, unknown> {
  const map = objectBody(body);
  if (!Object.hasOwn(map, "environment_name")) {
    for (const key of ["display_name", "name"]) {
      if (Object.hasOwn(map, key) && goSprint(map[key]) !== "") {
        map.environment_name = map[key];
        Reflect.deleteProperty(map, key);
        break;
      }
    }
  }
  if (!Object.hasOwn(map, "from_environment")) {
    if (Object.hasOwn(map, "source_env")) {
      map.from_environment = map.source_env;
      Reflect.deleteProperty(map, "source_env");
    } else {
      map.from_environment = "dev";
    }
  }
  if (!Object.hasOwn(map, "clone_database")) map.clone_database = true;
  if (!Object.hasOwn(map, "clone_files")) map.clone_files = true;
  return map;
}

/** Go's `pantheonDomainBody`. */
function domainBody(map: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(map, "domain") && Object.hasOwn(map, "domain_name")) {
    map.domain = map.domain_name;
    Reflect.deleteProperty(map, "domain_name");
  }
  if (!Object.hasOwn(map, "domain")) {
    throw new CliError(
      "usage_error",
      "Pantheon requires domain or domain_name.",
      { details: { provider: PROVIDER } },
    );
  }
  return map;
}

/** Go's `pantheonPrimaryDomainBody`. */
function primaryDomainBody(
  map: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(map, "domain")) {
    for (const key of ["domain_id", "domain_name", "id"]) {
      if (Object.hasOwn(map, key)) {
        map.domain = map[key];
        Reflect.deleteProperty(map, key);
        break;
      }
    }
  }
  if (!Object.hasOwn(map, "domain")) {
    throw new CliError(
      "usage_error",
      "Pantheon requires domain, domain_name, domain_id, or id.",
      { details: { provider: PROVIDER } },
    );
  }
  return map;
}

/** Go's `pantheonBackupCreateBody`. */
function backupCreateBody(
  map: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(map, "element")) map.element = "all";
  if (!Object.hasOwn(map, "keep_for")) map.keep_for = 30;
  // Pantheon rejects the neutral `tag` field.
  Reflect.deleteProperty(map, "tag");
  return map;
}

function restoreBackupBody(
  targetEnvId: string,
  body: unknown,
): PantheonEnvironmentRef & { readonly backupId: string } {
  const ref = environmentRef(targetEnvId, body);
  const backupId = takeString(ref.body, ["backup_id", "id"]) ?? "";
  if (backupId === "" || backupId === NIL) {
    throw new CliError("usage_error", "Pantheon requires backup_id or id.", {
      details: { provider: PROVIDER },
    });
  }
  if (!Object.hasOwn(ref.body, "element")) ref.body.element = "all";
  return { ...ref, backupId };
}

/** Go's `pantheonCacheBody`. */
function cacheBody(map: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(map, "framework_cache")) map.framework_cache = true;
  return map;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Go's `objectBody`. Go round-trips non-map values through JSON and fails when
 * the result is not an object; only arrays and scalars can reach that path from
 * a CLI-built body, and both are rejected here too.
 */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (isRecord(body)) return { ...body };
  throw new CliError(
    "usage_error",
    "The Pantheon request body must be a JSON object.",
    { details: { provider: PROVIDER } },
  );
}

/** Removes the first present key and returns Go's `fmt.Sprint` of its value. */
function takeString(
  map: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (Object.hasOwn(map, key)) {
      const value = map[key];
      Reflect.deleteProperty(map, key);
      return goSprint(value);
    }
  }
  return undefined;
}

/** Go's `pantheonStringFromMap`: the value, or "" when absent or nil. */
function stringFromMap(
  map: Readonly<Record<string, unknown>>,
  key: string,
): string {
  if (!Object.hasOwn(map, key)) return "";
  const value = goSprint(map[key]);
  return value === NIL ? "" : value;
}

/** Go's `fmt.Sprint` for the JSON values a request body can hold. */
function goSprint(value: unknown): string {
  if (value === undefined || value === null) return NIL;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Go's `jsonStringField`: the named field, only when it is a JSON string. */
function jsonStringField(raw: unknown, key: string): string | undefined {
  return isRecord(raw) ? stringField(raw, key) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON object, or an empty one — Go decodes a mismatched shape to its zero. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Go's `pantheonLooksLikeUUID`. */
function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value === "" ? undefined : value;
}

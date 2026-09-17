// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The InstaWP provider client, ported from `internal/providers/instawp.go`.
 *
 * InstaWP has no environment concept: a site *is* the environment. HQ therefore
 * synthesizes exactly one environment per site (`name: "site"`, with the site
 * id as its id) but exposes no environment-removal operation.
 *
 * Deviations from the Go source are marked `Deviation:` where they occur. The
 * structural ones:
 *
 * - Transport. Go hand-rolls `net/http` and turns every non-2xx into
 *   `InstaWP API request to %s failed with %d: %s`. HQ delegates to the shared
 *   `HttpClient`, which already maps status codes onto the `CliError` taxonomy
 *   (401/403 → `credential_invalid`, 404 → `not_found`, 429 → `rate_limited`,
 *   ...), redacts the bearer token from diagnostics, and applies the retry
 *   policy. Only InstaWP's *envelope-level* failure (HTTP 200 with
 *   `"status": false`) is raised by this module.
 * - Decoding. Go decodes into structs, so a type mismatch anywhere aborts the
 *   whole response with a decode error. HQ narrows field by field and treats an
 *   unusable field as absent, which is strictly more forgiving; the InstaWP API
 *   is inconsistent about numeric-vs-string ids and int-vs-bool flags, which is
 *   what Go's `flexString`/`intBool` custom unmarshalers exist for.
 */

import type { ProviderKind } from "../../config/schema.js";
import { instaWpVersions } from "./instawp-versions.js";
import { CliError } from "../../errors.js";
import {
  redactAssociatedText,
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../../output/redact.js";
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
  bearerAuth,
  jsonBody,
} from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderCapability,
  type ProviderValidation,
  type SiteCreateMode,
  providerCapabilities,
  providerLabel,
} from "../types.js";

const PROVIDER: ProviderKind = "instawp";
const LABEL = providerLabel(PROVIDER);

/** InstaWP's list endpoints are page-based; the Go client always asks for 100. */
const SITES_PER_PAGE = 100;

/** `instaWPRunCommandBody`'s default when the caller supplies no timeout. */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;

const TEMPLATE_CREATE_PATH = "/sites/template";
const PLAIN_CREATE_PATH = "/sites";

/** The synthetic environment's name, matching Go's `Name: "site"`. */
const SYNTHETIC_ENVIRONMENT_NAME = "site";

const NOTE_SINGLE_ENV =
  "InstaWP sites are exposed as one synthetic environment";
const NOTE_NOT_MAPPED = "not mapped for InstaWP in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by InstaWP's provider-neutral Novamira mapping";

/** `capabilities()`, in the Go declaration order — the list is documented output. */
const CAPABILITIES: readonly ProviderCapability[] = providerCapabilities([
  "providers.validate",
  "providers.capabilities",
  "sites.list",
  "sites.get",
  ["envs.list", true, NOTE_SINGLE_ENV],
  ["envs.get", true, NOTE_SINGLE_ENV],
  ["ops.get", true, "uses the InstaWP task status endpoint"],
  ["ops.wait", true, "uses the InstaWP task status endpoint"],
  ["regions.list", false, NOTE_NOT_MAPPED],
  ["activity.list", false, NOTE_NOT_MAPPED],
  [
    "sites.create",
    true,
    "uses POST /sites or POST /sites/template when template_slug is supplied",
  ],
  ["sites.create-plain", true, "uses POST /sites"],
  [
    "sites.clone",
    true,
    "uses POST /sites/template when template_slug is supplied",
  ],
  ["envs.create", false, NOTE_SINGLE_ENV],
  ["envs.create-plain", false, NOTE_SINGLE_ENV],
  ["envs.clone", false, NOTE_SINGLE_ENV],
  ["envs.push", false, NOTE_SINGLE_ENV],
  ["domains.list", false, NOTE_NOT_MAPPED],
  ["dns.domains.list", false, NOTE_NOT_MAPPED],
  ["backups.list", true, "lists restorable Site Versions"],
  ["backups.create", true, "creates a Site Version"],
  ["backups.restore", true, "restores a completed Site Version in place"],
  ["cache.clear", false, NOTE_UNSUPPORTED],
  ["php.restart", false, NOTE_UNSUPPORTED],
  ["php.set-version", false, NOTE_UNSUPPORTED],
  ["wp.plugins.list", false, NOTE_NOT_MAPPED],
  [
    "wp.plugins.install",
    true,
    "uses the InstaWP run-cmd endpoint for arbitrary WP-CLI commands",
  ],
  ["wp.themes.list", false, NOTE_NOT_MAPPED],
  [
    "wp-cli.run",
    true,
    "uses the InstaWP run-cmd endpoint; command_id remains supported for saved commands",
  ],
  ["logs.get", false, NOTE_NOT_MAPPED],
  ["analytics.usage", false, NOTE_NOT_MAPPED],
  ["analytics.env", false, NOTE_NOT_MAPPED],
]);

/** A prepared InstaWP request: the endpoint plus the JSON object to POST. */
interface InstaWpRequestPlan {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * Construct the InstaWP client. The registry wires this module by this name; it
 * reads nothing from the environment, the config, or credential storage.
 */
export const createInstaWpClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  // `reveal()` is called exactly here, to build the `Authorization` header. The
  // resulting token is registered as a secret with the HTTP client, which scrubs
  // it from every diagnostic and error message.
  const http: HttpClient = context.createHttpClient({
    auth: bearerAuth(context.secret.reveal()),
  });
  const versions = instaWpVersions(http);

  /** Go's `resolveTeamID`: the per-call team wins over the profile's. */
  function resolveTeamId(requested?: string): string | undefined {
    return requested ?? context.companyId;
  }

  async function validate(): Promise<ProviderValidation> {
    const envelope = await requireEnvelope("/teams", "validation");
    const teams = Array.isArray(envelope.data) ? envelope.data : [];
    const first = teams.length === 0 ? undefined : asRecord(teams[0]);
    // Go falls back to the first team's id only when the profile carries none.
    const teamId =
      context.companyId ??
      (first === undefined ? undefined : flexString(first.id));

    return {
      provider: PROVIDER,
      status: "active",
      companyId: teamId ?? null,
      credential: context.credentialSource,
    };
  }

  async function listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const includeEnvironments = options?.includeEnvironments ?? false;
    const teamId = resolveTeamId(options?.companyId);
    const sites: HostingSite[] = [];

    for (let page = 1; ;) {
      const query: [string, string][] = [
        ["page", String(page)],
        ["per_page", String(SITES_PER_PAGE)],
      ];
      if (teamId !== undefined && teamId !== "")
        query.push(["team_id", teamId]);

      const envelope = await requireEnvelope("/sites", "/sites", query);
      const data = Array.isArray(envelope.data) ? envelope.data : [];
      for (const entry of data)
        sites.push(toHostingSite(entry, includeEnvironments));

      const meta = asRecord(envelope.meta);
      if (meta === undefined || data.length === 0) break;
      const currentPage = integerField(meta.current_page);
      if (currentPage >= integerField(meta.last_page)) break;
      // Deviation: Go trusts `current_page` to advance, so a provider reply with
      // a stuck or absent `current_page` loops forever. Stop instead.
      if (currentPage + 1 <= page) break;
      page = currentPage + 1;
    }
    return sites;
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    const path = `/sites/${encodePathSegment(siteId)}`;
    const envelope = await requireEnvelope(path, path);
    return toHostingSite(envelope.data, true);
  }

  async function listEnvironments(
    siteId: string,
  ): Promise<HostingEnvironment[]> {
    if (siteId === "") {
      throw new CliError(
        "usage_error",
        `A site id is required to list ${LABEL} environments.`,
        { details: { provider: PROVIDER } },
      );
    }
    const site = await getSite(siteId);
    return site.environments === undefined ? [] : [...site.environments];
  }

  /**
   * InstaWP maps exactly one read request. Every other variant gets an explicit
   * `case` so a new union member fails to compile rather than silently becoming
   * "unsupported"; `default` is unreachable by construction.
   */
  function read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return Promise.resolve([...CAPABILITIES]);
      case "backups":
        return versions.list(request.envId);
      case "regions":
      case "activity":
      case "site-domains":
      case "site-domain-verification":
      case "dns-domains":
      case "dns-records":
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
        return Promise.reject(unsupportedReadRequest(PROVIDER, request));
      default:
        return assertNever(request);
    }
  }

  function action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site":
        return createSite(request.mode, request.body);
      case "run-wp-cli":
        return runWpCli(request.envId, request.body);
      case "create-backup":
        return versions.create(request.envId, request.body);
      case "restore-backup":
        return versions.restore(request.targetEnvId, request.body);
      case "create-environment":
      case "push-environment":
      case "clear-cache":
      case "restart-php":
      case "set-php-version":
      case "add-domain":
      case "change-primary-domain":
      case "update-plugin":
      case "bulk-update-plugins":
      case "update-theme":
      case "bulk-update-themes":
      case "set-denied-ips":
      case "apply-redirects":
      case "setup-novamira":
        return Promise.reject(unsupportedActionRequest(PROVIDER, request));
      default:
        return assertNever(request);
    }
  }

  async function createSite(
    mode: SiteCreateMode,
    body: unknown,
  ): Promise<ActionResult> {
    const plan = siteCreatePlan(mode, body);
    const name =
      plan.path === TEMPLATE_CREATE_PATH
        ? "sites.clone"
        : mode === "plain"
          ? "sites.create-plain"
          : "sites.create";
    return await sendAction(name, "POST", plan.path, plan.body);
  }

  async function runWpCli(envId: string, body: unknown): Promise<ActionResult> {
    const plan = commandPlan(envId, body);
    return await sendAction("wp-cli.run", "POST", plan.path, plan.body);
  }

  async function sendAction(
    name: string,
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ActionResult> {
    const response = await http.request({
      path,
      method,
      ...(body === undefined ? {} : { body: jsonBody(body) }),
    });
    // Go reports the HTTP status verbatim here — unlike `buildActionResult`,
    // which prefers a numeric `status` field from the body. InstaWP's `status`
    // is a boolean, so there is nothing to prefer.
    return buildActionResult(name, response.status, response.data);
  }

  async function operationStatus(
    operationId: string,
  ): Promise<OperationStatus> {
    if (operationId.startsWith("version-task:"))
      return versions.status(operationId);
    const path = `/tasks/${encodePathSegment(operationId)}/status`;
    const response = await http.request({ path });
    // Deviation: Go returns the task body verbatim. HQ redacts it the same way
    // it redacts an action body, because a task payload can carry the freshly
    // provisioned site's `wp_password` / `s_hash`, and HQ never emits a
    // provider secret.
    const raw = redactSecrets(response.data);
    const record = asRecord(raw);
    const data = record === undefined ? undefined : asRecord(record.data);
    const statusText =
      data !== undefined && typeof data.status === "string"
        ? data.status.toLowerCase()
        : "";
    const reportedOk = record?.status === true;
    const message = stringField(raw, "message");

    return {
      provider: PROVIDER,
      operationId,
      status: response.status,
      done:
        statusText !== "" &&
        statusText !== "progress" &&
        statusText !== "pending" &&
        statusText !== "queued",
      failed:
        !reportedOk ||
        statusText.includes("fail") ||
        statusText.includes("error"),
      ...(message === undefined ? {} : { message }),
      raw,
    };
  }

  /**
   * GET an envelope endpoint and enforce InstaWP's `"status": true` contract.
   * `subject` is what the Go error message names — the path everywhere except
   * `Validate`, which says "validation".
   */
  async function requireEnvelope(
    path: string,
    subject: string,
    query?: readonly (readonly [string, string])[],
  ): Promise<Record<string, unknown>> {
    const data = await http.json({
      path,
      ...(query === undefined ? {} : { query }),
    });
    const record = asRecord(data);
    if (record?.status !== true) {
      const error = new CliError(
        "provider_error",
        redactAssociatedText(
          `The ${LABEL} API reported a failure for ${subject}: ${fallbackMessage(stringField(record, "message"))}`,
          data,
        ),
        { details: { provider: PROVIDER, path } },
      );
      registerSensitiveValues(error, registeredSensitiveValues(data));
      throw error;
    }
    return record;
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
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Go's `instaWPSiteCreateBody`: promote `display_name` / `site_title` to
 * `site_name`, then pick the template endpoint when a `template_slug` is
 * present. Cloning without a template slug, and creating without a site name,
 * are usage errors.
 */
function siteCreatePlan(
  mode: SiteCreateMode,
  body: unknown,
): InstaWpRequestPlan {
  const payload = objectBody(body);
  if (!("site_name" in payload)) {
    const displayName = payload.display_name;
    const siteTitle = payload.site_title;
    if (typeof displayName === "string" && displayName !== "")
      payload.site_name = displayName;
    else if (typeof siteTitle === "string" && siteTitle !== "")
      payload.site_name = siteTitle;
  }
  if ("template_slug" in payload)
    return { path: TEMPLATE_CREATE_PATH, body: payload };
  if (mode === "clone") {
    throw new CliError(
      "usage_error",
      `${LABEL} requires template_slug to clone a site.`,
      { details: { provider: PROVIDER, action: "sites.clone" } },
    );
  }
  if (!("site_name" in payload)) {
    throw new CliError(
      "usage_error",
      `${LABEL} requires site_name to create a site.`,
      { details: { provider: PROVIDER, action: "sites.create" } },
    );
  }
  return { path: PLAIN_CREATE_PATH, body: payload };
}

/**
 * Go's `instaWPCommandRequest`. A saved command (`command_id`) goes to
 * `execute-command`; a single `wp_command` / `command` is wrapped into the
 * `run-cmd` batch shape; an explicit `commands` array is passed through with a
 * default timeout. InstaWP's run-cmd endpoint takes the full command *including*
 * the `wp` binary token, so `wpCliWithoutBinary` is deliberately not applied.
 */
function commandPlan(envId: string, body: unknown): InstaWpRequestPlan {
  const payload = objectBody(body);
  const site = `/sites/${encodePathSegment(envId)}`;

  if ("command_id" in payload)
    return { path: `${site}/execute-command`, body: payload };

  for (const key of ["wp_command", "command"] as const) {
    if (!(key in payload)) continue;
    return {
      path: `${site}/run-cmd`,
      body: runCommandBody(commandText(payload[key], key), payload),
    };
  }

  if ("commands" in payload) {
    if (!("timeout_seconds" in payload))
      payload.timeout_seconds = DEFAULT_COMMAND_TIMEOUT_SECONDS;
    return { path: `${site}/run-cmd`, body: payload };
  }

  throw new CliError(
    "usage_error",
    `${LABEL} requires wp_command, command, commands, or command_id to run WP-CLI.`,
    { details: { provider: PROVIDER, action: "wp-cli.run" } },
  );
}

function runCommandBody(
  command: string,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return {
    commands: [command],
    timeout_seconds:
      "timeout_seconds" in source
        ? source.timeout_seconds
        : DEFAULT_COMMAND_TIMEOUT_SECONDS,
  };
}

/**
 * Deviation: Go renders the command with `fmt.Sprint`, so a non-string value
 * would be sent to a command-executing endpoint as its Go formatting
 * (`map[...]`, `<nil>`). HQ refuses instead — the endpoint runs shell commands
 * on the customer's site, and "[object Object]" is never what was meant.
 */
function commandText(value: unknown, key: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new CliError(
    "usage_error",
    `${LABEL} requires ${key} to be a string.`,
    {
      details: { provider: PROVIDER, action: "wp-cli.run", field: key },
    },
  );
}

/**
 * Go's `objectBody`. Deviation: the object is copied rather than mutated in
 * place, so shaping a request never rewrites the caller's payload.
 */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body === "object" && !Array.isArray(body))
    return { ...(body as Record<string, unknown>) };
  throw new CliError(
    "usage_error",
    `The ${LABEL} request body must be a JSON object.`,
    { details: { provider: PROVIDER } },
  );
}

/**
 * Go uses `url.PathEscape`, which leaves a handful of sub-delimiters unescaped.
 * `encodeURIComponent` escapes a superset of them, and both escape `/`, so an
 * id can never break out of its path segment.
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/* -------------------------------------------------------------------------- */
/* Response shaping                                                           */
/* -------------------------------------------------------------------------- */

function buildActionResult(
  name: string,
  status: number,
  raw: unknown,
): ActionResult {
  const sanitized = redactSecrets(raw);
  const message = stringField(sanitized, "message");
  const operationId = extractOperationId(sanitized);
  return {
    provider: PROVIDER,
    action: name,
    status,
    ...(message === undefined ? {} : { message }),
    ...(operationId === undefined ? {} : { operationId }),
    raw: sanitized,
  };
}

/**
 * Go's `instaWPOperationID`: a top-level `operation_id` / `task_id` string, else
 * `data.task_id` / `data.cloud_task_id` as either a string or a number.
 *
 * Deviation: a JSON `null` under `data.task_id` yields no operation id here. Go
 * unmarshals `null` into a `json.Number` without error and returns an empty
 * string, which then surfaces as `"operation_id": ""`.
 */
function extractOperationId(raw: unknown): string | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  for (const key of ["operation_id", "task_id"] as const) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const data = asRecord(record.data);
  if (data === undefined) return undefined;
  for (const key of ["task_id", "cloud_task_id"] as const) {
    const value = data[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

/**
 * Go's `redactInstaWPSecrets`. InstaWP embeds the freshly provisioned site's
 * WordPress password and magic-login hash in ordinary success payloads, so the
 * raw body is walked and every secret-shaped key replaced before it can reach
 * stdout, a log, or the dashboard. Deviation: the walk copies instead of
 * mutating the parsed body in place.
 */
function redactSecrets(value: unknown): unknown {
  let safe: unknown;
  if (Array.isArray(value)) safe = value.map((child) => redactSecrets(child));
  else if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source))
      redacted[key] = isSecretKey(key) ? "redacted" : redactSecrets(child);
    safe = redacted;
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
    lower === "s_hash" ||
    lower.includes("login_hash")
  );
}

/** Go's `instaWPSiteToHosting`, plus the `instaWPSite` accessor methods. */
function toHostingSite(
  value: unknown,
  includeEnvironment: boolean,
): HostingSite {
  const record = asRecord(value) ?? {};
  const id = flexString(record.id);
  const displayName = siteDisplayName(record, id);
  const primaryDomain = sitePrimaryDomain(record);
  const wordpressVersion =
    typeof record.wp_version === "string" ? record.wp_version : undefined;

  const environment: HostingEnvironment = {
    id,
    name: SYNTHETIC_ENVIRONMENT_NAME,
    displayName,
    isBlocked: flexBool(record.is_expired) || flexBool(record.is_suspended),
    isPremium: false,
    ...(wordpressVersion === undefined ? {} : { wordpressVersion }),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
  };

  return {
    id,
    name: siteName(record, id),
    displayName,
    status: siteStatus(record),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
    ...(includeEnvironment ? { environments: [environment] } : {}),
  };
}

function siteName(record: Record<string, unknown>, id: string): string {
  const name = stringField(record, "name");
  if (name !== undefined && name !== "") return name;
  const subDomain = stringField(record, "sub_domain");
  if (subDomain !== undefined && subDomain !== "") return subDomain;
  return id;
}

function siteDisplayName(record: Record<string, unknown>, id: string): string {
  for (const key of ["label", "name", "url"] as const) {
    const value = stringField(record, key);
    if (value !== undefined && value !== "") return value;
  }
  return id;
}

function siteStatus(record: Record<string, unknown>): string {
  const deletedAt = stringField(record, "deleted_at");
  if (deletedAt !== undefined && deletedAt !== "") return "deleted";
  if (flexBool(record.is_suspended)) return "suspended";
  if (flexBool(record.is_expired)) return "expired";
  return "active";
}

function sitePrimaryDomain(
  record: Record<string, unknown>,
): string | undefined {
  const domain = stringField(record, "domain");
  if (domain !== undefined && domain !== "") return domain;
  const url = stringField(record, "url");
  if (url !== undefined && url !== "") {
    // Go's `url.Parse` accepts a bare host as a *path* and reports an empty
    // Host, so only an absolute URL contributes a domain. `new URL` rejects the
    // bare host outright, which lands on the same answer.
    const host = parseHost(url);
    if (host !== undefined) return host;
  }
  const subDomain = stringField(record, "sub_domain");
  if (subDomain !== undefined && subDomain !== "") return subDomain;
  return undefined;
}

function parseHost(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return parsed.host === "" ? undefined : parsed.host;
}

/* -------------------------------------------------------------------------- */
/* JSON narrowing                                                             */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Go's `jsonStringField`: the value only when it is a JSON string. */
function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * Go's `flexString`: InstaWP returns ids as numbers on some endpoints and as
 * strings on others. Deviation: a JSON number reaches this function already
 * parsed, so an id beyond `Number.MAX_SAFE_INTEGER` or written in exponent
 * notation renders from the parsed double rather than from the source literal.
 */
function flexString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Go's `intBool`: `0`/`1`, `"0"`/`"1"`, `"yes"`/`"no"`, and real booleans. */
function flexBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "" || text === "false" || text === "0" || text === "no")
      return false;
    if (text === "true" || text === "1" || text === "yes") return true;
    const parsed = Number.parseInt(text, 10);
    return Number.isNaN(parsed) ? false : parsed !== 0;
  }
  return false;
}

/** Go decodes `meta` fields as `int`; an unusable value counts as zero. */
function integerField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function fallbackMessage(message: string | undefined): string {
  return message === undefined || message === "" ? "(no message)" : message;
}

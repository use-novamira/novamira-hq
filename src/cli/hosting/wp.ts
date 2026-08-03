// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting wp`, `hosting wp-cli`, `hosting logs` and `hosting analytics`,
 * ported from the `newWpCommand` / `newWpCliCommand` / `newLogsCommand` /
 * `newAnalyticsCommand` trees in `internal/cli/hosting.go` plus the plugin
 * install orchestration in `internal/cli/wp_install.go`.
 *
 * Three things about the shape of this file.
 *
 * 1. Go built `plugins` and `themes` from one `newWpAssetCommand(flags, use,
 *    plugins bool)` helper and branched on the boolean at every dispatch. HQ
 *    keeps the shared builder but carries {@link WpAssetKind} — a two-member
 *    union — instead of a bare bool, so the branches are exhaustive `switch`es
 *    that cannot be passed the wrong way round. The handler interface therefore
 *    has three asset-parameterised methods rather than six near-duplicates.
 * 2. Nothing here writes to stdout. Each command body returns a
 *    {@link RenderedResult} and `runHostingCommand` renders it through the one
 *    envelope, so `--json` is handled in exactly one place.
 * 3. Go validated `--file` and `--metric` inside `RunE` with `validateEnum`;
 *    HQ keeps the validation in the handler (via {@link requireEnum}) rather
 *    than moving it into a commander parser, so a value that reaches a handler
 *    from anywhere is checked and the failure is a `usage_error` envelope
 *    instead of a bare parse message.
 *
 * `wp plugins install` is the only command in the group that does more than one
 * provider round trip. It reproduces Go's sequence exactly: resolve and
 * optionally validate `--source`, run a DB-backed WP-CLI preflight, dispatch the
 * install, wait for the operation, then activate the plugin in a second WP-CLI
 * call when the provider lets HQ observe WP-CLI results. Resolving
 * `--source novamira-latest` and `--validate-source` are the only outbound
 * requests HQ makes to a host that is not a hosting provider; both go through
 * the injectable `fetch` seam on {@link createWpHandlers} so contract tests stay
 * offline.
 */

import { posix } from "node:path";

import type { Command } from "commander";

import { CliError, asCliError } from "../../errors.js";
import {
  assertNever,
  wpCliResultsObservable,
  type ActionRequest,
  type ProviderClient,
  type ReadRequest,
} from "../../hosting/client.js";
import type { OperationStatus } from "../../hosting/types.js";
import type { CommandDependencies } from "../commands.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  addFromJsonOption,
  addPollingOptions,
  collect,
  parseUnsignedInteger,
  requireEnum,
} from "../flags.js";
import {
  operationFailure,
  runHostingCommand,
  waitForOperationStatus,
  type HostingOptions,
} from "../hosting-command.js";
import {
  jsonPointerLookupString,
  requireOption,
  type CommandIo,
  type JsonValue,
} from "../inputs.js";
import {
  buildQuery,
  shellJoin,
  wpAssetUpdateAllPayload,
  wpAssetUpdatePayload,
  wpCliCommandPayload,
  wpCliPayload,
  wpPluginActivateCommand,
  wpPluginInstallPayload,
  type WpAssetKind,
  type WpAssetUpdateAllOptions,
  type WpAssetUpdateOptions,
  type WpCliRunOptions,
  type WpPluginInstallOptions,
} from "../payloads.js";
import { renderAction, renderOperation, renderRaw } from "../print.js";
import type { RenderedResult } from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Go's `--file` enum for `hosting logs get`. */
const LOG_FILES = ["error", "access", "kinsta-cache-perf"] as const;

/** Go's `--file` default. */
const DEFAULT_LOG_FILE: (typeof LOG_FILES)[number] = "error";

/** Go's `--lines` default. */
const DEFAULT_LOG_LINES = 1000;

/** Go's `--metric` enum for `hosting analytics usage`. */
const USAGE_METRICS = ["visits", "bandwidth", "cdn-bandwidth"] as const;

/** Go's `--metric` enum for `hosting analytics env`. */
const ENV_METRICS = [
  "cdn-bandwidth",
  "visits",
  "bandwidth",
  "diskspace",
  "top-countries",
  "top-cities",
  "top-client-ips",
  "visits-dispersion",
  "response-codes",
] as const;

/** The metric whose query carries a `time_zone` even when none was given. */
const DISKSPACE_METRIC = "diskspace";

/** Go's default `time_zone` for the `diskspace` metric. */
const DEFAULT_DISKSPACE_TIME_ZONE = "00:00";

/** Go's `--time-span` default. */
const DEFAULT_ANALYTICS_TIME_SPAN = "7_days";

/** `--source` alias resolving to the newest Novamira plugin zip. */
const NOVAMIRA_LATEST_SOURCE_ALIAS = "novamira-latest";

/** The pre-alias URL, still accepted and resolved the same way. */
const NOVAMIRA_LEGACY_ZIP_URL =
  "https://github.com/use-novamira/novamira/releases/latest/download/novamira.zip";

/** Where the alias is resolved from. Overridable so tests stay offline. */
const NOVAMIRA_LATEST_RELEASE_API =
  "https://api.github.com/repos/use-novamira/novamira/releases/latest";

/** Asset names that count as "the Novamira plugin zip". */
const NOVAMIRA_ZIP_ASSET = /^novamira(?:-[0-9][A-Za-z0-9._-]*)?\.zip$/;

/** The WP-CLI command the preflight runs, and the one its hint runs. */
const PREFLIGHT_COMMAND = "wp option get siteurl";
const PREFLIGHT_HINT_COMMAND = "wp config get DB_HOST";

/** The hint Go appends when a failed preflight looks like a socket problem. */
const DB_HOST_LOCALHOST_HINT =
  "; DB_HOST is localhost, which can make WP-CLI use a missing MySQL socket on some hosts. Set DB_HOST to 127.0.0.1 or the provider's TCP database host, then retry";

/* -------------------------------------------------------------------------- */
/* Command options                                                            */
/* -------------------------------------------------------------------------- */

/** `hosting wp <plugins|themes> list`. */
interface WpAssetListOptions {
  readonly env?: string;
  /** `--company`: list the company-wide catalogue instead of an environment. */
  readonly company?: boolean;
}

/** `hosting wp <plugins|themes> update`. */
interface WpAssetUpdateCommandOptions extends WpAssetUpdateOptions {
  readonly env?: string;
}

/** `hosting wp <plugins|themes> update-all`. */
interface WpAssetUpdateAllCommandOptions extends WpAssetUpdateAllOptions {
  readonly env?: string;
}

/** `hosting wp plugins install`. */
interface WpPluginInstallCommandOptions extends WpPluginInstallOptions {
  readonly env?: string;
  /** Run a DB-backed WP-CLI preflight before installing. Defaults to true. */
  readonly preflight?: boolean;
  /** HEAD-check a remote `--source` zip before installing. Defaults to true. */
  readonly validateSource?: boolean;
  /** Wait for the provider operation to complete. Defaults to true. */
  readonly wait?: boolean;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

/** `hosting wp-cli run`. */
interface WpCliRunCommandOptions extends WpCliRunOptions {
  readonly env?: string;
}

/** `hosting logs get`. */
interface LogsGetOptions {
  readonly env?: string;
  readonly file?: string;
  readonly lines?: number;
}

/** `hosting analytics usage`. */
interface AnalyticsUsageOptions {
  readonly site?: string;
  readonly metric?: string;
}

/** `hosting analytics env`. */
interface AnalyticsEnvOptions {
  readonly env?: string;
  readonly metric?: string;
  readonly timeSpan?: string;
  readonly company?: string;
  readonly from?: string;
  readonly to?: string;
  /** Present exactly when `--time-zone` was given (Go's `Flags().Changed`). */
  readonly timeZone?: string;
}

/* -------------------------------------------------------------------------- */
/* Handler interface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The WordPress-asset, WP-CLI, logs and analytics handlers. `asset` stands in
 * for Go's `plugins bool`, so `plugins` and `themes` share one implementation
 * exactly as they shared `newWpAssetCommand`.
 */
export interface WpHandlers {
  /** `hosting wp <plugins|themes> list`. */
  wpAssetList(
    asset: WpAssetKind,
    options: WpAssetListOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp <plugins|themes> update`. */
  wpAssetUpdate(
    asset: WpAssetKind,
    options: WpAssetUpdateCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp <plugins|themes> update-all`. */
  wpAssetUpdateAll(
    asset: WpAssetKind,
    options: WpAssetUpdateAllCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp plugins install`. */
  wpPluginInstall(
    options: WpPluginInstallCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp-cli run`. */
  wpCliRun(
    options: WpCliRunCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting logs get`. */
  logsGet(options: LogsGetOptions, globals: HostingOptions): Promise<void>;
  /** `hosting analytics usage`. */
  analyticsUsage(
    options: AnalyticsUsageOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting analytics env`. */
  analyticsEnv(
    options: AnalyticsEnvOptions,
    globals: HostingOptions,
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Provider request selection                                                 */
/* -------------------------------------------------------------------------- */

function assetListRequest(
  asset: WpAssetKind,
  options: WpAssetListOptions,
): ReadRequest {
  if (options.company === true) {
    // Go passes `CompanyID: nil`, leaving the profile's company to the client.
    switch (asset) {
      case "plugins":
        return { kind: "company-plugins" };
      case "themes":
        return { kind: "company-themes" };
      default:
        return assertNever(asset);
    }
  }
  const envId = requireOption(options.env, "--env");
  switch (asset) {
    case "plugins":
      return { kind: "plugins", envId };
    case "themes":
      return { kind: "themes", envId };
    default:
      return assertNever(asset);
  }
}

function assetUpdateRequest(
  asset: WpAssetKind,
  envId: string,
  body: JsonValue,
): ActionRequest {
  switch (asset) {
    case "plugins":
      return { kind: "update-plugin", envId, body };
    case "themes":
      return { kind: "update-theme", envId, body };
    default:
      return assertNever(asset);
  }
}

function assetUpdateAllRequest(
  asset: WpAssetKind,
  envId: string,
  body: JsonValue,
): ActionRequest {
  switch (asset) {
    case "plugins":
      return { kind: "bulk-update-plugins", envId, body };
    case "themes":
      return { kind: "bulk-update-themes", envId, body };
    default:
      return assertNever(asset);
  }
}

/* -------------------------------------------------------------------------- */
/* WP-CLI output extraction                                                   */
/* -------------------------------------------------------------------------- */

/** Where providers put the textual result of a WP-CLI run, in Go's order. */
const WP_CLI_OUTPUT_POINTERS = [
  "/data/result",
  "/data/output",
  "/data",
  "/result/response",
  "/result/output",
  "/result",
  "/output",
  "/response",
] as const;

/** The pointers whose value may instead be a list of per-command results. */
const WP_CLI_OUTPUT_LIST_POINTERS = ["/data", "/result"] as const;

/** The keys a list entry may carry its output under. */
const WP_CLI_OUTPUT_KEYS = ["output", "result", "response"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/**
 * Go's `pointerValue`, for the two list-shaped pointers only. Neither `/data`
 * nor `/result` contains an RFC 6901 escape, so token decoding — which
 * {@link jsonPointerLookupString} still performs for the string lookups — is
 * not repeated here.
 */
function pointerValue(value: unknown, pointer: string): unknown {
  let current: unknown = value;
  for (const token of pointer.slice(1).split("/")) {
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[token];
  }
  return current;
}

/** Go's `unwrapWpCliOutputString`: a JSON document smuggled inside a string. */
function unwrapWpCliOutputString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
  for (const pointer of ["/data", "/output", "/response"]) {
    const found = jsonPointerLookupString(parsed, pointer);
    if (found !== undefined) return found;
  }
  return value;
}

/** Go's `wpCliOutputFromArray`. */
function wpCliOutputFromArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const entries = value as readonly unknown[];
  const parts: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    for (const key of WP_CLI_OUTPUT_KEYS) {
      const text = record[key];
      if (typeof text === "string" && text.trim() !== "") {
        parts.push(text);
        break;
      }
    }
  }
  return parts.join("\n");
}

/**
 * Go's `wpCliOutput` (`internal/cli/hosting_novamira.go`): the textual result
 * of a WP-CLI operation, wherever the provider chose to put it. Phase 5's
 * provisioning module needs the same extraction; when it lands, this becomes
 * the obvious thing to lift into a shared module.
 */
function wpCliOutput(raw: unknown): string {
  for (const pointer of WP_CLI_OUTPUT_POINTERS) {
    const found = jsonPointerLookupString(raw, pointer);
    if (found !== undefined) return unwrapWpCliOutputString(found);
  }
  for (const pointer of WP_CLI_OUTPUT_LIST_POINTERS) {
    const found = wpCliOutputFromArray(pointerValue(raw, pointer));
    if (found !== "") return found;
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Plugin source resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `fetch` the plugin-source helpers use. Declaring it locally
 * keeps the seam small enough for a test to supply a literal, and keeps the
 * helpers honest about issuing nothing but a GET and a HEAD.
 */
type HttpFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** Seams for {@link createWpHandlers}; production supplies none. */
interface WpCommandOverrides {
  /** Defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Defaults to {@link NOVAMIRA_LATEST_RELEASE_API}. */
  readonly latestReleaseApi?: string;
}

function absoluteUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    // Go required both a scheme and a host; `plugin:name` has neither host nor
    // a meaningful path, and must fall through to the plain-slug branch.
    return url.host === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/**
 * Go's `inferPluginInstallSlug`: the plugin slug HQ may activate after an
 * install, or `""` when the source does not identify one.
 */
function inferPluginInstallSlug(source: string): string {
  if (source === "") return "";
  if (
    source === NOVAMIRA_LATEST_SOURCE_ALIAS ||
    source === NOVAMIRA_LEGACY_ZIP_URL
  )
    return "novamira";
  if (source.includes("github.com/use-novamira/novamira/")) return "novamira";
  const url = absoluteUrl(source);
  if (url !== undefined)
    return NOVAMIRA_ZIP_ASSET.test(posix.basename(url.pathname))
      ? "novamira"
      : "";
  if (/[/:\\]/.test(source) || source.endsWith(".zip")) return "";
  return source;
}

interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

function releaseAssets(release: unknown): readonly ReleaseAsset[] {
  const record = asRecord(release);
  const raw = record?.assets;
  if (!Array.isArray(raw)) return [];
  const entries = raw as readonly unknown[];
  const assets: ReleaseAsset[] = [];
  for (const entry of entries) {
    const asset = asRecord(entry);
    if (asset === undefined) continue;
    const name = asset.name;
    const url = asset.browser_download_url;
    if (typeof name === "string" && typeof url === "string" && url !== "")
      assets.push({ name, url });
  }
  return assets;
}

function releaseTag(release: unknown): string {
  const tag = asRecord(release)?.tag_name;
  return typeof tag === "string" ? tag : "";
}

/** Go's `resolveNovamiraLatestZip`. */
async function resolveNovamiraLatestZip(
  http: HttpFetch,
  apiUrl: string,
): Promise<string> {
  let response;
  try {
    response = await http(apiUrl, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (error) {
    throw new CliError(
      "network_error",
      `Failed to resolve the ${NOVAMIRA_LATEST_SOURCE_ALIAS} plugin source.`,
      { retryable: true, cause: error, details: { source: apiUrl } },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "network_error",
      `Failed to resolve the ${NOVAMIRA_LATEST_SOURCE_ALIAS} plugin source: GitHub returned ${String(response.status)}.`,
      { retryable: true, details: { source: apiUrl, status: response.status } },
    );
  }
  let release: unknown;
  try {
    release = await response.json();
  } catch (error) {
    throw new CliError(
      "schema_validation_failed",
      `Failed to parse the ${NOVAMIRA_LATEST_SOURCE_ALIAS} release metadata.`,
      { cause: error, details: { source: apiUrl } },
    );
  }

  let fallback = "";
  for (const asset of releaseAssets(release)) {
    if (asset.name === "novamira.zip") return asset.url;
    if (fallback === "" && NOVAMIRA_ZIP_ASSET.test(asset.name))
      fallback = asset.url;
  }
  if (fallback !== "") return fallback;
  const tag = releaseTag(release);
  throw new CliError(
    "not_found",
    tag === ""
      ? "The latest Novamira release does not include a novamira zip asset."
      : `The latest Novamira release ${tag} does not include a novamira zip asset.`,
    { details: { source: apiUrl } },
  );
}

/** Go's `resolvePluginInstallSource`. */
async function resolvePluginInstallSource(
  source: string,
  http: HttpFetch,
  apiUrl: string,
): Promise<string> {
  if (
    source === NOVAMIRA_LATEST_SOURCE_ALIAS ||
    source === NOVAMIRA_LEGACY_ZIP_URL
  )
    return resolveNovamiraLatestZip(http, apiUrl);
  return source;
}

/** Go's `validateRemotePluginInstallSource`: a HEAD check, never a download. */
async function validateRemotePluginInstallSource(
  source: string,
  http: HttpFetch,
): Promise<void> {
  if (!source.startsWith("https://") && !source.startsWith("http://")) return;
  let response;
  try {
    response = await http(source, { method: "HEAD" });
  } catch (error) {
    throw new CliError(
      "network_error",
      `Failed to validate the plugin source ${source}.`,
      { retryable: true, cause: error, details: { source } },
    );
  }
  // Some hosts refuse HEAD outright; Go treated that as "not a verdict".
  if (response.status === 405) return;
  if (response.status < 200 || response.status >= 400) {
    throw new CliError(
      "not_found",
      `The plugin source ${source} is not downloadable: HTTP ${String(response.status)}.`,
      { details: { source, status: response.status } },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin install orchestration                                               */
/* -------------------------------------------------------------------------- */

interface PollBudget {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
}

/** Which plugin HQ activates in a follow-up WP-CLI call, if any. */
interface ActivationPlan {
  readonly slug: string;
  readonly network: boolean;
}

function pollBudget(options: WpPluginInstallCommandOptions): PollBudget {
  return {
    intervalSeconds: options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
  };
}

/**
 * Go's `wpPluginInstallActivationPlan`. A `--from-json` body or an InstaWP
 * saved command is opaque to HQ, so neither can be followed by an activation;
 * nor can a source whose slug cannot be inferred.
 */
function installActivationPlan(
  options: WpPluginInstallCommandOptions,
): ActivationPlan | undefined {
  if (options.fromJson !== undefined && options.fromJson !== "")
    return undefined;
  if (options.commandId !== undefined && options.commandId !== 0)
    return undefined;
  const activate = options.activate ?? true;
  const network = options.activateNetwork ?? false;
  if (!activate && !network) return undefined;
  const slug = inferPluginInstallSlug(options.source ?? "");
  if (slug === "") return undefined;
  return { slug, network };
}

/** Go's `wpPluginInstallPreflightApplies`. */
function installPreflightApplies(body: JsonValue): boolean {
  const record = asRecord(body);
  if (record === undefined) return false;
  return (
    Object.hasOwn(record, "wp_command") && !Object.hasOwn(record, "command_id")
  );
}

/**
 * Go's `wpPluginInstallPreparedPayload`. When HQ can see WP-CLI results and is
 * going to wait anyway, activation is deferred to its own command so that a
 * silent activation failure inside the install run cannot be mistaken for
 * success.
 */
async function preparedInstallPayload(
  options: WpPluginInstallCommandOptions,
  canObserveWpCli: boolean,
  io: CommandIo,
): Promise<{ readonly body: JsonValue; readonly activation?: ActivationPlan }> {
  const activation = installActivationPlan(options);
  const defer =
    activation !== undefined && (options.wait ?? true) && canObserveWpCli;
  const body = await wpPluginInstallPayload(
    defer ? { ...options, activate: false, activateNetwork: false } : options,
    io,
  );
  return activation === undefined ? { body } : { body, activation };
}

/** Re-raise `error` with `prefix` in front of its message, keeping its code. */
function contextualize(error: unknown, prefix: string): CliError {
  const cause = asCliError(error);
  return new CliError(cause.code, `${prefix}: ${cause.message}`, {
    retryable: cause.retryable,
    cause: error,
    ...(cause.remoteCode === undefined ? {} : { remoteCode: cause.remoteCode }),
    ...(cause.details === undefined ? {} : { details: cause.details }),
  });
}

/**
 * Go's `runWpCliCommandAndWait`. `undefined` means the provider answered
 * synchronously and there is no operation to poll.
 */
async function runWpCliAndWait(
  client: ProviderClient,
  envId: string,
  command: string,
  budget: PollBudget,
): Promise<OperationStatus | undefined> {
  const result = await client.action({
    kind: "run-wp-cli",
    envId,
    body: wpCliCommandPayload(command),
  });
  if (result.operationId === undefined) {
    if (result.status >= 400) {
      throw new CliError(
        "provider_error",
        `Provider returned status ${String(result.status)}: ${result.message ?? "request failed"}`,
        { details: { provider: result.provider, status: result.status } },
      );
    }
    return undefined;
  }
  return waitForOperationStatus(client, result.operationId, budget);
}

/** Go's `wpCliPreflightHint`: the DB_HOST tell, or nothing. */
async function preflightHint(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<string> {
  let status: OperationStatus | undefined;
  try {
    status = await runWpCliAndWait(
      client,
      envId,
      PREFLIGHT_HINT_COMMAND,
      budget,
    );
  } catch {
    return "";
  }
  if (status === undefined || status.failed) return "";
  return wpCliOutput(status.raw).trim() === "localhost"
    ? DB_HOST_LOCALHOST_HINT
    : "";
}

/** Go's `preflightWpCliForPluginInstall`. */
async function preflightWpCli(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<void> {
  let status: OperationStatus | undefined;
  try {
    status = await runWpCliAndWait(client, envId, PREFLIGHT_COMMAND, budget);
  } catch (error) {
    throw contextualize(error, "WP-CLI preflight failed before plugin install");
  }
  if (!status?.failed) return;
  const hint = await preflightHint(client, envId, budget);
  throw new CliError(
    "provider_error",
    `WP-CLI preflight failed before plugin install: ${status.message ?? "provider reported failure"}${hint}`,
    {
      details: {
        provider: status.provider,
        operationId: status.operationId,
        status: status.status,
      },
    },
  );
}

/** Go's `installedPluginIsActive`. */
async function installedPluginIsActive(
  client: ProviderClient,
  envId: string,
  activation: ActivationPlan,
  budget: PollBudget,
): Promise<boolean> {
  const command = shellJoin(["wp", "plugin", "status", activation.slug]);
  let status: OperationStatus | undefined;
  try {
    status = await runWpCliAndWait(client, envId, command, budget);
  } catch (error) {
    throw contextualize(error, "Failed to check plugin status after install");
  }
  if (status === undefined) return false;
  if (status.failed) {
    throw new CliError(
      "provider_error",
      `Plugin status operation ${status.operationId} failed after install: ${status.message ?? "provider reported failure"}`,
      {
        details: {
          provider: status.provider,
          operationId: status.operationId,
          status: status.status,
        },
      },
    );
  }
  const result = wpCliOutput(status.raw);
  if (activation.network) return result.includes("Status: Network Active");
  return (
    result.includes("Status: Active") ||
    result.includes("Status: Network Active")
  );
}

/**
 * Go's `activateInstalledPluginIfNeeded`. `undefined` means no activation was
 * needed, or the provider answered synchronously and there is no operation to
 * report instead of the install's own.
 */
async function activateInstalledPlugin(
  client: ProviderClient,
  envId: string,
  activation: ActivationPlan,
  budget: PollBudget,
): Promise<OperationStatus | undefined> {
  if (await installedPluginIsActive(client, envId, activation, budget))
    return undefined;
  const command = wpPluginActivateCommand(activation.slug, activation.network);
  let status: OperationStatus | undefined;
  try {
    status = await runWpCliAndWait(client, envId, command, budget);
  } catch (error) {
    throw contextualize(error, "Plugin activation failed after install");
  }
  if (status?.failed === true) {
    throw new CliError(
      "provider_error",
      `Plugin activation operation ${status.operationId} failed after install: ${status.message ?? "provider reported failure"}`,
      {
        details: {
          provider: status.provider,
          operationId: status.operationId,
          status: status.status,
        },
      },
    );
  }
  return status;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

export function createWpHandlers(
  dependencies: CommandDependencies,
  overrides: WpCommandOverrides = {},
): WpHandlers {
  const http: HttpFetch =
    overrides.fetch ?? ((input, init) => fetch(input, init));
  const latestReleaseApi =
    overrides.latestReleaseApi ?? NOVAMIRA_LATEST_RELEASE_API;

  const runInstall = async (
    client: ProviderClient,
    io: CommandIo,
    options: WpPluginInstallCommandOptions,
  ): Promise<RenderedResult> => {
    // Go resolves and validates --source before it demands --env, so a typo in
    // the source is reported first regardless of the other options.
    let resolved = options.source ?? "";
    if (resolved !== "") {
      resolved = await resolvePluginInstallSource(
        resolved,
        http,
        latestReleaseApi,
      );
      if (options.validateSource ?? true)
        await validateRemotePluginInstallSource(resolved, http);
    }
    const effective: WpPluginInstallCommandOptions =
      resolved === "" ? options : { ...options, source: resolved };

    const envId = requireOption(options.env, "--env");
    const budget = pollBudget(options);
    const canObserveWpCli = wpCliResultsObservable(client);
    const { body, activation } = await preparedInstallPayload(
      effective,
      canObserveWpCli,
      io,
    );

    if (
      (options.preflight ?? true) &&
      canObserveWpCli &&
      installPreflightApplies(body)
    )
      await preflightWpCli(client, envId, budget);

    const result = await client.action({ kind: "run-wp-cli", envId, body });

    const activateIfPlanned = async (): Promise<
      OperationStatus | undefined
    > => {
      if (activation === undefined || !canObserveWpCli) return undefined;
      return activateInstalledPlugin(client, envId, activation, budget);
    };

    if ((options.wait ?? true) && result.operationId !== undefined) {
      const status = await waitForOperationStatus(
        client,
        result.operationId,
        budget,
      );
      if (status.failed) throw operationFailure(status);
      const activated = await activateIfPlanned();
      return renderOperation(activated ?? status);
    }

    const activated = await activateIfPlanned();
    return activated === undefined
      ? renderAction(result)
      : renderOperation(activated);
  };

  return {
    wpAssetList: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderRaw(await client.read(assetListRequest(asset, options))),
      ),

    wpAssetUpdate: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpAssetUpdatePayload(options, io);
        // Go passes `--env` through unchecked here; an empty id reaches the
        // provider and is reported by it.
        const envId = options.env ?? "";
        return renderAction(
          await client.action(assetUpdateRequest(asset, envId, body)),
        );
      }),

    wpAssetUpdateAll: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpAssetUpdateAllPayload(options, asset, io);
        const envId = options.env ?? "";
        return renderAction(
          await client.action(assetUpdateAllRequest(asset, envId, body)),
        );
      }),

    wpPluginInstall: (options, globals) =>
      runHostingCommand(dependencies, globals, ({ client, io }) =>
        runInstall(client, io, options),
      ),

    wpCliRun: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpCliPayload(options, io);
        return renderAction(
          await client.action({
            kind: "run-wp-cli",
            envId: options.env ?? "",
            body,
          }),
        );
      }),

    logsGet: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const fileName = requireEnum(
          options.file ?? DEFAULT_LOG_FILE,
          "--file",
          LOG_FILES,
        );
        return renderRaw(
          await client.read({
            kind: "logs",
            envId: options.env ?? "",
            fileName,
            lines: options.lines ?? DEFAULT_LOG_LINES,
          }),
        );
      }),

    analyticsUsage: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const metric = options.metric ?? "";
        // Go only validates a non-empty metric: the provider picks its own
        // default when none is asked for.
        if (metric !== "") requireEnum(metric, "--metric", USAGE_METRICS);
        return renderRaw(
          await client.read({
            kind: "analytics-usage",
            siteId: options.site ?? "",
            metric,
          }),
        );
      }),

    analyticsEnv: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const metric = options.metric ?? "";
        if (metric !== "") requireEnum(metric, "--metric", ENV_METRICS);
        // Go read `Flags().Changed("time-zone")`; an option with no default is
        // `undefined` exactly when it was not given, so `--time-zone ""` still
        // counts as given and still resolves to "omit it" through buildQuery.
        const timeZone =
          metric === DISKSPACE_METRIC
            ? (options.timeZone ?? DEFAULT_DISKSPACE_TIME_ZONE)
            : options.timeZone;
        const query = buildQuery([
          ["time_span", options.timeSpan ?? DEFAULT_ANALYTICS_TIME_SPAN],
          ["company_id", options.company],
          ["from", options.from],
          ["to", options.to],
          ["time_zone", timeZone],
        ]);
        return renderRaw(
          await client.read({
            kind: "analytics-env",
            envId: options.env ?? "",
            metric,
            query,
          }),
        );
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Commander invokes an action handler with the declared arguments, then the
 * command's own options, then the command itself. None of these commands takes
 * a positional argument, so every handler below is `(options, command)` and
 * `optionsFor([command])` resolves the globals exactly as `program.ts` does.
 */

function registerAssetCommands(
  parent: Command,
  asset: WpAssetKind,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const noun = asset === "plugins" ? "plugin" : "theme";
  const group = parent
    .command(asset)
    .description(`${asset} operations on a provider environment`);

  group
    .command("list")
    .description(`list ${asset}`)
    .option("--env <id>", "environment id")
    .option("--company", "list the company-wide catalogue instead", false)
    .action(async (options: WpAssetListOptions, command: Command) =>
      handlers.wpAssetList(asset, options, optionsFor([command])),
    );

  if (asset === "plugins") registerPluginInstall(group, handlers, optionsFor);

  const update = group
    .command("update")
    .description(`update one ${noun}`)
    .option("--env <id>", "environment id")
    .option("--name <name>", `${noun} slug`)
    .option("--update-version <version>", `${noun} version to update to`);
  addFromJsonOption(update).action(
    async (options: WpAssetUpdateCommandOptions, command: Command) =>
      handlers.wpAssetUpdate(asset, options, optionsFor([command])),
  );

  const updateAll = group
    .command("update-all")
    .description(`update several ${asset} in one request`)
    .option("--env <id>", "environment id")
    .option("--name <name>", `${noun} slug (repeatable)`, collect, []);
  addFromJsonOption(updateAll).action(
    async (options: WpAssetUpdateAllCommandOptions, command: Command) =>
      handlers.wpAssetUpdateAll(asset, options, optionsFor([command])),
  );
}

function registerPluginInstall(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const install = parent
    .command("install")
    .description("install a plugin through the provider's WP-CLI endpoint")
    .option("--env <id>", "environment id")
    .option(
      "--source <source>",
      `plugin slug, local zip path, or remote zip URL (${NOVAMIRA_LATEST_SOURCE_ALIAS} resolves to the newest Novamira release)`,
    )
    .option("--plugin-version <version>", "WordPress.org plugin version")
    .option("--force", "overwrite an already installed plugin", false)
    .option("--activate", "activate the plugin after installing", true)
    .option("--no-activate", "do not activate the plugin after installing")
    .option("--activate-network", "network activate after installing", false)
    .option(
      "--ignore-requirements",
      "ignore WordPress or PHP version requirements",
      false,
    )
    .option(
      "--command-id <id>",
      "InstaWP saved command id to run instead of a built command",
      parseUnsignedInteger,
      0,
    )
    .option("--preflight", "run a DB-backed WP-CLI preflight first", true)
    .option("--no-preflight", "skip the WP-CLI preflight")
    .option("--validate-source", "check a remote zip URL first", true)
    .option("--no-validate-source", "do not check a remote zip URL")
    .option("--wait", "wait for the provider operation to complete", true)
    .option("--no-wait", "return as soon as the provider accepts the request");
  addPollingOptions(addFromJsonOption(install)).action(
    async (options: WpPluginInstallCommandOptions, command: Command) =>
      handlers.wpPluginInstall(options, optionsFor([command])),
  );
}

function registerWpCliCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const wpCli = parent.command("wp-cli").description("WP-CLI operations");
  const run = wpCli
    .command("run")
    .description("run a WP-CLI command on an environment")
    .option("--env <id>", "environment id")
    .option("--command <command>", "the WP-CLI command line to run")
    .option(
      "--command-stdin",
      "read the WP-CLI command line from stdin",
      false,
    );
  addFromJsonOption(run).action(
    async (options: WpCliRunCommandOptions, command: Command) =>
      handlers.wpCliRun(options, optionsFor([command])),
  );
}

function registerLogsCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const logs = parent.command("logs").description("log operations");
  logs
    .command("get")
    .description("read an environment log file")
    .option("--env <id>", "environment id")
    .option("--file <name>", LOG_FILES.join("|"), DEFAULT_LOG_FILE)
    .option(
      "--lines <count>",
      "number of trailing lines to read",
      parseUnsignedInteger,
      DEFAULT_LOG_LINES,
    )
    .action(async (options: LogsGetOptions, command: Command) =>
      handlers.logsGet(options, optionsFor([command])),
    );
}

function registerAnalyticsCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const analytics = parent
    .command("analytics")
    .description("analytics operations");

  analytics
    .command("usage")
    .description("site usage analytics")
    .option("--site <id>", "site id")
    .option("--metric <metric>", USAGE_METRICS.join("|"))
    .action(async (options: AnalyticsUsageOptions, command: Command) =>
      handlers.analyticsUsage(options, optionsFor([command])),
    );

  analytics
    .command("env")
    .description("environment analytics")
    .option("--env <id>", "environment id")
    .option("--metric <metric>", ENV_METRICS.join("|"))
    .option(
      "--time-span <span>",
      "provider time span",
      DEFAULT_ANALYTICS_TIME_SPAN,
    )
    .option("--company <id>", "company id")
    .option("--from <from>", "range start, as the provider expects it")
    .option("--to <to>", "range end, as the provider expects it")
    .option(
      "--time-zone <offset>",
      `time zone offset (defaults to ${DEFAULT_DISKSPACE_TIME_ZONE} for the ${DISKSPACE_METRIC} metric)`,
    )
    .action(async (options: AnalyticsEnvOptions, command: Command) =>
      handlers.analyticsEnv(options, optionsFor([command])),
    );
}

/**
 * Attach `wp`, `wp-cli`, `logs` and `analytics` to `parent` — the `hosting`
 * command in the assembled program.
 */
export function registerWpCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const wp = parent.command("wp").description("WordPress asset operations");
  registerAssetCommands(wp, "plugins", handlers, optionsFor);
  registerAssetCommands(wp, "themes", handlers, optionsFor);
  registerWpCliCommands(parent, handlers, optionsFor);
  registerLogsCommands(parent, handlers, optionsFor);
  registerAnalyticsCommands(parent, handlers, optionsFor);
}

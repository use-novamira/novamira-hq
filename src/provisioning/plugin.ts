// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything between "the operator named a plugin source" and "the plugin is
 * active on the environment", ported from `internal/cli/wp_install.go` plus
 * `wpPluginInstallCommand` / `wpPluginActivateCommand` in
 * `internal/cli/payloads.go`.
 *
 * Resolving `--source novamira-latest` and HEAD-checking a remote zip are the
 * only outbound requests HQ makes to a host that is neither a hosting provider
 * nor the site being provisioned, and both go through the injected
 * {@link HttpFetch} seam so contract tests stay offline. The HEAD check is a
 * check, never a download: HQ does not fetch the zip, the provider does.
 *
 * Activation is a separate WP-CLI call rather than `wp plugin install
 * --activate`. Go made that choice for `hosting wp plugins install` whenever it
 * could observe WP-CLI results and was going to wait anyway, and setup inherits
 * it unconditionally, because a plugin that installs but fails to activate
 * inside one provider operation is indistinguishable from success. Splitting
 * the two makes the failure observable, at the cost of one extra round trip.
 *
 * This was `src/cli/hosting/wp.ts`'s private machinery. It moves here because
 * the provisioning service — which Phase 6's dashboard calls directly, with no
 * commander in the graph — needs all of it, and `src/provisioning/` may not
 * import `src/cli/`. `wp.ts` and `payloads.ts` now import from here.
 */

import { posix } from "node:path";

import { CliError } from "../errors.js";
import type { ProviderClient } from "../hosting/client.js";
import { shellJoin } from "../hosting/shell.js";
import type { OperationStatus } from "../hosting/types.js";
import { asRecord } from "../json.js";
import type { HttpFetch } from "./http.js";
import {
  contextualize,
  runWpCli,
  wpCliOutput,
  type PollBudget,
} from "./wp-cli.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The plugin HQ provisions. */
export const NOVAMIRA_PLUGIN_SLUG = "novamira";

/** `--source` alias resolving to the newest Novamira plugin zip. */
export const NOVAMIRA_LATEST_SOURCE_ALIAS = "novamira-latest";

/** The pre-alias URL, still accepted and resolved the same way. */
export const NOVAMIRA_LEGACY_ZIP_URL =
  "https://github.com/use-novamira/novamira/releases/latest/download/novamira.zip";

/** Where the alias is resolved from. Overridable so tests stay offline. */
export const NOVAMIRA_LATEST_RELEASE_API =
  "https://api.github.com/repos/use-novamira/novamira/releases/latest";

/** Asset names that count as "the Novamira plugin zip". */
export const NOVAMIRA_ZIP_ASSET = /^novamira(?:-[0-9][A-Za-z0-9._-]*)?\.zip$/;

/** The WP-CLI command the preflight runs, and the one its hint runs. */
export const PREFLIGHT_COMMAND = "wp option get siteurl";
export const PREFLIGHT_HINT_COMMAND = "wp config get DB_HOST";

/** The hint Go appends when a failed preflight looks like a socket problem. */
export const DB_HOST_LOCALHOST_HINT =
  "; DB_HOST is localhost, which can make WP-CLI use a missing MySQL socket on some hosts. Set DB_HOST to 127.0.0.1 or the provider's TCP database host, then retry";

/* -------------------------------------------------------------------------- */
/* Source resolution                                                          */
/* -------------------------------------------------------------------------- */

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
export function inferPluginSlug(source: string): string {
  if (source === "") return "";
  if (
    source === NOVAMIRA_LATEST_SOURCE_ALIAS ||
    source === NOVAMIRA_LEGACY_ZIP_URL
  )
    return NOVAMIRA_PLUGIN_SLUG;
  if (source.includes("github.com/use-novamira/novamira/"))
    return NOVAMIRA_PLUGIN_SLUG;
  const url = absoluteUrl(source);
  if (url !== undefined)
    return NOVAMIRA_ZIP_ASSET.test(posix.basename(url.pathname))
      ? NOVAMIRA_PLUGIN_SLUG
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
export async function resolvePluginSource(
  source: string,
  http: HttpFetch,
  latestReleaseApi: string,
): Promise<string> {
  if (
    source === NOVAMIRA_LATEST_SOURCE_ALIAS ||
    source === NOVAMIRA_LEGACY_ZIP_URL
  )
    return resolveNovamiraLatestZip(http, latestReleaseApi);
  return source;
}

/** Go's `validateRemotePluginInstallSource`: a HEAD check, never a download. */
export async function validateRemotePluginSource(
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
/* Command lines                                                              */
/* -------------------------------------------------------------------------- */

/** The flags that shape a generated `wp plugin install` line. */
export interface PluginInstallCommandOptions {
  readonly pluginVersion?: string;
  readonly force?: boolean;
  readonly activate?: boolean;
  readonly activateNetwork?: boolean;
  readonly ignoreRequirements?: boolean;
}

/** The `wp plugin install ...` command line, quoted for a provider WP-CLI API. */
export function pluginInstallCommand(
  source: string,
  options: PluginInstallCommandOptions,
): string {
  const parts = ["wp", "plugin", "install", source];
  // The WP-CLI flag inside the generated command line keeps its own name; only
  // HQ's own option was renamed.
  if (options.pluginVersion !== undefined && options.pluginVersion !== "")
    parts.push(`--version=${options.pluginVersion}`);
  if (options.force === true) parts.push("--force");
  if (options.ignoreRequirements === true) parts.push("--ignore-requirements");
  if (options.activateNetwork === true) parts.push("--activate-network");
  else if (options.activate === true) parts.push("--activate");
  return shellJoin(parts);
}

/** The `wp plugin activate ...` command line used after a waited install. */
export function pluginActivateCommand(slug: string, network: boolean): string {
  const parts = ["wp", "plugin", "activate", slug];
  if (network) parts.push("--network");
  return shellJoin(parts);
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

/** Go's `wpPluginInstallPreflightApplies`. */
export function installPreflightApplies(body: unknown): boolean {
  const record = asRecord(body);
  if (record === undefined) return false;
  return (
    Object.hasOwn(record, "wp_command") && !Object.hasOwn(record, "command_id")
  );
}

/**
 * Go's `wpCliPreflightHint`: the DB_HOST tell, or nothing. A failure to read
 * DB_HOST is never itself fatal — the hint is a courtesy on top of a failure
 * that is already being reported.
 */
async function preflightHint(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<string> {
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(client, envId, PREFLIGHT_HINT_COMMAND, budget);
  } catch {
    return "";
  }
  if (status === undefined || status.failed) return "";
  return wpCliOutput(status.raw).trim() === "localhost"
    ? DB_HOST_LOCALHOST_HINT
    : "";
}

/**
 * Go's `preflightWpCliForPluginInstall`. A DB-backed WP-CLI read that proves
 * the provider's WP-CLI endpoint can actually reach WordPress before HQ asks it
 * to install anything.
 */
export async function preflightWpCli(
  client: ProviderClient,
  envId: string,
  budget: PollBudget,
): Promise<void> {
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(client, envId, PREFLIGHT_COMMAND, budget);
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

/* -------------------------------------------------------------------------- */
/* Activation                                                                 */
/* -------------------------------------------------------------------------- */

/** Which plugin HQ activates in a follow-up WP-CLI call, if any. */
export interface ActivationPlan {
  readonly slug: string;
  readonly network: boolean;
}

/**
 * Go's `installedPluginIsActive`. The output is matched as a substring and is
 * deliberately NOT echo-stripped: `wp plugin status` prints a block, and the
 * line HQ looks for is inside it rather than at the top.
 */
export async function installedPluginIsActive(
  client: ProviderClient,
  envId: string,
  activation: ActivationPlan,
  budget: PollBudget,
): Promise<boolean> {
  const command = shellJoin(["wp", "plugin", "status", activation.slug]);
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(client, envId, command, budget);
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
 * Activate unconditionally, having already established that the plugin is not
 * active. `undefined` means the provider answered synchronously and there is no
 * operation to report instead of the install's own.
 *
 * Split out of {@link activateInstalledPlugin} so the provisioning service can
 * tell "was already active" from "activated now" — it reports the two
 * differently — without issuing a second `wp plugin status`.
 */
export async function activatePlugin(
  client: ProviderClient,
  envId: string,
  activation: ActivationPlan,
  budget: PollBudget,
): Promise<OperationStatus | undefined> {
  const command = pluginActivateCommand(activation.slug, activation.network);
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(client, envId, command, budget);
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

/**
 * Go's `activateInstalledPluginIfNeeded`. `undefined` means no activation was
 * needed, or the provider answered synchronously and there is no operation to
 * report instead of the install's own.
 */
export async function activateInstalledPlugin(
  client: ProviderClient,
  envId: string,
  activation: ActivationPlan,
  budget: PollBudget,
): Promise<OperationStatus | undefined> {
  if (await installedPluginIsActive(client, envId, activation, budget))
    return undefined;
  return activatePlugin(client, envId, activation, budget);
}

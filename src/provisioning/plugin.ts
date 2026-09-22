// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything between "the operator named a plugin source" and "the plugin is
 * active on the environment", ported from `internal/cli/wp_install.go` plus
 * `wpPluginInstallCommand` / `wpPluginActivateCommand` in
 * `internal/cli/payloads.go`.
 *
 * `--source novamira-latest` resolves locally to Novamira's canonical download
 * endpoint. HEAD-checking that endpoint (or another explicitly supplied remote
 * source) is the only outbound request HQ makes to a host that is neither a
 * hosting provider nor the site being provisioned, and it goes through the
 * injected {@link HttpFetch} seam so contract tests stay offline. The HEAD
 * check is a check, never a download: HQ does not fetch the zip, the provider
 * does.
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
import { redactAssociatedText, redactText } from "../output/redact.js";
import { discardBody, type HttpFetch, type HttpResponse } from "./http.js";
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

/** The sole canonical download source for released Novamira plugin builds. */
export const NOVAMIRA_DOWNLOAD_URL =
  "https://license.dynamic.ooo/api/novamira/download";

/** Asset names that count as "the Novamira plugin zip". */
export const NOVAMIRA_ZIP_ASSET = /^novamira(?:-[0-9][A-Za-z0-9._-]*)?\.zip$/;
/** Outbound plugin-source checks have one bounded request/read budget. */
export const PLUGIN_SOURCE_TIMEOUT_MS = 10_000;

/** The WP-CLI command the preflight runs, and the one its hint runs. */
export const PREFLIGHT_COMMAND = "wp option get siteurl";
export const PREFLIGHT_HINT_COMMAND = "wp config get DB_HOST";

/** The hint Go appends when a failed preflight looks like a socket problem. */
export const DB_HOST_LOCALHOST_HINT =
  "; DB_HOST is localhost, which can make WP-CLI use a missing MySQL socket on some hosts. Set DB_HOST to 127.0.0.1 or the provider's TCP database host, then retry";

/** The hint appended when a failed install turns out to be a re-run. */
export const ALREADY_INSTALLED_HINT =
  "; the plugin is already installed, and `wp plugin install` refuses to overwrite it. Re-run with --force to reinstall over it";

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
    source === NOVAMIRA_DOWNLOAD_URL
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

function pluginRequestTimeout(source: string): CliError {
  return new CliError(
    "timeout",
    `Timed out reading the plugin source ${redactText(source)}.`,
    { retryable: true, details: { source } },
  );
}

async function boundedPluginRequest(
  http: HttpFetch,
  source: string,
  init: { readonly method?: string; readonly headers?: Record<string, string> },
  parentSignal?: AbortSignal,
): Promise<{ readonly response: HttpResponse; readonly signal: AbortSignal }> {
  parentSignal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(PLUGIN_SOURCE_TIMEOUT_MS);
  const signal =
    parentSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([parentSignal, timeoutSignal]);
  try {
    const response = await http(source, {
      ...init,
      redirect: "manual",
      signal,
    });
    return { response, signal };
  } catch (error) {
    if (parentSignal?.aborted === true) throw parentSignal.reason;
    if (timeoutSignal.aborted) throw pluginRequestTimeout(source);
    throw error;
  }
}

async function refusePluginRedirect(
  response: HttpResponse,
  source: string,
): Promise<void> {
  if (response.status < 300 || response.status >= 400) return;
  await discardBody(response);
  throw new CliError(
    "network_error",
    `The plugin source ${redactText(source)} redirected; redirects are not permitted.`,
    { retryable: false, details: { source, status: response.status } },
  );
}

/** Map every historical official release spelling onto the canonical endpoint. */
export function resolvePluginSource(source: string): string {
  if (source === NOVAMIRA_LATEST_SOURCE_ALIAS) return NOVAMIRA_DOWNLOAD_URL;
  return source;
}

/** Go's `validateRemotePluginInstallSource`: a HEAD check, never a download. */
export async function validateRemotePluginSource(
  source: string,
  http: HttpFetch,
  signal?: AbortSignal,
): Promise<void> {
  if (!source.startsWith("https://") && !source.startsWith("http://")) return;
  let response;
  try {
    ({ response } = await boundedPluginRequest(
      http,
      source,
      { method: "HEAD" },
      signal,
    ));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "network_error",
      `Failed to validate the plugin source ${redactText(source)}.`,
      { retryable: true, cause: error, details: { source } },
    );
  }
  await refusePluginRedirect(response, source);
  await discardBody(response);
  // Some hosts refuse HEAD outright; Go treated that as "not a verdict".
  if (response.status === 405) return;
  if (response.status < 200 || response.status >= 400) {
    throw new CliError(
      "not_found",
      `The plugin source ${redactText(source)} is not downloadable: HTTP ${String(response.status)}.`,
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

/** The probe {@link installFailureHint} runs. Inside Kinsta's charset. */
export function pluginIsInstalledCommand(slug: string): string {
  return shellJoin(["wp", "plugin", "is-installed", slug]);
}

/**
 * The already-installed tell, or nothing — the same courtesy {@link
 * preflightHint} pays, for the failure one step later.
 *
 * This exists because a provider is allowed to report a failed WP-CLI run
 * without reporting what WP-CLI said. Kinsta collapses *every* non-zero exit
 * into `500 Server Error` carrying no stdout and no stderr, so the operator
 * re-running `hosting novamira setup` on a site they already provisioned is
 * told only that the install "failed" — never that `wp plugin install` refuses
 * an existing directory, and never that `--force` is the answer.
 *
 * `wp plugin is-installed` is the right probe precisely because it writes
 * nothing: it reports through its exit status alone, which is the one channel
 * that survives such a provider. `status.failed === false` therefore means the
 * plugin is present.
 *
 * Every failure to answer is silence rather than a guess. A wrong hint on top
 * of a real failure is worse than none, so a throw, a refused command and a
 * provider that answered synchronously (`undefined`, where the exit status did
 * not survive as an operation) all yield `""`.
 */
export async function installFailureHint(
  client: ProviderClient,
  envId: string,
  slug: string,
  budget: PollBudget,
): Promise<string> {
  if (slug === "") return "";
  let status: OperationStatus | undefined;
  try {
    status = await runWpCli(
      client,
      envId,
      pluginIsInstalledCommand(slug),
      budget,
    );
  } catch {
    return "";
  }
  if (status === undefined || status.failed) return "";
  return ALREADY_INSTALLED_HINT;
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
  const operationId = redactAssociatedText(status.operationId, status);
  throw new CliError(
    "provider_error",
    redactAssociatedText(
      `WP-CLI preflight failed before plugin install: ${status.message ?? "provider reported failure"}${hint}`,
      status,
    ),
    {
      details: {
        provider: status.provider,
        operationId,
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
    const operationId = redactAssociatedText(status.operationId, status);
    throw new CliError(
      "provider_error",
      redactAssociatedText(
        `Plugin status operation ${status.operationId} failed after install: ${status.message ?? "provider reported failure"}`,
        status,
      ),
      {
        details: {
          provider: status.provider,
          operationId,
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
    const operationId = redactAssociatedText(status.operationId, status);
    throw new CliError(
      "provider_error",
      redactAssociatedText(
        `Plugin activation operation ${status.operationId} failed after install: ${status.message ?? "provider reported failure"}`,
        status,
      ),
      {
        details: {
          provider: status.provider,
          operationId,
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

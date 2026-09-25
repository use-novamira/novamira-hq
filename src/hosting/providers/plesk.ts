// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Conservative Plesk REST adapter with an optional WP Toolkit backup surface. */

import { randomUUID } from "node:crypto";
import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { compareSemverStrings, isSemver } from "../../semver.js";
import { HOSTINGER_NOVAMIRA_SOURCE } from "./hostinger-setup.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  unsupportedActionRequest,
  unsupportedOperation,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import type { HttpClient } from "../http-client.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
  providerCapabilities,
} from "../types.js";

const PROVIDER = "plesk" as const;
const BASE_CAPABILITIES = providerCapabilities([
  ["providers.validate", true],
  ["providers.capabilities", true],
  [
    "sites.list",
    true,
    "Lists Plesk virtual-host domains; not WordPress inventory",
  ],
  ["sites.get", true, "Gets a Plesk virtual-host domain"],
  [
    "envs.list",
    true,
    "WP Toolkit installations when available; otherwise one synthetic domain environment",
  ],
  [
    "envs.get",
    true,
    "WP Toolkit installations when available; otherwise one synthetic domain environment",
  ],
  [
    "novamira.setup",
    false,
    "Only WP Toolkit WordPress installations support automatic setup",
  ],
  ["backups.list", false, "Requires active WP Toolkit"],
  ["backups.create", false, "Requires active WP Toolkit"],
  ["backups.restore", false, "Requires active WP Toolkit"],
  [
    "envs.push",
    false,
    "WP Toolkit copies selected data between distinct WordPress installations",
  ],
] as const);

interface PleskDomain {
  readonly id: number;
  readonly name: string;
}

interface ToolkitInstance {
  readonly id: number;
  readonly mainDomainId: number;
  readonly name: string;
  readonly siteUrl: string;
  readonly version: string;
  readonly alive: boolean;
}

function instance(value: unknown): ToolkitInstance {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id <= 0 ||
    typeof record.mainDomainId !== "number" ||
    !Number.isSafeInteger(record.mainDomainId) ||
    record.mainDomainId <= 0 ||
    typeof record.name !== "string" ||
    typeof record.siteUrl !== "string" ||
    typeof record.version !== "string" ||
    typeof record.alive !== "boolean"
  )
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid installation.",
    );
  let url: URL;
  try {
    url = new URL(record.siteUrl);
  } catch {
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid site URL.",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid site URL.",
    );
  return {
    id: record.id,
    mainDomainId: record.mainDomainId,
    name: record.name,
    siteUrl: record.siteUrl,
    version: record.version,
    alive: record.alive,
  };
}

function domain(value: unknown): PleskDomain {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id <= 0 ||
    typeof record.name !== "string" ||
    record.name === "" ||
    typeof record.hosting_type !== "string"
  )
    throw new CliError("provider_error", "Plesk returned an invalid domain.");
  if (record.hosting_type !== "virtual")
    throw new CliError(
      "provider_unsupported",
      "This Plesk domain has no virtual hosting environment.",
    );
  return {
    id: record.id,
    name: record.name,
  };
}

function syntheticEnvironment(item: PleskDomain): HostingEnvironment {
  return {
    id: `domain:${String(item.id)}`,
    name: "live",
    displayName: "Live",
    // The domain inventory has no status field; do not infer suspension.
    isBlocked: false,
    isPremium: false,
    primaryDomain: item.name,
  };
}

function toolkitEnvironment(item: ToolkitInstance): HostingEnvironment {
  return {
    id: `wp:${String(item.id)}`,
    name: item.name || "WordPress",
    displayName: item.name || "WordPress",
    isBlocked: !item.alive,
    isPremium: false,
    wordpressVersion: item.version,
    primaryDomain: item.siteUrl,
  };
}

function site(
  item: PleskDomain,
  environments?: readonly HostingEnvironment[],
): HostingSite {
  return {
    id: String(item.id),
    name: item.name,
    displayName: item.name,
    status: "unknown",
    primaryDomain: item.name,
    ...(environments === undefined ? {} : { environments }),
  };
}

function domainId(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError(
      "usage_error",
      "Plesk domain ID must be a positive integer.",
    );
  return value;
}

function instanceId(value: string): string {
  const match = /^wp:([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new CliError(
      "usage_error",
      "Select a WP Toolkit WordPress installation.",
    );
  return match[1] ?? "";
}

function backupFilename(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !value.endsWith(".zip") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    value.includes("\0")
  )
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid backup name.",
    );
  return value;
}

interface NovamiraPlugin {
  readonly version: string;
  readonly status: "active" | "inactive";
}

function pluginRows(output: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid plugin inventory.",
    );
  }
  if (!Array.isArray(value) || value.some((entry) => !asRecord(entry)))
    throw new CliError(
      "provider_error",
      "WP Toolkit returned an invalid plugin inventory.",
    );
  return value as Record<string, unknown>[];
}

function novamiraPlugin(
  rows: readonly Record<string, unknown>[],
): NovamiraPlugin | undefined {
  const matches = rows.filter((row) => row.name === "novamira");
  if (matches.length === 0) return undefined;
  const found = matches[0];
  if (
    matches.length !== 1 ||
    !found ||
    typeof found.version !== "string" ||
    !isSemver(found.version) ||
    (found.status !== "active" && found.status !== "inactive")
  )
    throw new CliError(
      "provider_error",
      "Novamira's Plesk plugin state is ambiguous.",
    );
  return { version: found.version, status: found.status };
}

class PleskClient implements ProviderClient {
  readonly provider = PROVIDER;
  readonly #http: HttpClient;
  readonly #apiRoot: string;
  readonly #credentialSource: string;
  readonly #configured: boolean;
  readonly #completed = new Map<string, OperationStatus>();

  constructor(context: ProviderClientContext) {
    if (context.secret.length === 0)
      throw new CliError("credential_missing", "The Plesk API key is empty.");
    this.#configured = context.profile.apiBaseUrl !== undefined;
    const url = new URL(context.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !["/", "/api/v2"].includes(url.pathname.replace(/\/+$/, "") || "/")
    )
      throw new CliError(
        "config_error",
        "Plesk needs an HTTPS panel URL with no credentials, query or extra path.",
      );
    this.#apiRoot = `${url.origin}/api/v2`;
    this.#credentialSource = context.credentialSource;
    const key = context.secret.reveal();
    this.#http = context.createHttpClient({
      auth: {
        authorize: () => ({ headers: { "x-api-key": key }, secrets: [key] }),
      },
    });
  }

  #url(path: string): string {
    if (!this.#configured)
      throw new CliError(
        "config_error",
        "Set this Plesk profile's api_base_url to the HTTPS panel URL before connecting.",
      );
    return this.#apiRoot + path;
  }

  async #getDomain(id: string): Promise<PleskDomain> {
    return domain(
      await this.#http.json({
        path: this.#url(`/domains/${domainId(id)}`),
      }),
    );
  }

  async #hasToolkit(signal?: AbortSignal): Promise<boolean> {
    const value = await this.#http.json({
      path: this.#url("/extensions"),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(value) || value.some((entry) => !asRecord(entry)))
      throw new CliError(
        "provider_error",
        "Plesk returned an invalid extension list.",
      );
    return value.some((entry) => {
      const extension = asRecord(entry);
      return extension?.id === "wp-toolkit" && extension.active === true;
    });
  }

  async #requireToolkit(signal?: AbortSignal): Promise<void> {
    if (!(await this.#hasToolkit(signal)))
      throw new CliError(
        "provider_unsupported",
        "WP Toolkit is not active on this Plesk server.",
      );
  }

  async #toolkit(
    args: readonly string[],
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<string> {
    const value = asRecord(
      await this.#http.json({
        path: this.#url("/cli/extension/call"),
        method: "POST",
        body: {
          kind: "json",
          value: { params: ["--call", "wp-toolkit", ...args] },
        },
        timeoutMs,
        totalTimeoutMs: timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (
      value?.code !== 0 ||
      typeof value.stdout !== "string" ||
      typeof value.stderr !== "string"
    )
      throw new CliError(
        "provider_error",
        "WP Toolkit did not confirm the operation. Verify its result in Plesk before retrying.",
        { retryable: false },
      );
    return value.stdout;
  }

  async #instances(signal?: AbortSignal): Promise<ToolkitInstance[]> {
    const output = await this.#toolkit(
      ["--list", "-format", "json"],
      30_000,
      signal,
    );
    let value: unknown;
    try {
      value = JSON.parse(output) as unknown;
    } catch {
      throw new CliError(
        "provider_error",
        "WP Toolkit returned invalid WordPress inventory.",
      );
    }
    if (!Array.isArray(value))
      throw new CliError(
        "provider_error",
        "WP Toolkit returned invalid WordPress inventory.",
      );
    return value.map(instance);
  }

  async #verifiedInstance(
    envId: string,
    signal?: AbortSignal,
  ): Promise<ToolkitInstance> {
    const id = instanceId(envId);
    const found = (await this.#instances(signal)).find(
      (item) => String(item.id) === id,
    );
    if (!found)
      throw new CliError(
        "not_found",
        "The WP Toolkit installation is no longer present.",
      );
    if (!found.alive)
      throw new CliError(
        "server_unsupported",
        "The WP Toolkit installation is not working.",
      );
    return found;
  }

  async #wp(
    target: ToolkitInstance,
    args: readonly string[],
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#toolkit(
      ["--wp-cli", "-instance-id", String(target.id), "--", ...args],
      timeoutMs,
      signal,
    );
  }

  async #pluginRows(
    target: ToolkitInstance,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    return pluginRows(
      await this.#wp(
        target,
        ["plugin", "list", "--name=novamira", "--format=json"],
        30_000,
        signal,
      ),
    );
  }

  async #setupNovamira(
    request: Extract<ActionRequest, { kind: "setup-novamira" }>,
  ): Promise<ActionResult> {
    request.signal?.throwIfAborted();
    await this.#requireToolkit(request.signal);
    const target = await this.#verifiedInstance(request.envId, request.signal);
    const url = new URL(target.siteUrl);
    if (url.protocol !== "https:" || url.pathname !== "/")
      throw new CliError(
        "provider_unsupported",
        "Plesk setup currently requires a root-domain HTTPS WordPress installation.",
      );
    if (
      !isSemver(target.version) ||
      compareSemverStrings(target.version, "6.9.0") < 0
    )
      throw new CliError(
        "server_unsupported",
        "Novamira setup requires WordPress 6.9 or newer.",
      );
    const php = (
      await this.#wp(
        target,
        ["eval", "echo PHP_VERSION;"],
        30_000,
        request.signal,
      )
    ).trim();
    if (!isSemver(php) || compareSemverStrings(php, "8.0.0") < 0)
      throw new CliError(
        "server_unsupported",
        "Novamira setup requires PHP 8.0 or newer.",
      );
    let existing = novamiraPlugin(
      await this.#pluginRows(target, request.signal),
    );
    if (existing && compareSemverStrings(existing.version, "1.11.1") < 0)
      throw new CliError(
        "server_unsupported",
        "Update the existing Novamira installation before setup; it will not be overwritten.",
      );
    const previouslyInstalled = existing !== undefined;
    request.signal?.throwIfAborted();
    if (!existing) {
      await this.#wp(
        target,
        ["plugin", "install", HOSTINGER_NOVAMIRA_SOURCE],
        300_000,
        request.signal,
      );
      existing = novamiraPlugin(await this.#pluginRows(target, request.signal));
      if (!existing || compareSemverStrings(existing.version, "1.11.1") < 0)
        throw new CliError(
          "provider_error",
          "Novamira installation was not verified; check WordPress before retrying.",
        );
    }
    if (existing.status !== "active") {
      request.signal?.throwIfAborted();
      await this.#wp(
        target,
        ["plugin", "activate", "novamira"],
        60_000,
        request.signal,
      );
      existing = novamiraPlugin(await this.#pluginRows(target, request.signal));
      if (existing?.status !== "active")
        throw new CliError(
          "provider_error",
          "Novamira activation was not verified; check WordPress before retrying.",
        );
    }
    const enableAi = request.enableAiAbilities ?? !previouslyInstalled;
    if (enableAi) {
      request.signal?.throwIfAborted();
      await this.#wp(
        target,
        ["option", "update", "novamira_ai_abilities_domain", url.hostname],
        30_000,
        request.signal,
      );
      await this.#wp(
        target,
        ["option", "update", "novamira_ai_abilities_enabled", "1"],
        30_000,
        request.signal,
      );
      const domain = (
        await this.#wp(
          target,
          ["option", "get", "novamira_ai_abilities_domain"],
          30_000,
          request.signal,
        )
      ).trim();
      const enabled = (
        await this.#wp(
          target,
          ["option", "get", "novamira_ai_abilities_enabled"],
          30_000,
          request.signal,
        )
      ).trim();
      if (domain !== url.hostname || enabled !== "1")
        throw new CliError(
          "provider_error",
          "Novamira AI Abilities settings were not verified.",
        );
    }
    return {
      provider: PROVIDER,
      action: "novamira.setup",
      status: 200,
      raw: {
        siteUrl: target.siteUrl,
        version: existing.version,
        aiEnabled: enableAi ? true : null,
        warnings: [],
      },
    };
  }

  async #backups(envId: string): Promise<readonly Record<string, unknown>[]> {
    await this.#requireToolkit();
    const target = await this.#verifiedInstance(envId);
    const output = await this.#toolkit([
      "--backup",
      "-operation",
      "list",
      "-instance-id",
      String(target.id),
      "-format",
      "json",
    ]);
    let value: unknown;
    try {
      value = JSON.parse(output) as unknown;
    } catch {
      throw new CliError(
        "provider_error",
        "WP Toolkit returned an invalid backup catalog.",
      );
    }
    if (!Array.isArray(value))
      throw new CliError(
        "provider_error",
        "WP Toolkit returned an invalid backup catalog.",
      );
    return value.map((entry) => {
      const record = asRecord(entry);
      const id = backupFilename(record?.fileName);
      if (
        typeof record?.fileSize !== "number" ||
        !Number.isSafeInteger(record.fileSize) ||
        record.fileSize < 0 ||
        typeof record.createDate !== "string"
      )
        throw new CliError(
          "provider_error",
          "WP Toolkit returned an invalid backup catalog.",
        );
      return {
        id,
        filename: id,
        size_bytes: record.fileSize,
        created_at: record.createDate,
      };
    });
  }

  #completedAction(action: string, raw: unknown): ActionResult {
    const operationId = randomUUID();
    const status: OperationStatus = {
      provider: PROVIDER,
      operationId,
      status: 200,
      done: true,
      failed: false,
      raw: { completed: true },
    };
    if (this.#completed.size >= 32)
      this.#completed.delete(this.#completed.keys().next().value ?? "");
    this.#completed.set(operationId, status);
    return { provider: PROVIDER, action, status: 200, operationId, raw };
  }

  async validate(): Promise<ProviderValidation> {
    await this.#http.json({ path: this.#url("/domains") });
    return {
      provider: PROVIDER,
      status: "active",
      companyId: null,
      credential: this.#credentialSource,
    };
  }

  async listSites(options: ListSitesOptions = {}): Promise<HostingSite[]> {
    const value = await this.#http.json({ path: this.#url("/domains") });
    if (!Array.isArray(value))
      throw new CliError(
        "provider_error",
        "Plesk returned an invalid domain list.",
      );
    const domains = value
      .filter((entry) => asRecord(entry)?.hosting_type === "virtual")
      .map(domain);
    if (!options.includeEnvironments)
      return domains.map((entry) => site(entry));
    const hasToolkit = await this.#hasToolkit();
    const installs = hasToolkit ? await this.#instances() : [];
    return domains.map((entry) =>
      site(
        entry,
        hasToolkit
          ? installs
              .filter((item) => item.mainDomainId === entry.id)
              .map(toolkitEnvironment)
          : [syntheticEnvironment(entry)],
      ),
    );
  }

  async getSite(siteId: string): Promise<HostingSite> {
    const item = await this.#getDomain(siteId);
    return site(item, await this.listEnvironments(siteId));
  }

  async listEnvironments(siteId: string): Promise<HostingEnvironment[]> {
    const item = await this.#getDomain(siteId);
    if (!(await this.#hasToolkit())) return [syntheticEnvironment(item)];
    return (await this.#instances())
      .filter((instance) => instance.mainDomainId === item.id)
      .map(toolkitEnvironment);
  }

  async listPushTargets(sourceSiteId: string): Promise<HostingEnvironment[]> {
    await this.#getDomain(sourceSiteId);
    await this.#requireToolkit();
    return (await this.#instances()).map(toolkitEnvironment);
  }

  async read(request: ReadRequest): Promise<unknown> {
    if (request.kind === "capabilities") {
      const hasToolkit = await this.#hasToolkit();
      return BASE_CAPABILITIES.map((entry) =>
        entry.name.startsWith("backups.") ||
        entry.name === "novamira.setup" ||
        entry.name === "envs.push"
          ? { ...entry, supported: hasToolkit }
          : entry,
      );
    }
    if (request.kind === "backups")
      return { backups: await this.#backups(request.envId) };
    if (request.kind === "plugins") {
      await this.#requireToolkit();
      return this.#pluginRows(await this.#verifiedInstance(request.envId));
    }
    throw unsupportedReadRequest(PROVIDER, request);
  }

  async action(request: ActionRequest): Promise<ActionResult> {
    if (request.kind === "setup-novamira") return this.#setupNovamira(request);
    if (request.kind === "push-environment") {
      await this.#requireToolkit();
      const body = asRecord(request.body);
      const sourceId = body?.source_env_id;
      const targetId = body?.target_env_id;
      if (typeof sourceId !== "string" || typeof targetId !== "string")
        throw new CliError(
          "usage_error",
          "Select two WP Toolkit installations.",
        );
      const sourceInstanceId = instanceId(sourceId);
      const targetInstanceId = instanceId(targetId);
      if (sourceInstanceId === targetInstanceId)
        throw new CliError("usage_error", "Source and target must differ.");
      if (body?.push_db !== true && body?.push_db !== false)
        throw new CliError(
          "usage_error",
          "Specify whether to copy the database.",
        );
      if (body.push_files !== true && body.push_files !== false)
        throw new CliError("usage_error", "Specify whether to copy files.");
      if (!body.push_db && !body.push_files)
        throw new CliError("usage_error", "Select database, files, or both.");
      if (
        body.run_search_and_replace !== false ||
        (body.push_files && body.push_files_option !== "ALL_FILES") ||
        (!body.push_files && body.push_files_option !== undefined) ||
        body.file_list !== undefined
      )
        throw new CliError(
          "provider_unsupported",
          "Plesk supports only full file scope and no separate search-and-replace option.",
        );
      const sourceDomain = await this.#getDomain(request.siteId);
      const installs = await this.#instances();
      const source = installs.find(
        (item) => String(item.id) === sourceInstanceId,
      );
      const target = installs.find(
        (item) => String(item.id) === targetInstanceId,
      );
      if (!source || !target || source.mainDomainId !== sourceDomain.id)
        throw new CliError(
          "not_found",
          "The selected WordPress installations are no longer available under this Plesk account.",
        );
      if (!source.alive || !target.alive)
        throw new CliError(
          "server_unsupported",
          "Both WordPress installations must be working before copying data.",
        );
      const scope =
        body.push_db && body.push_files ? "all" : body.push_db ? "db" : "files";
      await this.#toolkit(
        [
          "--copy-data",
          "-source-instance-id",
          sourceInstanceId,
          "-target-instance-id",
          targetInstanceId,
          "-data-to-copy",
          scope,
          ...(body.push_db ? ["-db-tables-copy-mode", "all"] : []),
          ...(body.push_files ? ["-files-remove-missing", "no"] : []),
          "-create-restore-point",
          "no",
          "-format",
          "json",
        ],
        300_000,
      );
      return this.#completedAction("envs.push", {
        source_env_id: sourceId,
        target_env_id: targetId,
        copied: scope,
      });
    }
    if (request.kind === "create-backup") {
      await this.#requireToolkit();
      const target = await this.#verifiedInstance(request.envId);
      const output = await this.#toolkit(
        [
          "--backup",
          "-operation",
          "backup",
          "-instance-id",
          String(target.id),
          "-format",
          "json",
        ],
        300_000,
      );
      let result: unknown;
      try {
        result = JSON.parse(output) as unknown;
      } catch {
        throw new CliError(
          "provider_error",
          "WP Toolkit did not return a backup receipt.",
        );
      }
      const receipt = asRecord(result);
      const filename = backupFilename(receipt?.backupFilename);
      const catalog = await this.#backups(request.envId);
      if (!catalog.some((entry) => entry.id === filename))
        throw new CliError(
          "provider_error",
          "The new backup was not found in the target catalog.",
        );
      return this.#completedAction("backups.create", { backup_id: filename });
    }
    if (request.kind === "restore-backup") {
      await this.#requireToolkit();
      const backupId = asRecord(request.body)?.backup_id;
      if (typeof backupId !== "string")
        throw new CliError(
          "usage_error",
          "Select a backup from this WordPress installation.",
        );
      const filename = backupFilename(backupId);
      const catalog = await this.#backups(request.targetEnvId);
      if (!catalog.some((entry) => entry.id === filename))
        throw new CliError(
          "not_found",
          "The backup is no longer in the target installation catalog.",
        );
      const target = await this.#verifiedInstance(request.targetEnvId);
      await this.#toolkit(
        [
          "--backup",
          "-operation",
          "restore",
          "-instance-id",
          String(target.id),
          "-filename",
          filename,
          "-format",
          "json",
        ],
        300_000,
      );
      return this.#completedAction("backups.restore", { backup_id: filename });
    }
    throw unsupportedActionRequest(PROVIDER, request);
  }

  operationStatus(operationId: string): Promise<OperationStatus> {
    const completed = this.#completed.get(operationId);
    return completed
      ? Promise.resolve(completed)
      : Promise.reject(
          unsupportedOperation(PROVIDER, "unknown operation status"),
        );
  }

  wpCliResultsObservable(): boolean {
    return false;
  }
}

export const createPleskClient: ProviderClientFactory = (context) =>
  new PleskClient(context);

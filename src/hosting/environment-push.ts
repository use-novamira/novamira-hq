// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The safe, provider-neutral environment-push workflow shared by the CLI and
 * MCP. A push never has an implicit scope and never starts before a backup of
 * the target environment has been accepted (and completed when the provider
 * exposes an operation id).
 */

import { CliError } from "../errors.js";
import { applyHqCapabilityPolicy } from "./capabilities.js";
import type { ProviderClient } from "./client.js";
import {
  operationFailure,
  waitForOperationStatus,
  type WaitForOperationOptions,
} from "./operations.js";
import type {
  ActionResult,
  HostingEnvironment,
  OperationStatus,
  ProviderCapability,
} from "./types.js";

export interface EnvironmentPushSelection {
  readonly siteId: string;
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentId: string;
  readonly database: boolean;
  readonly allFiles: boolean;
  readonly files: readonly string[];
  readonly searchReplace: boolean;
}

export interface EnvironmentPushPlan {
  readonly provider: ProviderClient["provider"];
  readonly siteId: string;
  readonly source: HostingEnvironment;
  readonly target: HostingEnvironment;
  readonly database: boolean;
  readonly allFiles: boolean;
  readonly files: readonly string[];
  readonly searchReplace: boolean;
  readonly safetyBackup: "required";
}

export interface EnvironmentPushExecution {
  readonly plan: EnvironmentPushPlan;
  readonly safetyBackup: ActionResult;
  readonly safetyBackupStatus?: OperationStatus;
  readonly push: ActionResult;
  readonly pushStatus?: OperationStatus;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "")
    throw new CliError("usage_error", `${label} must be a non-empty string.`);
  return trimmed;
}

function normalizedFiles(files: readonly string[]): string[] {
  const normalized = files.map((file) => file.trim());
  if (normalized.some((file) => file === ""))
    throw new CliError(
      "usage_error",
      "Every selected file path must be non-empty.",
    );
  return [...new Set(normalized)];
}

function validateSelection(selection: EnvironmentPushSelection): {
  readonly siteId: string;
  readonly sourceEnvironmentId: string;
  readonly targetEnvironmentId: string;
  readonly files: readonly string[];
} {
  const siteId = nonEmpty(selection.siteId, "siteId");
  const sourceEnvironmentId = nonEmpty(
    selection.sourceEnvironmentId,
    "sourceEnvironmentId",
  );
  const targetEnvironmentId = nonEmpty(
    selection.targetEnvironmentId,
    "targetEnvironmentId",
  );
  const files = normalizedFiles(selection.files);
  if (sourceEnvironmentId === targetEnvironmentId)
    throw new CliError(
      "usage_error",
      "The source and target environments must be different.",
      { details: { sourceEnvironmentId, targetEnvironmentId } },
    );
  if (selection.allFiles && files.length > 0)
    throw new CliError(
      "usage_error",
      "allFiles and explicit file paths cannot be used together.",
    );
  if (!selection.database && !selection.allFiles && files.length === 0)
    throw new CliError(
      "usage_error",
      "Select the database, all files, or at least one explicit file path.",
    );
  if (selection.searchReplace && !selection.database)
    throw new CliError(
      "usage_error",
      "searchReplace requires the database scope.",
    );
  return { siteId, sourceEnvironmentId, targetEnvironmentId, files };
}

function capabilities(value: unknown): readonly ProviderCapability[] {
  const governed = applyHqCapabilityPolicy(value);
  if (!Array.isArray(governed))
    throw new CliError(
      "provider_unsupported",
      "The provider did not return a usable capability document.",
    );
  const result: ProviderCapability[] = [];
  for (const item of governed) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).supported !== "boolean"
    )
      throw new CliError(
        "provider_unsupported",
        "The provider did not return a usable capability document.",
      );
    const record = item as { name: string; supported: boolean; notes?: string };
    result.push({
      name: record.name,
      supported: record.supported,
      ...(typeof record.notes === "string" && record.notes !== ""
        ? { notes: record.notes }
        : {}),
    });
  }
  return result;
}

function requireCapability(
  provider: ProviderClient["provider"],
  entries: readonly ProviderCapability[],
  name: string,
): void {
  const capability = entries.find((entry) => entry.name === name);
  if (capability?.supported === true) return;
  throw new CliError(
    "provider_unsupported",
    `${provider} does not expose ${name} through Novamira HQ.`,
    { details: { provider, capability: name } },
  );
}

function requireEnvironment(
  environments: readonly HostingEnvironment[],
  id: string,
  role: "source" | "target",
  siteId: string,
): HostingEnvironment {
  const environment = environments.find((candidate) => candidate.id === id);
  if (environment !== undefined) return environment;
  throw new CliError(
    "not_found",
    `The ${role} environment "${id}" was not found under site "${siteId}".`,
    { details: { role, environmentId: id, siteId } },
  );
}

export async function prepareEnvironmentPush(
  client: ProviderClient,
  selection: EnvironmentPushSelection,
): Promise<EnvironmentPushPlan> {
  const validated = validateSelection(selection);
  const available = capabilities(await client.read({ kind: "capabilities" }));
  requireCapability(client.provider, available, "envs.push");
  requireCapability(client.provider, available, "backups.create");
  const environments = await client.listEnvironments(validated.siteId);
  const source = requireEnvironment(
    environments,
    validated.sourceEnvironmentId,
    "source",
    validated.siteId,
  );
  const target = requireEnvironment(
    environments,
    validated.targetEnvironmentId,
    "target",
    validated.siteId,
  );
  return {
    provider: client.provider,
    siteId: validated.siteId,
    source,
    target,
    database: selection.database,
    allFiles: selection.allFiles,
    files: validated.files,
    searchReplace: selection.searchReplace,
    safetyBackup: "required",
  };
}

function pushBody(
  plan: EnvironmentPushPlan,
): Readonly<Record<string, unknown>> {
  const pushFiles = plan.allFiles || plan.files.length > 0;
  return {
    source_env_id: plan.source.id,
    target_env_id: plan.target.id,
    push_db: plan.database,
    push_files: pushFiles,
    run_search_and_replace: plan.searchReplace,
    ...(plan.allFiles ? { push_files_option: "ALL_FILES" } : {}),
    ...(plan.files.length > 0
      ? { push_files_option: "SPECIFIC_FILES", file_list: [...plan.files] }
      : {}),
  };
}

async function waitForAction(
  client: ProviderClient,
  action: ActionResult,
  options: WaitForOperationOptions,
): Promise<OperationStatus | undefined> {
  if (action.operationId === undefined || action.operationId === "")
    return undefined;
  const status = await waitForOperationStatus(
    client,
    action.operationId,
    options,
  );
  if (status.failed) throw operationFailure(status);
  return status;
}

export async function executeEnvironmentPush(
  client: ProviderClient,
  plan: EnvironmentPushPlan,
  wait: WaitForOperationOptions = {
    intervalSeconds: 5,
    timeoutSeconds: 300,
  },
): Promise<EnvironmentPushExecution> {
  if (client.provider !== plan.provider)
    throw new CliError(
      "conflict",
      "The environment push plan belongs to a different provider.",
    );
  const safetyBackup = await client.action({
    kind: "create-backup",
    envId: plan.target.id,
    body: { tag: "novamira-hq pre-push safety backup" },
  });
  const safetyBackupStatus = await waitForAction(client, safetyBackup, wait);
  const push = await client.action({
    kind: "push-environment",
    siteId: plan.siteId,
    body: pushBody(plan),
  });
  const pushStatus = await waitForAction(client, push, wait);
  return {
    plan,
    safetyBackup,
    ...(safetyBackupStatus === undefined ? {} : { safetyBackupStatus }),
    push,
    ...(pushStatus === undefined ? {} : { pushStatus }),
  };
}

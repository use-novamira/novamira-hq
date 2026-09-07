// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guarded, provider-neutral backup restoration shared by CLI and MCP.
 *
 * A restore is allowed only when the provider can list, create, and restore
 * backups. Planning proves that the selected backup is present in the target
 * environment's own catalog. Applying first creates and awaits a fresh safety
 * backup of that environment, then starts and awaits the requested restore.
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
  OperationStatus,
  ProviderCapability,
} from "./types.js";

export interface BackupRestoreSelection {
  readonly targetEnvironmentId: string;
  readonly backupId: string;
  /** Full overwrite must be acknowledged explicitly; it is never implicit. */
  readonly allContent: boolean;
  /** Kinsta user id that receives the provider's restore notification. */
  readonly notifiedUserId?: string;
}

export interface BackupRestorePlan {
  readonly provider: ProviderClient["provider"];
  readonly targetEnvironmentId: string;
  readonly backupId: string;
  readonly scope: "all-content";
  readonly safetyBackup: "required";
  readonly notifiedUserId?: string;
}

export interface BackupRestoreExecution {
  readonly plan: BackupRestorePlan;
  readonly safetyBackup: ActionResult;
  readonly safetyBackupStatus?: OperationStatus;
  readonly restore: ActionResult;
  readonly restoreStatus?: OperationStatus;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "")
    throw new CliError("usage_error", `${label} must be a non-empty string.`);
  return trimmed;
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
  if (entries.some((entry) => entry.name === name && entry.supported)) return;
  throw new CliError(
    "provider_unsupported",
    `${provider} does not expose ${name} through Novamira HQ.`,
    { details: { provider, capability: name } },
  );
}

const COLLECTION_KEYS: ReadonlySet<string> = new Set([
  "backups",
  "data",
  "items",
  "result",
  "results",
]);
const ID_KEYS: ReadonlySet<string> = new Set([
  "backup_id",
  "backupId",
  "id",
  "uuid",
]);

function scalarId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Provider backup listings are intentionally returned raw. This walker only
 * accepts identifier fields beneath known collection keys (or a top-level
 * array), so an unrelated environment/account id cannot satisfy the check.
 */
export function backupCatalogContains(
  catalog: unknown,
  backupId: string,
): boolean {
  const expected = backupId.trim();
  if (expected === "") return false;

  const visit = (value: unknown, insideCollection: boolean): boolean => {
    if (Array.isArray(value))
      return value.some((entry) => visit(entry, insideCollection));
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    if (insideCollection) {
      for (const [key, candidate] of Object.entries(record))
        if (ID_KEYS.has(key) && scalarId(candidate) === expected) return true;
    }
    for (const [key, child] of Object.entries(record))
      if (visit(child, insideCollection || COLLECTION_KEYS.has(key)))
        return true;
    return false;
  };

  return visit(catalog, Array.isArray(catalog));
}

export async function prepareBackupRestore(
  client: ProviderClient,
  selection: BackupRestoreSelection,
): Promise<BackupRestorePlan> {
  const targetEnvironmentId = nonEmpty(
    selection.targetEnvironmentId,
    "targetEnvironmentId",
  );
  const backupId = nonEmpty(selection.backupId, "backupId");
  if (!selection.allContent)
    throw new CliError(
      "usage_error",
      "A full backup restore requires an explicit allContent acknowledgement.",
    );
  const notifiedUserId =
    selection.notifiedUserId === undefined
      ? undefined
      : nonEmpty(selection.notifiedUserId, "notifiedUserId");
  if (client.provider === "kinsta" && notifiedUserId === undefined)
    throw new CliError(
      "usage_error",
      "Kinsta backup restore requires notifiedUserId.",
      { details: { provider: client.provider } },
    );

  const available = capabilities(await client.read({ kind: "capabilities" }));
  requireCapability(client.provider, available, "backups.list");
  requireCapability(client.provider, available, "backups.create");
  requireCapability(client.provider, available, "backups.restore");

  const catalog = await client.read({
    kind: "backups",
    envId: targetEnvironmentId,
  });
  if (!backupCatalogContains(catalog, backupId))
    throw new CliError(
      "not_found",
      `Backup "${backupId}" was not found in environment "${targetEnvironmentId}".`,
      { details: { backupId, targetEnvironmentId } },
    );

  return {
    provider: client.provider,
    targetEnvironmentId,
    backupId,
    scope: "all-content",
    safetyBackup: "required",
    ...(notifiedUserId === undefined ? {} : { notifiedUserId }),
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

function restoreBody(
  plan: BackupRestorePlan,
): Readonly<Record<string, unknown>> {
  let backupId: string | number = plan.backupId;
  if (plan.provider === "kinsta") {
    if (!/^\d+$/.test(plan.backupId))
      throw new CliError(
        "usage_error",
        "Kinsta backup ids must be unsigned integers.",
        { details: { provider: plan.provider } },
      );
    const numeric = Number(plan.backupId);
    if (!Number.isSafeInteger(numeric))
      throw new CliError(
        "usage_error",
        "Kinsta backup id is outside the supported integer range.",
        { details: { provider: plan.provider } },
      );
    backupId = numeric;
  }
  return {
    backup_id: backupId,
    ...(plan.provider === "kinsta" && plan.notifiedUserId !== undefined
      ? { notified_user_id: plan.notifiedUserId }
      : {}),
  };
}

export async function executeBackupRestore(
  client: ProviderClient,
  plan: BackupRestorePlan,
  wait: WaitForOperationOptions = {
    intervalSeconds: 5,
    timeoutSeconds: 300,
  },
): Promise<BackupRestoreExecution> {
  if (client.provider !== plan.provider)
    throw new CliError(
      "conflict",
      "The backup restore plan belongs to a different provider.",
    );

  const safetyBackup = await client.action({
    kind: "create-backup",
    envId: plan.targetEnvironmentId,
    body: { tag: "novamira-hq pre-restore safety backup" },
  });
  const safetyBackupStatus = await waitForAction(client, safetyBackup, wait);
  const restore = await client.action({
    kind: "restore-backup",
    targetEnvId: plan.targetEnvironmentId,
    body: restoreBody(plan),
  });
  const restoreStatus = await waitForAction(client, restore, wait);
  return {
    plan,
    safetyBackup,
    ...(safetyBackupStatus === undefined ? {} : { safetyBackupStatus }),
    restore,
    ...(restoreStatus === undefined ? {} : { restoreStatus }),
  };
}

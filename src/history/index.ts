// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { WorkflowKind, WorkflowStatus } from "../operation-context.js";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicWriteFile } from "../config/atomic-write.js";
import type { VerifiedFileSecurity } from "../config/file-security.js";
import type { ProfileLockManager } from "../config/lock.js";
import { historyFilePath, type PlatformPaths } from "../config/paths.js";
import { isProviderKind, type ProviderKind } from "../config/schema.js";
import { CliError, ERROR_CODES, type ErrorCode } from "../errors.js";
import {
  isActionRequestKind,
  type ActionRequestKind,
} from "../hosting/client.js";
import { asRecord } from "../json.js";
import { redactText } from "../output/redact.js";

export type HistoryChannel = "cli" | "dashboard" | "mcp";
export type HistoryStatus =
  "needs_verification" | "accepted" | "succeeded" | "failed";
export interface HistoryEntry {
  readonly pushJobId?: string;
  readonly pushName?: string;
  readonly sourceUrl?: string;
  readonly targetUrl?: string;
  readonly workflowId?: string;
  readonly workflowKind?: WorkflowKind;
  readonly workflowStatus?: WorkflowStatus;
  readonly workflowErrorCode?: ErrorCode;
  readonly sourceEnvironmentId?: string;
  readonly scope?: string;
  readonly id: string;
  readonly profile: string;
  readonly provider: ProviderKind;
  readonly channel: HistoryChannel;
  readonly action: ActionRequestKind;
  readonly siteId?: string;
  readonly environmentId?: string;
  readonly operationId?: string;
  readonly status: HistoryStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly errorCode?: ErrorCode;
}

export const HISTORY_LIMIT = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const LOCK_KEY = "__hosting_history__";
const STRING_KEYS = [
  "pushJobId",
  "pushName",
  "sourceUrl",
  "targetUrl",
  "id",
  "profile",
  "siteId",
  "environmentId",
  "operationId",
  "workflowId",
  "sourceEnvironmentId",
  "scope",
] as const;
const KEYS = new Set([
  ...STRING_KEYS,
  "provider",
  "channel",
  "action",
  "status",
  "startedAt",
  "updatedAt",
  "errorCode",
  "workflowKind",
  "workflowStatus",
  "workflowErrorCode",
]);

export function needsAttention(entry: HistoryEntry): boolean {
  return (
    entry.workflowStatus !== "succeeded" &&
    (entry.workflowStatus === "failed" ||
      entry.status === "failed" ||
      entry.status === "needs_verification" ||
      entry.status === "accepted")
  );
}

/** Old failed attempts stop alerting after a newer successful equivalent action. */
export function attentionEntries(
  entries: readonly HistoryEntry[],
): readonly HistoryEntry[] {
  return entries.filter(
    (entry) =>
      needsAttention(entry) &&
      !(
        (entry.status === "failed" || entry.workflowStatus === "failed") &&
        entries.some(
          (newer) =>
            newer.startedAt > entry.startedAt &&
            newer.profile === entry.profile &&
            newer.provider === entry.provider &&
            newer.action === entry.action &&
            newer.environmentId === entry.environmentId &&
            newer.siteId === entry.siteId &&
            (newer.status === "succeeded" ||
              newer.workflowStatus === "succeeded"),
        )
      ),
  );
}

/** Bounded text only; neither request bodies nor provider messages belong here. */
export function historyText(
  value: string,
  secrets: readonly string[] = [],
): string {
  return (
    redactText(value, secrets)
      // eslint-disable-next-line no-control-regex -- journal strings must not inject terminal controls
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 200)
  );
}

function storageError(): CliError {
  return new CliError(
    "config_error",
    "Hosting history is unreadable or unsafe. Check Novamira HQ state storage before continuing.",
  );
}

function parseEntry(value: unknown): HistoryEntry {
  const row = asRecord(value);
  if (row === undefined) throw storageError();
  if (Object.keys(row).some((key) => !KEYS.has(key))) throw storageError();
  for (const key of STRING_KEYS) {
    const field = row[key];
    if (field === undefined && key !== "id" && key !== "profile") continue;
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > 200 ||
      historyText(field) !== field
    )
      throw storageError();
  }
  if (
    !isProviderKind(row.provider) ||
    !isActionRequestKind(row.action) ||
    !(["cli", "dashboard", "mcp"] as readonly unknown[]).includes(
      row.channel,
    ) ||
    !(
      [
        "needs_verification",
        "accepted",
        "succeeded",
        "failed",
      ] as readonly unknown[]
    ).includes(row.status)
  )
    throw storageError();
  for (const key of ["startedAt", "updatedAt"]) {
    const field = row[key];
    if (
      typeof field !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(field) ||
      !Number.isFinite(Date.parse(field))
    )
      throw storageError();
  }
  if (
    row.errorCode !== undefined &&
    !(ERROR_CODES as readonly unknown[]).includes(row.errorCode)
  )
    throw storageError();
  if (
    row.workflowErrorCode !== undefined &&
    !(ERROR_CODES as readonly unknown[]).includes(row.workflowErrorCode)
  )
    throw storageError();
  if (
    row.workflowId !== undefined &&
    (!(["novamira-setup", "backup-restore"] as readonly unknown[]).includes(
      row.workflowKind,
    ) ||
      !(["running", "succeeded", "failed"] as readonly unknown[]).includes(
        row.workflowStatus,
      ))
  )
    throw storageError();
  if (
    row.workflowId === undefined &&
    (row.workflowKind !== undefined ||
      row.workflowStatus !== undefined ||
      row.workflowErrorCode !== undefined)
  )
    throw storageError();
  return row as unknown as HistoryEntry;
}

/** Atomic, private, cross-process serialized storage. Reads never create files. */
export class HistoryStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    paths: Pick<PlatformPaths, "stateDir">,
    private readonly locks: ProfileLockManager,
    private readonly security: VerifiedFileSecurity,
    private readonly now: () => number = Date.now,
  ) {
    this.file = historyFilePath(paths);
  }

  async list(profile?: string): Promise<readonly HistoryEntry[]> {
    const rows = await this.read();
    return rows
      .filter((row) => profile === undefined || row.profile === profile)
      .reverse();
  }

  async begin(
    input: Pick<
      HistoryEntry,
      | "profile"
      | "pushJobId"
      | "pushName"
      | "sourceUrl"
      | "targetUrl"
      | "provider"
      | "channel"
      | "action"
      | "siteId"
      | "environmentId"
      | "sourceEnvironmentId"
      | "scope"
      | "workflowId"
      | "workflowKind"
      | "workflowStatus"
    >,
  ): Promise<string> {
    const timestamp = new Date(this.now()).toISOString();
    const row = parseEntry({
      ...input,
      id: randomUUID(),
      status: "needs_verification",
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.change((rows) => {
      const next = [...rows, row];
      while (next.length > HISTORY_LIMIT) {
        const index = next.findIndex(
          (entry) =>
            entry.workflowStatus === "succeeded" ||
            (entry.workflowStatus !== "running" &&
              (entry.status === "succeeded" || entry.status === "failed")),
        );
        if (index === -1)
          throw new CliError(
            "conflict",
            "Hosting history contains 500 unresolved requests. Verify their provider operations before starting another mutation; unresolved records are never discarded.",
          );
        next.splice(index, 1);
      }
      return next;
    });
    return row.id;
  }

  async finish(
    id: string,
    status: HistoryStatus,
    extra: Pick<HistoryEntry, "operationId" | "errorCode"> = {},
  ): Promise<void> {
    await this.change((rows) =>
      rows.map((row) =>
        row.id === id
          ? parseEntry({
              ...row,
              ...extra,
              status,
              updatedAt: new Date(this.now()).toISOString(),
            })
          : row,
      ),
    );
  }

  async finishWorkflow(
    id: string,
    status: WorkflowStatus,
    errorCode?: ErrorCode,
  ): Promise<void> {
    await this.change((rows) =>
      rows.map((row) =>
        row.workflowId === id
          ? parseEntry({
              ...row,
              workflowStatus: status,
              ...(errorCode ? { workflowErrorCode: errorCode } : {}),
            })
          : row,
      ),
    );
  }

  async observe(
    profile: string,
    provider: ProviderKind,
    operationId: string,
    status: HistoryStatus,
  ): Promise<void> {
    await this.change((rows) =>
      rows.map((row) =>
        row.profile === profile &&
        row.provider === provider &&
        row.operationId === operationId &&
        row.status !== "succeeded" &&
        row.status !== "failed"
          ? parseEntry({
              ...row,
              status,
              updatedAt: new Date(this.now()).toISOString(),
            })
          : row,
      ),
    );
  }

  private change(
    update: (rows: HistoryEntry[]) => HistoryEntry[],
  ): Promise<void> {
    // Serialize locally before taking the cross-process lock. No network inside.
    const pending = this.queue
      .then(() =>
        this.locks.withLock(LOCK_KEY, async () => {
          await atomicWriteFile(
            this.file,
            JSON.stringify({ version: 1, entries: update(await this.read()) }),
            this.security,
          );
        }),
      )
      .catch((error: unknown) => {
        throw error instanceof CliError ? error : storageError();
      });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async read(): Promise<HistoryEntry[]> {
    try {
      let info;
      try {
        info = await lstat(this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      if (
        !info.isFile() ||
        info.size > MAX_BYTES ||
        !(await this.security.verifyFile(this.file))
      )
        throw storageError();
      const file = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let document: Record<string, unknown>;
      try {
        if ((await file.stat()).size > MAX_BYTES) throw storageError();
        document =
          asRecord(JSON.parse(await file.readFile("utf8")) as unknown) ?? {};
      } finally {
        await file.close();
      }
      if (
        document.version !== 1 ||
        !Array.isArray(document.entries) ||
        document.entries.length > HISTORY_LIMIT ||
        Object.keys(document).some(
          (key) => key !== "version" && key !== "entries",
        )
      )
        throw storageError();
      const entries = document.entries.map((row: unknown) => parseEntry(row));
      if (new Set(entries.map((row) => row.id)).size !== entries.length)
        throw storageError();
      return entries;
    } catch {
      throw storageError();
    }
  }
}

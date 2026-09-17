// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { type HttpClient, jsonBody } from "../http-client.js";
import type { ActionResult, OperationStatus } from "../types.js";

// Provider's own CLI: github.com/InstaWP/cli/blob/main/src/commands/versions.ts
// Site Versions are restorable in place, unlike the separate Snapshots product.
function failure(): CliError {
  return new CliError(
    "provider_error",
    "InstaWP could not verify the site version operation. Check the provider before retrying.",
  );
}
function id(value: unknown): string {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,19}$/.test(text))
    throw new CliError(
      "usage_error",
      "InstaWP requires a positive numeric site, version or task ID.",
    );
  return text;
}
function envelope(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record?.status !== true) throw failure();
  return record;
}
function input(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const record = value === undefined ? {} : asRecord(value);
  if (!record || Object.keys(record).some((key) => !keys.includes(key)))
    throw new CliError("usage_error", "Unsupported InstaWP backup parameters.");
  return record;
}

export function instaWpVersions(http: HttpClient) {
  async function list(envId: string) {
    id(envId);
    const backups: {
      id: string;
      name: string;
      created_at: string;
      status: string;
      kind: string;
    }[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = envelope(
        await http.json({
          path: "/site-versions",
          query: [
            ["site_id", envId],
            ["per_page", "100"],
            ["page", String(page)],
          ],
        }),
      );
      if (!Array.isArray(result.data)) throw failure();
      for (const value of result.data) {
        const row = asRecord(value);
        // The filtered endpoint may omit site_id; an explicit different site is never accepted.
        if (!row || (row.site_id !== undefined && id(row.site_id) !== envId))
          continue;
        backups.push({
          id: id(row.id),
          name: typeof row.name === "string" ? row.name : "Site version",
          created_at: typeof row.created_at === "string" ? row.created_at : "",
          status: typeof row.status === "string" ? row.status : "unknown",
          kind: "site_version",
        });
      }
      const meta = asRecord(result.meta);
      if (
        meta &&
        Number.isInteger(meta.last_page) &&
        Number(meta.last_page) >= page
      ) {
        if (page === meta.last_page) return { backups };
      } else if (result.data.length < 100) return { backups };
    }
    throw failure();
  }

  function actionResult(
    action: string,
    status: number,
    value: unknown,
  ): ActionResult {
    const data = asRecord(envelope(value).data);
    if (data?.task_id == null) throw failure();
    let task: string;
    try {
      task = id(data.task_id);
    } catch {
      throw failure();
    }
    return {
      provider: "instawp",
      action,
      status,
      operationId: `version-task:${task}`,
      raw: { task_id: task },
      message: "Site version operation accepted; completion must be verified.",
    };
  }

  async function create(envId: string, body: unknown): Promise<ActionResult> {
    id(envId);
    const payload = input(body, ["tag"]);
    if (
      payload.tag !== undefined &&
      (typeof payload.tag !== "string" ||
        payload.tag.length > 200 ||
        /[\r\n]/.test(payload.tag))
    )
      throw new CliError(
        "usage_error",
        "The backup tag must be a single-line string of at most 200 characters.",
      );
    const response = await http.request({
      path: "/site-versions",
      method: "POST",
      body: jsonBody({ site_id: envId }),
    });
    const result = actionResult(
      "backups.create",
      response.status,
      response.data,
    );
    const data = asRecord(asRecord(response.data)?.data);
    if (!data || (data.site_id !== undefined && id(data.site_id) !== envId))
      throw failure();
    let version: string;
    try {
      version = id(data.id);
    } catch {
      throw failure();
    }
    if (typeof payload.tag === "string" && payload.tag.trim()) {
      try {
        envelope(
          await http.json({
            path: `/site-versions/${version}`,
            method: "PUT",
            body: jsonBody({ name: payload.tag.slice(0, 25) }),
            idempotent: false,
          }),
        );
      } catch {
        // Naming is optional and must never cause a second create or hide the task ID.
        return {
          ...result,
          message:
            "Version requested, but its label could not be saved. Completion must still be verified.",
        };
      }
    }
    return result;
  }

  async function restore(envId: string, body: unknown): Promise<ActionResult> {
    id(envId);
    const payload = input(body, ["backup_id"]);
    const version = id(payload.backup_id);
    const selected = (await list(envId)).backups.find(
      (row) => row.id === version,
    );
    if (selected?.status !== "completed")
      throw new CliError(
        "not_found",
        "The completed version was not found in the target site's catalog.",
      );
    const response = await http.request({
      path: `/sites/${envId}/restore-versions/${version}`,
      method: "PUT",
      idempotent: false,
    });
    return actionResult("backups.restore", response.status, response.data);
  }

  async function status(operationId: string): Promise<OperationStatus> {
    const match = /^version-task:([1-9][0-9]{0,19})$/.exec(operationId);
    if (!match?.[1])
      throw new CliError(
        "usage_error",
        "Invalid InstaWP version operation ID.",
      );
    const result = envelope(
      await http.json({ path: `/tasks/${match[1]}/status` }),
    );
    const data = asRecord(result.data);
    const state = typeof data?.status === "string" ? data.status : "unknown";
    const failed = state === "error" || state === "failed";
    return {
      provider: "instawp",
      operationId,
      status: 200,
      done: state === "completed" || failed,
      failed,
      raw: { status: state },
    };
  }
  return { list, create, restore, status };
}

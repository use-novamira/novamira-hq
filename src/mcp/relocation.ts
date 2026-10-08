// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "../config/atomic-write.js";
import type { FileSecurity } from "../config/file-security.js";
import { asRecord } from "../json.js";

/** The command AI clients were last configured with, and the one before it. */
export interface LaunchRecord {
  readonly command: string;
  readonly previous?: string;
}

export async function readLaunchRecord(
  path: string,
): Promise<LaunchRecord | undefined> {
  try {
    const value = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (value?.version !== 1 || typeof value.command !== "string")
      return undefined;
    return typeof value.previous === "string"
      ? { command: value.command, previous: value.previous }
      : { command: value.command };
  } catch {
    return undefined;
  }
}

export async function writeLaunchRecord(
  path: string,
  record: LaunchRecord,
  security: FileSecurity,
): Promise<void> {
  await atomicWriteFile(
    path,
    `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`,
    security,
  );
}

export function nextLaunchRecord(
  stored: LaunchRecord | undefined,
  current: string,
): LaunchRecord {
  if (!stored) return { command: current };
  if (stored.command !== current)
    return { command: current, previous: stored.command };
  return stored;
}

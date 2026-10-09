// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
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

export type DetectedClient =
  "claude-code" | "codex" | "cursor" | "antigravity" | "vscode" | "claude";

export interface DetectionHost {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readText(path: string): Promise<string | undefined>;
  list(directory: string): Promise<readonly string[]>;
  run(command: string, args: readonly string[]): Promise<string | undefined>;
}

/** Windows paths appear with escaped backslashes in JSON and TOML files. */
export function mentions(text: string, command: string): boolean {
  return (
    text.includes(command) ||
    text.includes(JSON.stringify(command).slice(1, -1))
  );
}

export function isOutsideApplications(
  executable: string,
  platform: NodeJS.Platform,
  home: string,
): boolean {
  if (platform !== "darwin") return false;
  return !(
    executable.startsWith("/Applications/") ||
    executable.startsWith(`${home}/Applications/`)
  );
}

function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

const DETECTION_ORDER: readonly DetectedClient[] = [
  "claude-code",
  "codex",
  "cursor",
  "antigravity",
  "vscode",
  "claude",
];

/** Read-only: which clients still launch HQ through `command`. */
export async function findClientsUsing(
  command: string,
  host: DetectionHost,
  timeoutMs = 10_000,
): Promise<DetectedClient[]> {
  const path = host.platform === "win32" ? win32 : posix;
  const env = host.environment;
  const appData = env.APPDATA ?? path.join(host.home, "AppData", "Roaming");
  const config = env.XDG_CONFIG_HOME ?? path.join(host.home, ".config");
  const support =
    host.platform === "darwin"
      ? path.join(host.home, "Library", "Application Support")
      : host.platform === "win32"
        ? appData
        : config;
  const file = async (target: string): Promise<boolean> =>
    mentions((await within(host.readText(target), timeoutMs)) ?? "", command);
  const claudeDir = path.join(support, "Claude");
  const extensions = path.join(claudeDir, "Claude Extensions");
  const checks: Record<DetectedClient, () => Promise<boolean>> = {
    "claude-code": async () =>
      mentions(
        (await within(
          host.run("claude", ["mcp", "get", "novamira-hq"]),
          timeoutMs,
        )) ?? "",
        command,
      ),
    codex: () =>
      file(
        path.join(
          env.CODEX_HOME ?? path.join(host.home, ".codex"),
          "config.toml",
        ),
      ),
    cursor: () => file(path.join(host.home, ".cursor", "mcp.json")),
    antigravity: () =>
      file(path.join(host.home, ".gemini", "config", "mcp_config.json")),
    vscode: () => file(path.join(support, "Code", "User", "mcp.json")),
    claude: async () => {
      if (await file(path.join(claudeDir, "claude_desktop_config.json")))
        return true;
      for (const entry of (await within(host.list(extensions), timeoutMs)) ??
        [])
        if (await file(path.join(extensions, entry, "launch.json")))
          return true;
      return false;
    },
  };
  const found = await Promise.all(
    DETECTION_ORDER.map((client) => checks[client]()),
  );
  return DETECTION_ORDER.filter((_, index) => found[index]);
}

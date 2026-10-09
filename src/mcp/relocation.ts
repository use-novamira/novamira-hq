// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { atomicWriteFile } from "../config/atomic-write.js";
import type { FileSecurity } from "../config/file-security.js";
import { asRecord } from "../json.js";

/** Old locations kept while clients may still start them. */
const MAX_PREVIOUS = 5;

/** The command AI clients were last configured with, and the ones before it. */
export interface LaunchRecord {
  readonly command: string;
  readonly previous?: readonly string[];
}

export async function readLaunchRecord(
  path: string,
): Promise<LaunchRecord | undefined> {
  try {
    const value = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (value?.version !== 1 || typeof value.command !== "string")
      return undefined;
    const previous = Array.isArray(value.previous)
      ? value.previous.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return previous.length > 0
      ? { command: value.command, previous }
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

export function sameLaunchRecord(
  left: LaunchRecord | undefined,
  right: LaunchRecord,
): boolean {
  return (
    left?.command === right.command &&
    (left.previous ?? []).join("\0") === (right.previous ?? []).join("\0")
  );
}

export function nextLaunchRecord(
  stored: LaunchRecord | undefined,
  current: string,
): LaunchRecord {
  if (!stored) return { command: current };
  if (stored.command === current) return stored;
  const previous = [stored.command, ...(stored.previous ?? [])]
    .filter(
      (entry, index, all) => entry !== current && all.indexOf(entry) === index,
    )
    .slice(0, MAX_PREVIOUS);
  return previous.length > 0
    ? { command: current, previous }
    : { command: current };
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
  exists(path: string): Promise<boolean>;
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

export const DETECTED_CLIENTS: readonly DetectedClient[] = [
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
  timeoutMs = 3_000,
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
    DETECTED_CLIENTS.map((client) => checks[client]()),
  );
  return DETECTED_CLIENTS.filter((_, index) => found[index]);
}

export interface NodeDetectionOptions {
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
}

/** Real files and client CLIs; output is bounded and never logged or stored. */
export function nodeDetectionHost(
  environment: NodeJS.ProcessEnv,
  options: NodeDetectionOptions = {},
): DetectionHost {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const spawnProcess = options.spawnProcess ?? spawn;
  const capture = (
    command: string,
    args: readonly string[],
  ): Promise<{ output?: string; missing: boolean }> =>
    new Promise((resolve) => {
      let settled = false;
      let output = "";
      const child = spawnProcess(command, [...args], {
        shell: false,
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const finish = (result: { output?: string; missing: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // A client waiting on a login prompt must not outlive detection.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ missing: false });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 65_536) {
          child.kill("SIGKILL");
          finish({ missing: false });
        }
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          missing: error.code === "ENOENT" || error.code === "EINVAL",
        });
      });
      child.on("close", (code: number | null) => {
        finish(code === 0 ? { output, missing: false } : { missing: false });
      });
    });
  return {
    platform,
    home: homedir(),
    environment,
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    list: (directory) => readdir(directory).catch(() => []),
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    run: async (command, args) => {
      const direct = await capture(command, args);
      if (!direct.missing || platform !== "win32") return direct.output;
      // npm installs `claude.cmd` and `codex.cmd`, which only a shell can
      // start. The command and its arguments are fixed words, never input.
      const shell = environment.ComSpec ?? "cmd.exe";
      return (
        await capture(shell, ["/d", "/s", "/c", [command, ...args].join(" ")])
      ).output;
    },
  };
}

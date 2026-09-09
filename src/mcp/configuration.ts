// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import type { McpConnectionService, McpLaunch } from "../mcp-connection.js";

/** JSON basic strings also represent these values safely in TOML. */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\\u0008/g, "\\b");
}

export function createMcpConnectionService(
  base: McpLaunch,
  environment: NodeJS.ProcessEnv,
): McpConnectionService {
  const configuration: McpConnectionService["configuration"] = () => {
    const launch = {
      command: base.command,
      args: [...base.args],
    };
    // Only HQ path overrides, never provider credentials or arbitrary env values.
    const env: Record<string, string> = {};
    for (const name of [
      "NOVAMIRA_HQ_HOME",
      "NOVAMIRA_HQ_CONFIG",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "APPDATA",
      "LOCALAPPDATA",
    ])
      if (environment[name]) env[name] = environment[name];
    return {
      launch,
      claude: JSON.stringify(
        {
          mcpServers: {
            "novamira-hq": {
              ...launch,
              ...(Object.keys(env).length ? { env } : {}),
            },
          },
        },
        null,
        2,
      ),
      chatgpt: [
        "[mcp_servers.novamira-hq]",
        `command = ${tomlString(launch.command)}`,
        `args = [${launch.args.map(tomlString).join(", ")}]`,
        ...(Object.keys(env).length
          ? [
              "[mcp_servers.novamira-hq.env]",
              ...Object.entries(env).map(
                ([name, value]) => `${name} = ${tomlString(value)}`,
              ),
            ]
          : []),
      ].join("\n"),
    };
  };
  return {
    configuration,
    async verify() {
      const { launch } = configuration();
      // Only initialize and tools/list; no tool execution and no provider calls.
      return new Promise((resolve, reject) => {
        const child = spawn(launch.command, [...launch.args], {
          shell: false,
          env: environment,
          stdio: ["pipe", "pipe", "ignore"],
        });
        let stdout = "";
        let settled = false;
        const fail = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(
            new CliError(
              "provider_error",
              "Local MCP startup verification failed. Check the executable and installation. No provider operation was requested.",
            ),
          );
        };
        const timer = setTimeout(fail, 10_000);
        child.on("error", fail);
        child.stdin.on("error", fail);
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout) > 262_144) fail();
        });
        child.on("close", (code) => {
          if (settled) return;
          if (code !== 0) {
            fail();
            return;
          }
          try {
            const replies = stdout
              .trim()
              .split("\n")
              .map((line) => asRecord(JSON.parse(line) as unknown));
            const initialized = asRecord(
              replies.find((reply) => reply?.id === 1)?.result,
            );
            const listed = asRecord(
              replies.find((reply) => reply?.id === 2)?.result,
            );
            if (
              typeof initialized?.protocolVersion !== "string" ||
              !Array.isArray(listed?.tools)
            ) {
              fail();
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ toolCount: listed.tools.length });
          } catch {
            fail();
          }
        });
        child.stdin.end(
          [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "novamira-hq-local-check", version: "1" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n") + "\n",
        );
      });
    },
  };
}

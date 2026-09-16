// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import type {
  McpClient,
  McpConnectionService,
  McpLaunch,
} from "../mcp-connection.js";

type SpawnProcess = typeof spawn;

function connectorArgv(
  client: McpClient,
  launch: McpLaunch,
  env: Readonly<Record<string, string>>,
): { readonly command: string; readonly args: readonly string[] } {
  const environmentArgs = Object.entries(env).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  if (client === "vscode") {
    return {
      command: "code",
      args: [
        "--add-mcp",
        JSON.stringify({ name: "novamira-hq", type: "stdio", ...launch, env }),
      ],
    };
  }
  if (client === "chatgpt" || client === "codex") {
    return {
      command: "codex",
      args: [
        "mcp",
        "add",
        "novamira-hq",
        ...environmentArgs,
        "--",
        launch.command,
        ...launch.args,
      ],
    };
  }
  return {
    command: "claude",
    args: [
      "mcp",
      "add",
      "--scope",
      "user",
      "novamira-hq",
      ...environmentArgs,
      "--",
      launch.command,
      ...launch.args,
    ],
  };
}

/** JSON basic strings also represent these values safely in TOML. */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\\u0008/g, "\\b");
}

export function createMcpConnectionService(
  base: McpLaunch,
  environment: NodeJS.ProcessEnv,
  spawnProcess: SpawnProcess = spawn,
): McpConnectionService {
  const configuration: McpConnectionService["configuration"] = () => {
    const launch = {
      command: base.command,
      args: [...base.args],
    };
    // Preserve only explicit HQ location settings, never the captured PATH.
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
    async connect(client) {
      const config = configuration();
      const launchEnvironment = JSON.parse(config.claude) as {
        mcpServers: Record<
          string,
          McpLaunch & { env?: Record<string, string> }
        >;
      };
      const inherited = launchEnvironment.mcpServers["novamira-hq"]?.env ?? {};
      const connector = connectorArgv(
        client,
        launchEnvironment.mcpServers["novamira-hq"] ?? config.launch,
        inherited,
      );
      const run = (args: readonly string[]): Promise<boolean> =>
        new Promise((resolve) => {
          const child = spawnProcess(connector.command, [...args], {
            shell: false,
            env: environment,
            stdio: "ignore",
          });
          let settled = false;
          const finish = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!ok) child.kill("SIGKILL");
            resolve(ok);
          };
          const timer = setTimeout(() => {
            finish(false);
          }, 10_000);
          child.on("error", () => {
            finish(false);
          });
          child.on("close", (code) => {
            finish(code === 0);
          });
        });

      if (client !== "vscode" && (await run(["mcp", "get", "novamira-hq"])))
        return "existing";
      if (await run(connector.args))
        return client === "vscode" ? "sent" : "configured";
      throw new CliError(
        "integration_unavailable",
        `${client === "vscode" ? "VS Code" : client === "claude-code" ? "Claude Code" : "Codex"} could not be configured automatically. Make sure its command-line client is installed, or use manual setup.`,
      );
    },
    async verify() {
      const { launch } = configuration();
      // Only initialize and tools/list; no tool execution and no provider calls.
      return new Promise((resolve, reject) => {
        const child = spawnProcess(launch.command, [...launch.args], {
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
              "Novamira HQ could not start or did not respond. Check that Novamira HQ is installed and available, then try again. No client settings or sites were changed.",
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

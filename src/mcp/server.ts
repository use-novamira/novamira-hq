// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { HostingProfileEntry } from "../config/profiles.js";
import type { ConfigStore } from "../config/profiles.js";
import type { HostingClientFactory } from "../hosting/factory.js";
import { asCliError, CliError } from "../errors.js";
import { redact, redactText } from "../output/redact.js";
import {
  requireCliAccess,
  type McpAccessPolicy,
  type McpCapability,
} from "./access.js";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

type RequestId = string | number;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpServerDependencies {
  readonly version: string;
  readonly store: ConfigStore;
  readonly hosting: HostingClientFactory;
  readonly access: McpAccessPolicy;
  executeCli(argv: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export interface McpStreams {
  readonly input: Readable;
  readonly output: { write(chunk: string): unknown };
}

const PROFILE_PROPERTY = {
  type: "string",
  minLength: 1,
  description: "Configured Novamira HQ hosting profile name.",
} as const;

const READ_TOOLS: readonly McpTool[] = [
  {
    name: "hosting_profiles_list",
    description: "List configured hosting profiles without credential values.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "hosting_provider_validate",
    description: "Validate a configured hosting profile with its provider.",
    inputSchema: objectSchema({ profile: PROFILE_PROPERTY }, ["profile"]),
  },
  {
    name: "hosting_capabilities_get",
    description: "Get capabilities supported by a hosting provider profile.",
    inputSchema: objectSchema({ profile: PROFILE_PROPERTY }, ["profile"]),
  },
  {
    name: "hosting_sites_list",
    description: "List hosting sites through a configured provider profile.",
    inputSchema: objectSchema(
      {
        profile: PROFILE_PROPERTY,
        includeEnvironments: { type: "boolean", default: false },
      },
      ["profile"],
    ),
  },
  {
    name: "hosting_site_get",
    description: "Get one hosting site by provider resource ID.",
    inputSchema: objectSchema(
      { profile: PROFILE_PROPERTY, siteId: nonEmptyString("Hosting site ID.") },
      ["profile", "siteId"],
    ),
  },
  {
    name: "hosting_environments_list",
    description: "List environments belonging to one hosting site.",
    inputSchema: objectSchema(
      { profile: PROFILE_PROPERTY, siteId: nonEmptyString("Hosting site ID.") },
      ["profile", "siteId"],
    ),
  },
  {
    name: "hosting_operation_get",
    description: "Get the current status of a provider operation.",
    inputSchema: objectSchema(
      {
        profile: PROFILE_PROPERTY,
        operationId: nonEmptyString("Provider operation ID."),
      },
      ["profile", "operationId"],
    ),
  },
];

const CLI_TOOL: McpTool = {
  name: "novamira_hq_cli",
  description:
    "Run a Novamira HQ command permitted by the MCP server launch flags. Pass argv without the executable name. This can mutate or delete hosting resources when the corresponding capability is enabled.",
  inputSchema: objectSchema(
    {
      argv: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        description:
          'Arguments after novamira-hq, for example ["--profile", "prod", "hosting", "sites", "list"].',
      },
    },
    ["argv"],
  ),
};

function toolsFor(access: McpAccessPolicy): readonly McpTool[] {
  const tools: McpTool[] = [];
  if (access.capabilities.has("config")) tools.push(...READ_TOOLS.slice(0, 1));
  if (access.capabilities.has("hosting-read"))
    tools.push(...READ_TOOLS.slice(1));
  if (access.capabilities.size > 0) tools.push(CLI_TOOL);
  return tools;
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

function nonEmptyString(
  description: string,
): Readonly<Record<string, unknown>> {
  return { type: "string", minLength: 1, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): JsonRpcRequest | undefined {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string"
  )
    return undefined;
  if (
    "id" in value &&
    typeof value.id !== "string" &&
    typeof value.id !== "number"
  )
    return undefined;
  const id = value.id;
  const params = value.params;
  return {
    jsonrpc: "2.0",
    ...(typeof id === "string" || typeof id === "number" ? { id } : {}),
    method: value.method,
    ...(params === undefined ? {} : { params }),
  };
}

function profileSummary(
  entry: HostingProfileEntry,
): Readonly<Record<string, unknown>> {
  return {
    name: entry.name,
    provider: entry.profile.provider,
    ...(entry.profile.companyId === undefined
      ? {}
      : { companyId: entry.profile.companyId }),
    ...(entry.profile.apiBaseUrl === undefined
      ? {}
      : { apiBaseUrl: entry.profile.apiBaseUrl }),
  };
}

function requiredString(
  argumentsValue: Record<string, unknown>,
  name: string,
): string {
  const value = argumentsValue[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new CliError(
      "usage_error",
      `Tool argument ${name} must be a non-empty string.`,
    );
  return value;
}

function toolResult(value: unknown): Readonly<Record<string, unknown>> {
  const safe = redact(value);
  return { content: [{ type: "text", text: JSON.stringify(safe) }] };
}

function toolError(error: unknown): Readonly<Record<string, unknown>> {
  const cliError = asCliError(error);
  const safe = redact({
    code: cliError.code,
    message: redactText(cliError.message),
    retryable: cliError.retryable,
    ...(cliError.remoteCode === undefined
      ? {}
      : { remoteCode: cliError.remoteCode }),
    ...(cliError.details === undefined ? {} : { details: cliError.details }),
  });
  return {
    content: [{ type: "text", text: JSON.stringify(safe) }],
    isError: true,
  };
}

function cliArgv(argumentsValue: Record<string, unknown>): string[] {
  const value = argumentsValue.argv;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === "string")
  )
    throw new CliError(
      "usage_error",
      "Tool argument argv must be a non-empty array of strings.",
    );
  if (value.some((argument) => argument === "mcp"))
    throw new CliError("usage_error", "The MCP command cannot invoke itself.");
  if (
    value.some(
      (argument, index) =>
        argument === "--credential-stdin" ||
        argument === "--admin-password-stdin" ||
        argument === "--password-stdin" ||
        argument === "--command-stdin" ||
        (argument === "--from-json" && value[index + 1] === "-"),
    )
  )
    throw new CliError(
      "usage_error",
      "MCP command execution cannot read secrets, payloads, or commands from stdin.",
    );
  return value;
}

async function callTool(
  dependencies: McpServerDependencies,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    if (name === "novamira_hq_cli") {
      const argv = cliArgv(argumentsValue);
      const capability: McpCapability = requireCliAccess(
        dependencies.access,
        argv,
      );
      const result = await dependencies.executeCli(argv);
      const safe = redact({ capability, ...result });
      return {
        content: [{ type: "text", text: JSON.stringify(safe) }],
        ...(result.exitCode === 0 ? {} : { isError: true }),
      };
    }
    if (name === "hosting_profiles_list")
      return toolResult(
        (await dependencies.store.listHostingProfiles()).map(profileSummary),
      );

    const profile = requiredString(argumentsValue, "profile");
    const client = await dependencies.hosting.clientFromProfile(profile);
    switch (name) {
      case "hosting_provider_validate":
        return toolResult(await client.validate());
      case "hosting_capabilities_get":
        return toolResult(await client.read({ kind: "capabilities" }));
      case "hosting_sites_list": {
        const includeEnvironments = argumentsValue.includeEnvironments;
        if (
          includeEnvironments !== undefined &&
          typeof includeEnvironments !== "boolean"
        )
          throw new CliError(
            "usage_error",
            "Tool argument includeEnvironments must be a boolean.",
          );
        return toolResult(
          await client.listSites({
            includeEnvironments: includeEnvironments === true,
          }),
        );
      }
      case "hosting_site_get":
        return toolResult(
          await client.getSite(requiredString(argumentsValue, "siteId")),
        );
      case "hosting_environments_list":
        return toolResult(
          await client.listEnvironments(
            requiredString(argumentsValue, "siteId"),
          ),
        );
      case "hosting_operation_get":
        return toolResult(
          await client.operationStatus(
            requiredString(argumentsValue, "operationId"),
          ),
        );
      default:
        throw new CliError("usage_error", `Unknown MCP tool: ${name}.`);
    }
  } catch (error) {
    return toolError(error);
  }
}

export async function runMcpServer(
  dependencies: McpServerDependencies,
  streams: McpStreams = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
  let initialized = false;
  let ready = false;
  let queue = Promise.resolve();

  const write = (message: unknown): void => {
    streams.output.write(`${JSON.stringify(message)}\n`);
  };
  const success = (id: RequestId, result: unknown): void => {
    write({ jsonrpc: "2.0", id, result });
  };
  const failure = (
    id: RequestId | null,
    code: number,
    message: string,
  ): void => {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const handle = async (line: string): Promise<void> => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      failure(null, -32700, "Parse error");
      return;
    }
    const request = parseRequest(value);
    if (request === undefined) {
      failure(null, -32600, "Invalid Request");
      return;
    }
    const notification = request.id === undefined;
    if (request.method === "notifications/initialized") {
      if (initialized) ready = true;
      return;
    }
    if (notification) return;
    const id = request.id;

    if (request.method === "ping") {
      success(id, {});
      return;
    }
    if (request.method === "initialize") {
      if (
        !isRecord(request.params) ||
        typeof request.params.protocolVersion !== "string"
      ) {
        failure(id, -32602, "Invalid initialize params");
        return;
      }
      const requested = request.params.protocolVersion;
      const protocolVersion = (
        SUPPORTED_PROTOCOL_VERSIONS as readonly string[]
      ).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      initialized = true;
      success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "novamira-hq", version: dependencies.version },
      });
      return;
    }
    if (!ready) {
      failure(id, -32600, "MCP session is not initialized");
      return;
    }
    if (request.method === "tools/list") {
      if (request.params !== undefined && !isRecord(request.params)) {
        failure(id, -32602, "Invalid tools/list params");
        return;
      }
      success(id, { tools: toolsFor(dependencies.access) });
      return;
    }
    if (request.method === "tools/call") {
      if (
        !isRecord(request.params) ||
        typeof request.params.name !== "string"
      ) {
        failure(id, -32602, "Invalid tools/call params");
        return;
      }
      const argumentsValue = request.params.arguments ?? {};
      if (!isRecord(argumentsValue)) {
        failure(id, -32602, "Tool arguments must be an object");
        return;
      }
      const toolName = request.params.name;
      if (
        !toolsFor(dependencies.access).some((tool) => tool.name === toolName)
      ) {
        failure(id, -32602, "Unknown tool");
        return;
      }
      success(id, await callTool(dependencies, toolName, argumentsValue));
      return;
    }
    failure(id, -32601, "Method not found");
  };

  lines.on("line", (line) => {
    queue = queue.then(() => handle(line));
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await queue;
}

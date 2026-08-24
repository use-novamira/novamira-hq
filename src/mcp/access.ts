// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";

export const MCP_CAPABILITIES = [
  "config",
  "hosting-read",
  "hosting-write",
  "provisioning",
  "dashboard",
  "doctor",
  "skills",
  "update",
] as const;

export type McpCapability = (typeof MCP_CAPABILITIES)[number];

export interface McpAccessPolicy {
  readonly capabilities: ReadonlySet<McpCapability>;
}

const ALL_CAPABILITIES: ReadonlySet<McpCapability> = new Set(MCP_CAPABILITIES);
const READ_CAPABILITIES: ReadonlySet<McpCapability> = new Set([
  "config",
  "hosting-read",
  "doctor",
  "skills",
]);

function capability(value: string): McpCapability {
  if ((MCP_CAPABILITIES as readonly string[]).includes(value))
    return value as McpCapability;
  throw new CliError(
    "usage_error",
    `Unknown MCP capability ${value}. Expected one of: ${MCP_CAPABILITIES.join(", ")}.`,
  );
}

export function parseMcpAccess(argv: readonly string[]): McpAccessPolicy {
  let preset: "all" | "read" = "all";
  const allowed: McpCapability[] = [];
  const denied: McpCapability[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--access") {
      if (value !== "all" && value !== "read")
        throw new CliError(
          "usage_error",
          "--access must be either all or read.",
        );
      preset = value;
      index += 1;
    } else if (argument === "--allow" || argument === "--deny") {
      if (value === undefined)
        throw new CliError("usage_error", `${argument} requires a capability.`);
      (argument === "--allow" ? allowed : denied).push(capability(value));
      index += 1;
    } else {
      throw new CliError(
        "usage_error",
        `Unknown MCP option ${String(argument)}.`,
      );
    }
  }

  const selected = new Set(
    allowed.length > 0
      ? allowed
      : preset === "all"
        ? ALL_CAPABILITIES
        : READ_CAPABILITIES,
  );
  for (const value of denied) selected.delete(value);
  return { capabilities: selected };
}

const READ_HOSTING_PATHS: ReadonlySet<string> = new Set([
  "providers validate",
  "providers capabilities",
  "regions list",
  "activity list",
  "ops get",
  "ops wait",
  "sites list",
  "sites get",
  "envs list",
  "envs get",
  "domains list",
  "domains verify",
  "dns domains list",
  "dns records list",
  "backups list",
  "backups downloadable",
  "redirects list",
  "denied-ips list",
  "access ssh status",
  "access ssh allowlist",
  "access ssh config",
  "access ssh password",
  "access sftp list",
  "wp plugins list",
  "wp themes list",
  "logs get",
  "analytics usage",
  "analytics env",
]);

const VALUE_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "--profile",
  "--timeout",
]);
const BOOLEAN_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "--json",
  "--yes",
  "--no-color",
  "--quiet",
  "--verbose",
  "--version",
]);

function commandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (VALUE_GLOBAL_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (BOOLEAN_GLOBAL_OPTIONS.has(value)) continue;
    if (!value.startsWith("-")) words.push(value);
  }
  return words;
}

export function capabilityForCliArgv(argv: readonly string[]): McpCapability {
  const words = commandWords(argv);
  const root = words[0];
  if (root === "config") return "config";
  if (root === "dashboard") return "dashboard";
  if (root === "doctor") return "doctor";
  if (root === "skills") return "skills";
  if (root === "update") return "update";
  if (root !== "hosting")
    throw new CliError(
      "usage_error",
      "CLI argv must name a supported novamira-hq command.",
    );

  const path = words.slice(1, 5).join(" ");
  if (path.startsWith("novamira setup")) return "provisioning";
  if (path.startsWith("wp plugins install")) return "provisioning";
  for (const readPath of READ_HOSTING_PATHS)
    if (path === readPath || path.startsWith(`${readPath} `))
      return "hosting-read";
  return "hosting-write";
}

export function requireCliAccess(
  policy: McpAccessPolicy,
  argv: readonly string[],
): McpCapability {
  const required = capabilityForCliArgv(argv);
  if (!policy.capabilities.has(required))
    throw new CliError(
      "confirmation_required",
      `The MCP server was not launched with the ${required} capability.`,
      { details: { requiredCapability: required } },
    );
  return required;
}

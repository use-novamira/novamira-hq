// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";

export const MCP_CAPABILITIES = [
  "profiles-read",
  "hosting-read",
  "maintenance",
  "provisioning",
  "deploy",
] as const;

export type McpCapability = (typeof MCP_CAPABILITIES)[number];

export interface McpAccessPolicy {
  readonly capabilities: ReadonlySet<McpCapability>;
}

const READ_CAPABILITIES: ReadonlySet<McpCapability> = new Set([
  "profiles-read",
  "hosting-read",
]);
const STANDARD_CAPABILITIES: ReadonlySet<McpCapability> = new Set([
  ...READ_CAPABILITIES,
  "maintenance",
  "provisioning",
]);
const ALL_CAPABILITIES: ReadonlySet<McpCapability> = new Set(MCP_CAPABILITIES);

function capability(value: string): McpCapability {
  if ((MCP_CAPABILITIES as readonly string[]).includes(value))
    return value as McpCapability;
  throw new CliError(
    "usage_error",
    `Unknown MCP capability ${value}. Expected one of: ${MCP_CAPABILITIES.join(", ")}.`,
  );
}

export function parseMcpAccess(argv: readonly string[]): McpAccessPolicy {
  let preset: "read" | "standard" | "all" = "standard";
  const allowed: McpCapability[] = [];
  const denied: McpCapability[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--access") {
      if (value !== "read" && value !== "standard" && value !== "all")
        throw new CliError(
          "usage_error",
          "--access must be read, standard, or all.",
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
      : preset === "read"
        ? READ_CAPABILITIES
        : preset === "standard"
          ? STANDARD_CAPABILITIES
          : ALL_CAPABILITIES,
  );
  for (const value of denied) selected.delete(value);
  return { capabilities: selected };
}

export function requireMcpAccess(
  policy: McpAccessPolicy,
  required: McpCapability,
): void {
  if (policy.capabilities.has(required)) return;
  throw new CliError(
    "confirmation_required",
    `The MCP server was not launched with the ${required} capability.`,
    { details: { requiredCapability: required } },
  );
}

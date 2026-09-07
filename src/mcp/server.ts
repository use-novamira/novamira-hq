// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { HostingProfileEntry } from "../config/profiles.js";
import type { ConfigStore } from "../config/profiles.js";
import { asCliError, CliError } from "../errors.js";
import { applyHqCapabilityPolicy } from "../hosting/capabilities.js";
import {
  executeBackupRestore,
  prepareBackupRestore,
  type BackupRestorePlan,
  type BackupRestoreSelection,
} from "../hosting/backup-restore.js";
import {
  executeEnvironmentPush,
  prepareEnvironmentPush,
  type EnvironmentPushPlan,
  type EnvironmentPushSelection,
} from "../hosting/environment-push.js";
import type { HostingClientFactory } from "../hosting/factory.js";
import type { ProviderClient } from "../hosting/client.js";
import { redact, redactText } from "../output/redact.js";
import {
  requireMcpAccess,
  type McpAccessPolicy,
  type McpCapability,
} from "./access.js";

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const PUSH_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_PUSH_PLANS = 64;
const RESTORE_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_RESTORE_PLANS = 64;

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
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

interface StoredPushPlan {
  readonly client: ProviderClient;
  readonly plan: EnvironmentPushPlan;
  readonly expiresAt: number;
}

interface StoredRestorePlan {
  readonly client: ProviderClient;
  readonly plan: BackupRestorePlan;
  readonly expiresAt: number;
}

interface McpServerState {
  readonly pushPlans: Map<string, StoredPushPlan>;
  readonly restorePlans: Map<string, StoredRestorePlan>;
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
  /** Test seam; production uses a cryptographically random UUID. */
  readonly createPushConfirmationId?: () => string;
  /** Test seam; production uses a cryptographically random UUID. */
  readonly createRestoreConfirmationId?: () => string;
  /** Test seam; production uses the wall clock. */
  readonly now?: () => number;
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

function annotations(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint = false,
): McpTool["annotations"] {
  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint: true,
  };
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

const PUSH_PROPERTIES = {
  profile: PROFILE_PROPERTY,
  siteId: nonEmptyString("Hosting site ID containing both environments."),
  sourceEnvironmentId: nonEmptyString("Source environment ID."),
  targetEnvironmentId: nonEmptyString("Target environment ID."),
  database: {
    type: "boolean",
    default: false,
    description: "Push the database. Never enabled implicitly.",
  },
  allFiles: {
    type: "boolean",
    default: false,
    description: "Push every file. Mutually exclusive with files.",
  },
  files: {
    type: "array",
    default: [],
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
    description: "Explicit file paths to push instead of every file.",
  },
  searchReplace: {
    type: "boolean",
    default: false,
    description: "Run URL search/replace; requires database=true.",
  },
} as const;

const RESTORE_PROPERTIES = {
  profile: PROFILE_PROPERTY,
  targetEnvironmentId: nonEmptyString("Environment that will be overwritten."),
  backupId: nonEmptyString("Backup id from that environment's catalog."),
  allContent: {
    type: "boolean",
    description: "Must be true to acknowledge a complete content overwrite.",
  },
  notifiedUserId: nonEmptyString(
    "Kinsta user id to notify; required only for Kinsta.",
  ),
} as const;

const TOOL_DEFINITIONS: readonly (McpTool & {
  readonly capability: McpCapability;
})[] = [
  {
    name: "hosting_profiles_list",
    description: "List configured hosting profiles without credential values.",
    inputSchema: { type: "object", additionalProperties: false },
    annotations: annotations(true, false, true),
    capability: "profiles-read",
  },
  {
    name: "hosting_provider_validate",
    description: "Validate a configured hosting profile with its provider.",
    inputSchema: objectSchema({ profile: PROFILE_PROPERTY }, ["profile"]),
    annotations: annotations(true, false),
    capability: "hosting-read",
  },
  {
    name: "hosting_capabilities_get",
    description:
      "Get the provider capabilities after Novamira HQ safety policy is applied.",
    inputSchema: objectSchema({ profile: PROFILE_PROPERTY }, ["profile"]),
    annotations: annotations(true, false, true),
    capability: "hosting-read",
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
    annotations: annotations(true, false),
    capability: "hosting-read",
  },
  {
    name: "hosting_site_get",
    description: "Get one hosting site by provider resource ID.",
    inputSchema: objectSchema(
      { profile: PROFILE_PROPERTY, siteId: nonEmptyString("Hosting site ID.") },
      ["profile", "siteId"],
    ),
    annotations: annotations(true, false),
    capability: "hosting-read",
  },
  {
    name: "hosting_environments_list",
    description: "List environments belonging to one hosting site.",
    inputSchema: objectSchema(
      { profile: PROFILE_PROPERTY, siteId: nonEmptyString("Hosting site ID.") },
      ["profile", "siteId"],
    ),
    annotations: annotations(true, false),
    capability: "hosting-read",
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
    annotations: annotations(true, false),
    capability: "hosting-read",
  },
  {
    name: "hosting_backup_create",
    description: "Create a backup of one hosting environment.",
    inputSchema: objectSchema(
      {
        profile: PROFILE_PROPERTY,
        environmentId: nonEmptyString("Hosting environment ID."),
        tag: nonEmptyString("Optional provider backup label."),
      },
      ["profile", "environmentId"],
    ),
    annotations: annotations(false, false),
    capability: "maintenance",
  },
  {
    name: "hosting_novamira_setup",
    description:
      "Provision the Novamira plugin on one environment and return the site CLI handoff.",
    inputSchema: objectSchema(
      {
        profile: PROFILE_PROPERTY,
        environmentId: nonEmptyString("Hosting environment ID."),
        url: nonEmptyString("Optional WordPress site URL override."),
        enableAiAbilities: {
          type: "boolean",
          default: true,
          description: "Enable Novamira AI abilities during provisioning.",
        },
      },
      ["profile", "environmentId"],
    ),
    annotations: annotations(false, false),
    capability: "provisioning",
  },
  {
    name: "hosting_environment_push_plan",
    description:
      "Validate an explicit environment-push scope and issue a short-lived one-use confirmation ID. No mutation is performed.",
    inputSchema: objectSchema(PUSH_PROPERTIES, [
      "profile",
      "siteId",
      "sourceEnvironmentId",
      "targetEnvironmentId",
    ]),
    annotations: annotations(true, false),
    capability: "deploy",
  },
  {
    name: "hosting_environment_push_apply",
    description:
      "Apply a one-use push plan. HQ first creates and awaits a safety backup of the target environment.",
    inputSchema: objectSchema(
      {
        confirmationId: nonEmptyString(
          "One-use ID returned by hosting_environment_push_plan.",
        ),
      },
      ["confirmationId"],
    ),
    annotations: annotations(false, true),
    capability: "deploy",
  },
  {
    name: "hosting_backup_restore_plan",
    description:
      "Verify a backup in its target environment and issue a short-lived one-use recovery confirmation ID. No mutation is performed.",
    inputSchema: objectSchema(RESTORE_PROPERTIES, [
      "profile",
      "targetEnvironmentId",
      "backupId",
      "allContent",
    ]),
    annotations: annotations(true, false),
    capability: "recovery",
  },
  {
    name: "hosting_backup_restore_apply",
    description:
      "Apply a one-use restore plan. HQ first creates and awaits a fresh safety backup of the target environment.",
    inputSchema: objectSchema(
      {
        confirmationId: nonEmptyString(
          "One-use ID returned by hosting_backup_restore_plan.",
        ),
      },
      ["confirmationId"],
    ),
    annotations: annotations(false, true),
    capability: "recovery",
  },
];

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function toolsFor(access: McpAccessPolicy): readonly McpTool[] {
  return TOOL_DEFINITIONS.filter((tool) =>
    access.capabilities.has(tool.capability),
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
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
  return value.trim();
}

function optionalBoolean(
  argumentsValue: Record<string, unknown>,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = argumentsValue[name];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean")
    throw new CliError(
      "usage_error",
      `Tool argument ${name} must be a boolean.`,
    );
  return value;
}

function optionalStringArray(
  argumentsValue: Record<string, unknown>,
  name: string,
): readonly string[] {
  const value = argumentsValue[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new CliError(
      "usage_error",
      `Tool argument ${name} must be an array of strings.`,
    );
  return value;
}

function pushSelection(
  argumentsValue: Record<string, unknown>,
): EnvironmentPushSelection {
  return {
    siteId: requiredString(argumentsValue, "siteId"),
    sourceEnvironmentId: requiredString(argumentsValue, "sourceEnvironmentId"),
    targetEnvironmentId: requiredString(argumentsValue, "targetEnvironmentId"),
    database: optionalBoolean(argumentsValue, "database", false),
    allFiles: optionalBoolean(argumentsValue, "allFiles", false),
    files: optionalStringArray(argumentsValue, "files"),
    searchReplace: optionalBoolean(argumentsValue, "searchReplace", false),
  };
}

function restoreSelection(
  argumentsValue: Record<string, unknown>,
): BackupRestoreSelection {
  const notifiedUserId = argumentsValue.notifiedUserId;
  return {
    targetEnvironmentId: requiredString(argumentsValue, "targetEnvironmentId"),
    backupId: requiredString(argumentsValue, "backupId"),
    allContent: optionalBoolean(argumentsValue, "allContent", false),
    ...(notifiedUserId === undefined
      ? {}
      : { notifiedUserId: requiredString(argumentsValue, "notifiedUserId") }),
  };
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

function parseCliOutput(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): unknown {
  const stdout = result.stdout.trim();
  if (stdout !== "") {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      // A malformed envelope is returned as redacted diagnostics below.
    }
  }
  return result;
}

async function setupNovamira(
  dependencies: McpServerDependencies,
  argumentsValue: Record<string, unknown>,
): Promise<Readonly<Record<string, unknown>>> {
  const profile = requiredString(argumentsValue, "profile");
  const environmentId = requiredString(argumentsValue, "environmentId");
  const argv = [
    "--profile",
    profile,
    "--json",
    "--quiet",
    "hosting",
    "novamira",
    "setup",
    "--env",
    environmentId,
  ];
  if (argumentsValue.url !== undefined)
    argv.push("--url", requiredString(argumentsValue, "url"));
  if (!optionalBoolean(argumentsValue, "enableAiAbilities", true))
    argv.push("--no-ai-abilities");
  const result = await dependencies.executeCli(argv);
  return {
    ...toolResult(parseCliOutput(result)),
    ...(result.exitCode === 0 ? {} : { isError: true }),
  };
}

async function callTool(
  dependencies: McpServerDependencies,
  state: McpServerState,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const definition = TOOL_BY_NAME.get(name);
    if (definition === undefined)
      throw new CliError("usage_error", `Unknown MCP tool: ${name}.`);
    requireMcpAccess(dependencies.access, definition.capability);

    if (name === "hosting_profiles_list")
      return toolResult(
        (await dependencies.store.listHostingProfiles()).map(profileSummary),
      );
    if (name === "hosting_novamira_setup")
      return await setupNovamira(dependencies, argumentsValue);

    if (name === "hosting_environment_push_apply") {
      const confirmationId = requiredString(argumentsValue, "confirmationId");
      const stored = state.pushPlans.get(confirmationId);
      state.pushPlans.delete(confirmationId);
      if (
        stored === undefined ||
        stored.expiresAt <= (dependencies.now?.() ?? Date.now())
      )
        throw new CliError(
          "not_found",
          "The environment push plan is missing, expired, or already used.",
        );
      return toolResult(
        await executeEnvironmentPush(stored.client, stored.plan),
      );
    }

    if (name === "hosting_backup_restore_apply") {
      const confirmationId = requiredString(argumentsValue, "confirmationId");
      const stored = state.restorePlans.get(confirmationId);
      state.restorePlans.delete(confirmationId);
      if (
        stored === undefined ||
        stored.expiresAt <= (dependencies.now?.() ?? Date.now())
      )
        throw new CliError(
          "not_found",
          "The backup restore plan is missing, expired, or already used.",
        );
      return toolResult(await executeBackupRestore(stored.client, stored.plan));
    }

    const profile = requiredString(argumentsValue, "profile");
    const client = await dependencies.hosting.clientFromProfile(profile);
    switch (name) {
      case "hosting_provider_validate":
        return toolResult(await client.validate());
      case "hosting_capabilities_get":
        return toolResult(
          applyHqCapabilityPolicy(await client.read({ kind: "capabilities" })),
        );
      case "hosting_sites_list":
        return toolResult(
          await client.listSites({
            includeEnvironments: optionalBoolean(
              argumentsValue,
              "includeEnvironments",
              false,
            ),
          }),
        );
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
      case "hosting_backup_create": {
        const tag = argumentsValue.tag;
        return toolResult(
          await client.action({
            kind: "create-backup",
            envId: requiredString(argumentsValue, "environmentId"),
            body:
              tag === undefined
                ? {}
                : { tag: requiredString(argumentsValue, "tag") },
          }),
        );
      }
      case "hosting_environment_push_plan": {
        const plan = await prepareEnvironmentPush(
          client,
          pushSelection(argumentsValue),
        );
        const confirmationId =
          dependencies.createPushConfirmationId?.() ?? randomUUID();
        const now = dependencies.now?.() ?? Date.now();
        const expiresAt = now + PUSH_PLAN_TTL_MS;
        for (const [id, stored] of state.pushPlans)
          if (stored.expiresAt <= now) state.pushPlans.delete(id);
        if (state.pushPlans.size >= MAX_PUSH_PLANS)
          throw new CliError(
            "conflict",
            "Too many pending environment push plans; apply one or wait for expiry.",
          );
        if (state.pushPlans.has(confirmationId))
          throw new CliError(
            "conflict",
            "Could not allocate a unique environment push confirmation ID.",
          );
        state.pushPlans.set(confirmationId, { client, plan, expiresAt });
        return toolResult({
          confirmationId,
          expiresAt: new Date(expiresAt).toISOString(),
          plan,
        });
      }
      case "hosting_backup_restore_plan": {
        const plan = await prepareBackupRestore(
          client,
          restoreSelection(argumentsValue),
        );
        const confirmationId =
          dependencies.createRestoreConfirmationId?.() ?? randomUUID();
        const now = dependencies.now?.() ?? Date.now();
        const expiresAt = now + RESTORE_PLAN_TTL_MS;
        for (const [id, stored] of state.restorePlans)
          if (stored.expiresAt <= now) state.restorePlans.delete(id);
        if (state.restorePlans.size >= MAX_RESTORE_PLANS)
          throw new CliError(
            "conflict",
            "Too many pending backup restore plans; apply one or wait for expiry.",
          );
        if (state.restorePlans.has(confirmationId))
          throw new CliError(
            "conflict",
            "Could not allocate a unique backup restore confirmation ID.",
          );
        state.restorePlans.set(confirmationId, { client, plan, expiresAt });
        return toolResult({
          confirmationId,
          expiresAt: new Date(expiresAt).toISOString(),
          plan,
        });
      }
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
  const state: McpServerState = {
    pushPlans: new Map(),
    restorePlans: new Map(),
  };
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
      const definition = TOOL_BY_NAME.get(toolName);
      if (
        definition === undefined ||
        !dependencies.access.capabilities.has(definition.capability)
      ) {
        failure(id, -32602, "Unknown tool");
        return;
      }
      success(
        id,
        await callTool(dependencies, state, toolName, argumentsValue),
      );
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

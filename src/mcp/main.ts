// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Readable } from "node:stream";
import { ConfigStore } from "../config/profiles.js";
import { defaultFileSecurity } from "../config/file-security.js";
import { platformPaths, type PathEnvironment } from "../config/paths.js";
import { ProfileLockManager } from "../config/lock.js";
import {
  createCredentialStore,
  type CredentialStore,
} from "../credentials/store.js";
import { resolveCredential } from "../credentials/resolve.js";
import {
  createHostingClientFactory,
  type ProviderRegistry,
} from "../hosting/factory.js";
import { PROVIDER_REGISTRY } from "../hosting/providers/index.js";
import { VERSION } from "../version.js";
import { runMcpServer } from "./server.js";
import { createMcpOnboarding } from "./onboarding.js";
import { openInBrowser } from "../browser.js";
import { CliError } from "../errors.js";
import { main } from "../main.js";
import type { MainOverrides } from "../main.js";
import { HistoryStore } from "../history/index.js";
import { historyClient } from "../history/client.js";
import {
  createSiteOperations,
  createSiteCliResolver,
  nodeSpawnChild,
  nodeIsFile,
} from "../integration/index.js";

export interface McpEnvironment extends PathEnvironment, NodeJS.ProcessEnv {}

export interface McpMainOverrides {
  readonly siteCliLaunch?: MainOverrides["siteCliLaunch"];
  readonly distribution?: MainOverrides["distribution"];
  readonly mcpLaunch?: MainOverrides["mcpLaunch"];
  readonly registry?: ProviderRegistry;
  readonly openBrowser?: (url: string) => Promise<void>;
}

export async function mcpMain(
  argv: readonly string[],
  streams: {
    readonly input: Readable;
    readonly output: { write(chunk: string): unknown };
  } = { input: process.stdin, output: process.stdout },
  environment: McpEnvironment = process.env,
  overrides: McpMainOverrides = {},
): Promise<void> {
  const paths = platformPaths(environment);
  const launchOverrides = {
    ...(overrides.siteCliLaunch === undefined
      ? {}
      : { siteCliLaunch: overrides.siteCliLaunch }),
    ...(overrides.distribution === undefined
      ? {}
      : { distribution: overrides.distribution }),
    ...(overrides.mcpLaunch === undefined
      ? {}
      : { mcpLaunch: overrides.mcpLaunch }),
  };
  const security = defaultFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  const store = new ConfigStore(paths.configFile, locks, security);
  const history = new HistoryStore(paths, locks, security);
  let pendingCredentials: Promise<CredentialStore> | undefined;
  const credentialStore = (): Promise<CredentialStore> => {
    pendingCredentials ??= createCredentialStore(
      paths.credentialsDir,
      security,
    );
    return pendingCredentials;
  };
  const hosting = createHostingClientFactory({
    decorateClient: (client, profile) =>
      historyClient(client, profile, history, () => "mcp"),
    store,
    registry: overrides.registry ?? PROVIDER_REGISTRY,
    env: environment,
    resolver: {
      resolve: async (ref) =>
        resolveCredential(ref, {
          env: environment,
          security,
          ...(ref.type === "stored" ? { store: await credentialStore() } : {}),
        }),
    },
  });

  if (argv.length > 0)
    throw new CliError("usage_error", "MCP accepts no launch options.");
  const executeCli = async (
    commandArgv: readonly string[],
  ): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> => {
    let stdout = "";
    let stderr = "";
    const exitCode = await main(
      commandArgv,
      {
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) },
      },
      environment,
      {
        historyChannel: "mcp",
        ...launchOverrides,
        ...(overrides.registry === undefined
          ? {}
          : { registry: overrides.registry }),
      },
    );
    return { exitCode, stdout, stderr };
  };

  const dashboardLifecycle = new AbortController();
  let dashboardTask: Promise<number> | undefined;
  const onboarding = createMcpOnboarding({
    openBrowser: overrides.openBrowser ?? openInBrowser,
    start: () =>
      new Promise<string>((resolve, reject) => {
        // Reuse the complete dashboard composition, consent and credential forms.
        // Its output is discarded, never forwarded to the MCP transport.
        dashboardTask = main(
          ["dashboard", "--json", "--listen", "127.0.0.1:0"],
          {
            stdout: { write: () => undefined },
            stderr: { write: () => undefined },
          },
          environment,
          {
            ...launchOverrides,
            ...(overrides.registry === undefined
              ? {}
              : { registry: overrides.registry }),
            dashboard: {
              signal: dashboardLifecycle.signal,
              onReady: (bound) => {
                resolve(bound.url);
              },
            },
          },
        );
        void dashboardTask.then(
          () => {
            reject(new Error("Dashboard stopped"));
          },
          () => {
            reject(new Error("Dashboard unavailable"));
          },
        );
      }),
  });
  try {
    await runMcpServer(
      {
        onboarding,
        version: VERSION,
        store,
        hosting,
        history,
        executeCli,
        siteOperations: createSiteOperations({
          resolve: createSiteCliResolver({
            environment,
            platform: process.platform,
            isFile: nodeIsFile,
            ...(overrides.siteCliLaunch === undefined
              ? {}
              : { packagedTarget: overrides.siteCliLaunch }),
          }),
          spawn: nodeSpawnChild,
          environment,
        }),
      },
      streams,
    );
  } finally {
    dashboardLifecycle.abort();
    await dashboardTask;
  }
}

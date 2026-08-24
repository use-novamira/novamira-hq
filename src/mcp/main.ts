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
import { parseMcpAccess } from "./access.js";
import { main } from "../main.js";

export interface McpEnvironment extends PathEnvironment, NodeJS.ProcessEnv {}

export interface McpMainOverrides {
  readonly registry?: ProviderRegistry;
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
  const security = defaultFileSecurity();
  const locks = new ProfileLockManager(paths.stateDir, security);
  const store = new ConfigStore(paths.configFile, locks, security);
  let pendingCredentials: Promise<CredentialStore> | undefined;
  const credentialStore = (): Promise<CredentialStore> => {
    pendingCredentials ??= createCredentialStore(
      paths.credentialsDir,
      security,
    );
    return pendingCredentials;
  };
  const hosting = createHostingClientFactory({
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

  const access = parseMcpAccess(argv);
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
        ...(overrides.registry === undefined
          ? {}
          : { registry: overrides.registry }),
      },
    );
    return { exitCode, stdout, stderr };
  };

  await runMcpServer(
    { version: VERSION, store, hosting, access, executeCli },
    streams,
  );
}

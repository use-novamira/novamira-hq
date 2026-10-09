// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Non-secret launch information shared by the composition root and dashboard. */
export interface McpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface McpConfiguration {
  readonly launch: McpLaunch;
  readonly claude: string;
  readonly chatgpt: string;
}

export type McpClient = "chatgpt" | "codex" | "claude-code" | "vscode";
export type McpConnectOutcome = "configured" | "existing" | "sent";

export type McpDetectedClient = import("./mcp/relocation.js").DetectedClient;

/** AI clients still configured with the launch command HQ used before. */
export interface McpRelocation {
  readonly previous: string;
  readonly current: string;
  readonly clients: readonly McpDetectedClient[];
}

export interface McpConnectOptions {
  /** Remove an existing entry first instead of reporting it as existing. */
  readonly replace?: boolean;
}

export interface McpConnectionService {
  configuration(): McpConfiguration;
  connect(
    client: McpClient,
    options?: McpConnectOptions,
  ): Promise<McpConnectOutcome>;
  verify(): Promise<{ readonly toolCount: number }>;
  /** Desktop only. */
  relocation?(): Promise<McpRelocation | undefined>;
  dismissRelocation?(): Promise<void>;
  readonly outsideApplications?: boolean;
}

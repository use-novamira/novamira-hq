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

export interface McpConnectionService {
  configuration(): McpConfiguration;
  verify(): Promise<{ readonly toolCount: number }>;
}

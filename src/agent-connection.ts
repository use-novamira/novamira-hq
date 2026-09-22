// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Temporary product gate: agent connections currently use MCP only. */
export function isAgentCliSetupEnabled(): boolean {
  return false;
}

/** Structural desktop service boundary consumed by the dashboard. */
export interface AgentSetupView {
  readonly firstRun: boolean;
  readonly running: boolean;
  readonly command: {
    readonly state: string;
    readonly launcher: string;
    readonly message?: string | undefined;
    readonly pathInstruction?: string;
    readonly onPath?: boolean;
    readonly shadowed?: boolean;
  };
  readonly agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly skills: readonly {
      readonly name: string;
      readonly path: string;
      readonly state: "missing" | "installed" | "outdated" | "conflict";
    }[];
  }[];
  readonly results: readonly {
    readonly agent: string;
    readonly skill: string;
    readonly ok: boolean;
    readonly message: string;
  }[];
}

export interface AgentSetupService {
  view(): Promise<AgentSetupView>;
  start(agent: string, action: "install" | "repair" | "remove"): void;
  wait(): Promise<void>;
  cancel(): void;
  dismiss(): Promise<void>;
  command(action: "enable" | "repair" | "remove"): Promise<void>;
}

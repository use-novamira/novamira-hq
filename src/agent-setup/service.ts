// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSetupService, AgentSetupView } from "../agent-connection.js";
import { platformPaths } from "../config/paths.js";
import { atomicWriteFile } from "../config/atomic-write.js";
import { defaultFileSecurity } from "../config/file-security.js";
import { CliError } from "../errors.js";
import { createOwnedSkills, ENTRY_SKILLS } from "./owned-skills.js";
import {
  REGISTRAR_AGENTS,
  type RegistrarAgent,
  type RegistrarOptions,
} from "./registrar.js";
import type { createCommandRegistration } from "./command-registration.js";

export function createAgentSetup(
  options: RegistrarOptions & {
    registration: Pick<
      ReturnType<typeof createCommandRegistration>,
      "status" | "enable" | "repair" | "remove"
    >;
    skills?: ReturnType<typeof createOwnedSkills>;
  },
): AgentSetupService {
  const skills = options.skills ?? createOwnedSkills(options);
  const marker = join(platformPaths(options.env).stateDir, "agent-setup.json");
  let running = false;
  let controller = new AbortController();
  let task = Promise.resolve();
  let results: AgentSetupView["results"][number][] = [];
  return {
    async view() {
      let firstRun = true;
      try {
        firstRun = (await readFile(marker, "utf8")) !== "1\n";
      } catch {
        /* First launch or unreadable marker: offer setup. */
      }
      return {
        firstRun,
        running,
        command: await options.registration.status(),
        results: [...results],
        agents: await Promise.all(
          REGISTRAR_AGENTS.map(async (id) => ({
            id,
            name: id === "claude-code" ? "Claude Code" : "Windsurf",
            skills: await Promise.all(
              ENTRY_SKILLS.map((skill) => skills.status(id, skill)),
            ),
          })),
        ),
      };
    },
    start(agent, action) {
      if (!REGISTRAR_AGENTS.includes(agent as RegistrarAgent))
        throw new CliError("usage_error", "Select a supported agent.");
      if (running)
        throw new CliError(
          "usage_error",
          "Agent setup is already running. Wait or cancel it first.",
        );
      running = true;
      controller = new AbortController();
      results = [];
      const cancelled = () => controller.signal.aborted;
      task = (async () => {
        try {
          for (const skill of ENTRY_SKILLS) {
            if (cancelled()) {
              results.push({
                agent,
                skill,
                ok: false,
                message:
                  "Cancelled. Completed entry points are retained; retry to finish.",
              });
              continue;
            }
            try {
              const message = await skills.apply(
                agent as RegistrarAgent,
                skill,
                action,
                controller.signal,
              );
              results.push({ agent, skill, ok: true, message });
            } catch (error) {
              results.push({
                agent,
                skill,
                ok: false,
                message: cancelled()
                  ? "Cancelled; retry to finish."
                  : error instanceof Error
                    ? error.message.slice(0, 300)
                    : "Setup failed; check directory permissions and retry.",
              });
            }
          }
        } finally {
          running = false;
        }
      })();
    },
    wait: () => task,
    cancel() {
      controller.abort();
    },
    async dismiss() {
      await atomicWriteFile(marker, "1\n", defaultFileSecurity());
    },
    async command(action) {
      try {
        await options.registration[action]();
      } catch (error) {
        throw new CliError(
          "config_error",
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Command access could not be changed. Check its status and retry from the installed desktop app.",
        );
      }
    },
  };
}

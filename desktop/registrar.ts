// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import process from "node:process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Isolated role only: upstream owns process.argv and exits the process. */
export async function registrar(args: string[]): Promise<void> {
  const [operation, agent, source, skill = "novamira-hq"] = args;
  if (operation === "target") {
    if (
      !agent || !["claude-code", "windsurf"].includes(agent) ||
      !source || !["novamira-hq", "novamira-site"].includes(source) ||
      args.length !== 3
    ) {
      throw new Error("Invalid target request");
    }
    // Reviewed skills@1.5.18 registry entries (not its merged list output).
    // Compiled acceptance compares these exact targets with upstream copies.
    const base = agent === "claude-code"
      ? join(
        process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
        "skills",
      )
      : join(homedir(), ".codeium/windsurf/skills");
    console.log(JSON.stringify(resolve(base, source)));
    return;
  }
  if (
    !agent || !/^[a-z][a-z0-9-]+$/.test(agent) ||
    (operation !== "list" && operation !== "install") ||
    (operation === "list"
      ? args.length !== 2
      : (args.length !== 3 && args.length !== 4) || !source) ||
    !["novamira-hq", "novamira-site"].includes(skill)
  ) {
    throw new Error("Invalid embedded skill registrar request");
  }
  // Local sources need neither network nor subprocesses. Revoke both even
  // though the main desktop executable needs these permissions in other roles.
  await Deno.permissions.revoke({ name: "net" });
  await Deno.permissions.revoke({ name: "run" });
  process.env.DISABLE_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";
  process.env.CI = "1";
  process.env.DENO_NO_PROMPT = "1";
  process.argv = [
    Deno.execPath(),
    "skills",
    ...(operation === "list"
      ? ["list", "--global", "--json", "--agent", agent]
      : [
        "add",
        source!,
        "--skill",
        skill,
        "--global",
        "--agent",
        agent,
        "--copy",
        "--yes",
      ]),
  ];
  await import("skills/cli");
}

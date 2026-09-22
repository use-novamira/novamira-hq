// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import process from "node:process";

/** Isolated role only: upstream owns process.argv and exits the process. */
export async function registrar(args: string[]): Promise<void> {
  const [operation, agent, source] = args;
  if (
    !agent || !/^[a-z][a-z0-9-]+$/.test(agent) ||
    (operation !== "list" && operation !== "install") ||
    (operation === "list" ? args.length !== 2 : args.length !== 3 || !source)
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
        "novamira-hq",
        "--global",
        "--agent",
        agent,
        "--copy",
        "--yes",
      ]),
  ];
  await import("skills/cli");
}

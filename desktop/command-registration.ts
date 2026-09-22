// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { basename, dirname, join } from "node:path";

interface Registration {
  launcher: string;
  status(): Promise<{ state: string }>;
  enable(): Promise<unknown>;
  repair(): Promise<unknown>;
  remove(): Promise<unknown>;
  refresh(): Promise<unknown>;
  resolve(): Promise<string>;
}

export const isCommandLauncher = ["novamira-hq", "novamira-hq.exe"].includes(
  basename(Deno.execPath()),
);

export async function commandRegistration(): Promise<Registration> {
  if (["deno", "deno.exe"].includes(basename(Deno.execPath()))) {
    throw new Error(
      "Command registration requires the compiled desktop application.",
    );
  }
  const specifier = new URL(
    "../dist/agent-setup/command-registration.js",
    import.meta.url,
  ).href;
  const { createCommandRegistration } = await import(specifier);
  return createCommandRegistration({
    executable: Deno.execPath(),
    ...(Deno.build.os === "darwin" && !isCommandLauncher &&
        Deno.execPath().includes(".app/Contents/MacOS/")
      ? {
        launcherSource: join(
          dirname(dirname(Deno.execPath())),
          "Helpers",
          "novamira-hq",
        ),
      }
      : {}),
    ...(isCommandLauncher
      ? { stateDir: dirname(dirname(Deno.execPath())) }
      : {}),
  });
}

/** All user arguments and streams go directly to the signed app, not a shell. */
export async function launchCommand(): Promise<number> {
  try {
    const registration = await commandRegistration();
    const executable = await registration.resolve();
    const args = Deno.args[0] === "--mcp" ? Deno.args : ["--cli", ...Deno.args];
    const child = new Deno.Command(executable, {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const listeners: [Deno.Signal, () => void][] = [];
    if (Deno.build.os !== "windows") {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const listener = () => {
          try {
            child.kill(signal);
          } catch { /* exited */ }
        };
        Deno.addSignalListener(signal, listener);
        listeners.push([signal, listener]);
      }
    }
    try {
      return (await child.status).code;
    } finally {
      for (const [signal, listener] of listeners) {
        Deno.removeSignalListener(signal, listener);
      }
    }
  } catch (error) {
    console.error(
      `novamira-hq: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

export async function mcpLaunch(fallback: { command: string; args: string[] }) {
  if (["deno", "deno.exe"].includes(basename(Deno.execPath()))) return fallback;
  const registration = await commandRegistration();
  return (await registration.status()).state === "enabled"
    ? { command: registration.launcher, args: ["--mcp"] }
    : fallback;
}

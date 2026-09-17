// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppAcknowledgement } from "../config/app-acknowledgement.js";
import { CliError } from "../errors.js";
import type { ProbeSiteCli } from "../integration/probe.js";
import { nodeSpawnChild, type SpawnChild } from "../integration/spawn.js";
import { createSpawnResolver, nodeIsFile } from "../update/install.js";

export interface ComponentSetupOptions {
  readonly acknowledgement: AppAcknowledgement;
  readonly probe: ProbeSiteCli;
  readonly install: () => Promise<void>;
}

/** Read-only startup check; installation is possible only after the setup click. */
export function withComponentSetup(
  options: ComponentSetupOptions,
): AppAcknowledgement {
  let ready = false;
  let pending: Promise<void> | undefined;
  return {
    async accepted() {
      if (!(await options.acknowledgement.accepted())) return false;
      if (!ready) ready = (await options.probe()).status === "available";
      return ready;
    },
    async accept() {
      if (pending) return pending;
      pending = (async () => {
        const before = await options.probe();
        if (before.status === "absent") {
          await options.install();
        } else if (before.status !== "available") {
          throw new CliError(
            "integration_unavailable",
            "An existing site connection component is incompatible or could not be started. Nothing was replaced. Repair or update your Novamira installation, then retry setup.",
          );
        }
        if ((await options.probe()).status !== "available")
          throw new CliError(
            "integration_unavailable",
            "The site connection component is not ready yet. Restart Novamira HQ and retry setup. Setup has not been marked complete.",
          );
        await options.acknowledgement.accept();
        ready = true;
      })();
      try {
        await pending;
      } finally {
        pending = undefined;
      }
    },
  };
}

/** Independent npm package, never an HQ dependency; no elevation or shell. */
export function componentInstaller(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  spawn: SpawnChild = nodeSpawnChild,
): () => Promise<void> {
  return async () => {
    const command = {
      command: platform === "win32" ? "npm.cmd" : "npm",
      args: [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@novamira/cli",
      ],
    };
    try {
      // Desktop executables are not Node. On Windows npm's JS entry point must
      // run with the installed Node command, never process.execPath of HQ.
      const spec = await createSpawnResolver({
        environment,
        platform,
        isFile: nodeIsFile,
        execPath: "node",
      })(command);
      const outcome = await spawn({
        command: spec.command,
        args: [...spec.prefixArgs, ...command.args],
        env: { ...environment, npm_config_ignore_scripts: "true" },
        timeoutMs: 300_000,
        signal: AbortSignal.timeout(300_000),
        maxStdoutBytes: 1_048_576,
        maxStderrBytes: 1_048_576,
      });
      if (outcome.kind !== "exited" || outcome.code !== 0)
        throw new Error("Installation failed");
    } catch {
      throw new CliError(
        "integration_unavailable",
        "The required component could not be installed. Check your internet connection and that Node.js 22 or newer with npm is installed, then retry setup. No administrator access was requested. Setup has not been marked complete.",
      );
    }
  };
}

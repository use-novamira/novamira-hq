// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import { SITE_CLI_INSTALL_HINT } from "../connection-state.js";
import { siteCliEnvironment } from "./environment.js";
import type { ResolveSiteCli } from "./resolve.js";
import { nodeSpawnChild, type SpawnChild } from "./spawn.js";

/** Raw argv and streams belong to the child; no HQ option parsing or notices. */
export async function forwardSiteCli(
  argv: readonly string[],
  resolve: ResolveSiteCli,
  environment: NodeJS.ProcessEnv,
  spawn: SpawnChild = nodeSpawnChild,
): Promise<number> {
  const target = await resolve();
  if (target === undefined)
    throw new CliError("usage_error", SITE_CLI_INSTALL_HINT);
  const controller = new AbortController();
  let interrupted = 130;
  const interrupt = () => {
    interrupted = 130;
    controller.abort();
  };
  const terminate = () => {
    interrupted = 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const outcome = await spawn({
      command: target.command,
      args: [...target.prefixArgs, ...argv],
      env: siteCliEnvironment(environment),
      signal: controller.signal,
      timeoutMs: 30 * 60_000,
      maxStdoutBytes: 0,
      maxStderrBytes: 0,
      inheritStdio: true,
    });
    if (outcome.kind === "exited") return outcome.code ?? 1;
    if (outcome.kind === "aborted") return interrupted;
    if (outcome.kind === "timed_out") return 124;
    throw new CliError("usage_error", SITE_CLI_INSTALL_HINT);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

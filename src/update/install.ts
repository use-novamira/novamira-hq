// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installing a newer HQ: choose the package manager, run it, report what ran.
 *
 * **What the Go did.** `internal/update/update.go` replaced its own executable.
 * `DetectInstallMethod` (update.go:171-197) guessed the packaging from the
 * executable's path — a Homebrew Cellar segment, a `go install` bin directory,
 * an npm `node_modules` — and `Install` refused to proceed unless the guess came
 * out `standalone` (update.go:102-104), printing `UpdateCommand` (`brew upgrade
 * …`, `go install …`) otherwise. When it did proceed it downloaded a release
 * archive, verified `checksums.txt`, unpacked a binary, wrote it beside the
 * running one, and renamed it over itself (update.go:396-520).
 *
 * **What HQ does instead, and why it is four lines.** HQ is an npm package.
 * There is exactly one install method and it has a name: `npm install --global`.
 * So there is no detection to do, no archive to verify, no executable to
 * replace, and no refusal to explain — the whole of Go's machinery collapses
 * into building an argv array and spawning it. The one thing worth carrying
 * forward from the Go is its *user-facing honesty*: whatever happens, the
 * operator is shown the exact command that ran, in `data.command` and in the
 * dashboard's update card, so an install that fails can be repeated by hand.
 *
 * **Two package managers, distinguished by the running module's path.** A
 * global Bun install puts the package under `<home>/.bun/install/global/`, and
 * `npm install --global` into a Bun-managed prefix is not what that operator
 * asked for. Everything else gets npm — with `npm.cmd` on Windows, because
 * `spawn` without a shell cannot execute a `.cmd` shim, and **`--ignore-scripts`
 * always**, matching the documented install line and the repository's own
 * supply-chain posture.
 *
 * **The registry that answered the version is the registry that is installed
 * from.** Passing `--registry` through means a `NOVAMIRA_HQ_REGISTRY` mirror
 * cannot advertise one version and then have the package manager fetch a
 * different artifact from the default registry.
 *
 * **The child is spawned with `shell: false` and an argv array**, like every
 * other child HQ starts. The version reaching the specifier has already been
 * proved a SemVer by `src/semver.ts`'s `isSemver`, so `@novamira/hq@<version>`
 * cannot carry a shell metacharacter even if a shell were somehow introduced.
 * Its stdout and stderr are handed to the caller's sink and never to HQ's
 * stdout: the CLI writes them to **stderr only**, and the dashboard discards
 * them, because installer output is not a machine-readable envelope and is not
 * markup either.
 */

import { spawn } from "node:child_process";
import { sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CliError } from "../errors.js";
import { DEFAULT_REGISTRY, PACKAGE_NAME } from "./registry.js";

export interface InstallCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The spawn seam. A contract test injects a runner that records its argv and
 * never starts a process, which is how the update tests stay offline.
 */
export interface InstallRunner {
  run(
    command: InstallCommand,
    onOutput: (chunk: string) => void,
  ): Promise<number>;
}

/** Default kill timeout for the installer child: five minutes. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

/**
 * Choose the package manager that owns this installation.
 *
 * `modulePath` defaults to this module's own resolved path, which is the only
 * reliable statement about where HQ is installed; a test passes a literal.
 */
export function installCommandFor(
  version: string,
  modulePath: string = fileURLToPath(import.meta.url),
  registry: string = DEFAULT_REGISTRY,
  platform: string = process.platform,
): InstallCommand {
  const specifier = `${PACKAGE_NAME}@${version}`;
  const bunGlobal = `${sep}.bun${sep}install${sep}global${sep}`;
  if (modulePath.includes(bunGlobal)) {
    return {
      command: "bun",
      args: ["add", "--global", "--registry", registry, specifier],
    };
  }
  return {
    // Windows resolves npm through a shim, and spawn without a shell needs it.
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: [
      "install",
      "--global",
      "--ignore-scripts",
      "--registry",
      registry,
      specifier,
    ],
  };
}

/** The printable form of a command, for `data.command` and the update card. */
export function printableCommand(command: InstallCommand): string {
  return [command.command, ...command.args].join(" ");
}

export class SpawnInstallRunner implements InstallRunner {
  constructor(private readonly timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS) {}

  async run(
    command: InstallCommand,
    onOutput: (chunk: string) => void,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command.command, [...command.args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk: Buffer) => {
          onOutput(chunk.toString("utf8"));
        });
      }
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error.code === "ENOENT"
            ? new CliError(
                "usage_error",
                `${command.command} is required to update Novamira HQ but was not found in PATH.`,
              )
            : new CliError(
                "internal_error",
                `${command.command} could not be started.`,
                { cause: error },
              ),
        );
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new CliError(
              "network_error",
              `${command.command} did not finish within ${String(this.timeoutMs)} ms.`,
              { retryable: true },
            ),
          );
        } else {
          resolve(code ?? 1);
        }
      });
    });
  }
}

export interface SelfUpdateResult {
  readonly updated: boolean;
  readonly from: string;
  readonly to: string;
  /** The exact command that ran, so a failed install can be repeated by hand. */
  readonly command: string;
}

/** Install the requested published version with the detected package manager. */
export async function installVersion(
  currentVersion: string,
  targetVersion: string,
  runner: InstallRunner,
  onOutput: (chunk: string) => void,
  modulePath?: string,
  registry: string = DEFAULT_REGISTRY,
): Promise<SelfUpdateResult> {
  const command = installCommandFor(
    targetVersion,
    modulePath ?? fileURLToPath(import.meta.url),
    registry,
  );
  const printable = printableCommand(command);
  const code = await runner.run(command, onOutput);
  if (code !== 0) {
    throw new CliError(
      "internal_error",
      `${printable} exited with status ${String(code)}.`,
    );
  }
  return {
    updated: true,
    from: currentVersion,
    to: targetVersion,
    command: printable,
  };
}

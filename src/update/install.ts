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
 * asked for. Everything else gets npm — spelled `npm.cmd` on Windows, because
 * that is the name the operator can repeat by hand — and **`--ignore-scripts`
 * always**, matching the documented install line and the repository's own
 * supply-chain posture.
 *
 * **Windows cannot spawn a `.cmd` shim without a shell**, and HQ never uses a
 * shell. Node 22 refuses to spawn `npm.cmd` directly (the CVE-2024-27980
 * hardening), so the runner does not hand `npm.cmd` to `spawn` at all. It
 * resolves the shim's underlying entry script — `node_modules/npm/bin/npm-cli.js`
 * beside the `npm.cmd` found on `PATH` — and spawns `process.execPath` with that
 * script as the first argument, exactly as `src/integration/resolve.ts` does for
 * the site CLI's shim. The printable command stays `npm.cmd install --global …`
 * so the operator can still repeat a failed install by hand; only the *spawn
 * argv* changes, and it stays an argv array with `shell: false` on every
 * platform.
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
import { stat } from "node:fs/promises";
import { posix as posixPath, sep, win32 as win32Path } from "node:path";
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

/**
 * The executable to spawn, and any arguments that must precede the
 * package-manager argv. For `npm`/`bun` this is the bare name with no prefix;
 * for the Windows `npm.cmd` shim it is `process.execPath` with the shim's
 * underlying `npm-cli.js` entry script as the one prefix argument.
 */
export interface SpawnSpec {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** The seam that turns a printable command into a spawnable argv. */
export type ResolveSpawnSpec = (command: InstallCommand) => Promise<SpawnSpec>;

/** The production `isFile`: a regular file, and `false` for anything else. */
export async function nodeIsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a global npm install puts the package-manager entry script relative to
 * the `npm.cmd` shim. The first form is npm's per-prefix layout, the second is
 * the `bin`-beside-`lib` layout used by nvm-windows and by npm's default
 * Windows prefix.
 */
const NPM_ENTRY_CANDIDATES: readonly (readonly string[])[] = [
  ["node_modules", "npm", "bin", "npm-cli.js"],
  ["..", "lib", "node_modules", "npm", "bin", "npm-cli.js"],
];

export interface SpawnResolverOptions {
  /** The injected process environment; only `PATH`/`Path`/`path` is read. */
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Defaults to `;` on Windows and `:` elsewhere. */
  readonly pathSeparator?: string;
  /** Injected so no test walks a real filesystem entry it did not create. */
  readonly isFile: (candidate: string) => Promise<boolean>;
  /** Defaults to `process.execPath`; only used on the Windows shim path. */
  readonly execPath?: string;
}

/**
 * Build the spawn resolver. On Windows, `npm.cmd` is a `.cmd` shim that Node 22
 * refuses to spawn without a shell, so the resolver walks `PATH` for the shim,
 * resolves its underlying `npm-cli.js` entry script, and returns
 * `process.execPath` with that script as the one prefix argument. Every other
 * command — `npm` on POSIX, `bun` — spawns directly with no prefix, so argument
 * safety on non-Windows platforms is unchanged.
 */
export function createSpawnResolver(
  options: SpawnResolverOptions,
): ResolveSpawnSpec {
  const windows = options.platform === "win32";
  const segments = windows ? win32Path : posixPath;
  const join = (...parts: readonly string[]): string => segments.join(...parts);
  const dirname = (value: string): string => segments.dirname(value);
  const separator = options.pathSeparator ?? (windows ? ";" : ":");
  const execPath = options.execPath ?? process.execPath;

  const pathVariable = (): string =>
    options.environment.PATH ??
    options.environment.Path ??
    options.environment.path ??
    "";

  const cleanEntry = (entry: string): string => {
    const trimmed = entry.trim();
    return trimmed.startsWith('"') &&
      trimmed.endsWith('"') &&
      trimmed.length > 1
      ? trimmed.slice(1, -1)
      : trimmed;
  };

  const resolveShimEntry = async (
    shim: string,
  ): Promise<string | undefined> => {
    const shimDirectory = dirname(shim);
    for (const parts of NPM_ENTRY_CANDIDATES) {
      const entry = join(shimDirectory, ...parts);
      if (await options.isFile(entry)) return entry;
    }
    return undefined;
  };

  const findOnPath = async (
    resolve: (shim: string) => Promise<string | undefined>,
  ): Promise<string | undefined> => {
    for (const rawEntry of pathVariable().split(separator)) {
      const directory = cleanEntry(rawEntry);
      if (directory === "") continue;
      const shim = join(directory, "npm.cmd");
      if (!(await options.isFile(shim))) continue;
      const entry = await resolve(shim);
      if (entry !== undefined) return entry;
      // A shim whose entry script is absent is not spawnable; keep searching so
      // a later PATH entry with an intact layout can still win.
    }
    return undefined;
  };

  return async (command) => {
    if (!windows || command.command !== "npm.cmd") {
      return { command: command.command, prefixArgs: [] };
    }
    const entry = await findOnPath(resolveShimEntry);
    if (entry === undefined) {
      throw new CliError(
        "usage_error",
        `npm.cmd was not found with a resolvable entry script in PATH, so Novamira HQ cannot be updated on Windows.`,
      );
    }
    return { command: execPath, prefixArgs: [entry] };
  };
}

export class SpawnInstallRunner implements InstallRunner {
  constructor(
    private readonly timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    private readonly resolveSpec: ResolveSpawnSpec = createSpawnResolver({
      environment: process.env,
      platform: process.platform,
      isFile: nodeIsFile,
    }),
  ) {}

  async run(
    command: InstallCommand,
    onOutput: (chunk: string) => void,
  ): Promise<number> {
    const spec = await this.resolveSpec(command);
    return new Promise<number>((resolve, reject) => {
      const child = spawn(spec.command, [...spec.prefixArgs, ...command.args], {
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

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  access,
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, delimiter, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { commandRegistrationPaths, platformPaths } from "../config/paths.js";
import { ProfileLockManager } from "../config/lock.js";
import {
  defaultFileSecurity,
  secureDirectory,
} from "../config/file-security.js";

const exec = promisify(execFile);
interface RecordData {
  version: 1;
  executable: string;
  digest: string;
}
export interface CommandRegistrationStatus {
  readonly state: "enabled" | "disabled" | "missing-app" | "conflict";
  readonly launcher: string;
  readonly directory: string;
  readonly onPath?: boolean;
  readonly pathCommand?: string | undefined;
  readonly shadowed?: boolean;
  readonly executable?: string | undefined;
  readonly message?: string | undefined;
  readonly pathInstruction?: string;
}
export interface CommandRegistrationOptions {
  executable: string;
  /** Separately signed standalone launcher shipped inside the macOS bundle. */
  launcherSource?: string;
  stateDir?: string;
  platform?: NodeJS.Platform;
  home?: string;
  path?: string;
  /** Test discovery override; candidates are still identity-checked. */
  discover?: () => Promise<readonly string[]>;
}

/** Native launcher copy: no shell quoting, runtime dependency or PATH lookup. */
export function createCommandRegistration(options: CommandRegistrationOptions) {
  const platform = options.platform ?? process.platform;
  const paths = commandRegistrationPaths({
    stateDir: options.stateDir ?? platformPaths().stateDir,
  });
  const locked = <T>(operation: () => Promise<T>) =>
    new ProfileLockManager(
      dirname(paths.directory),
      defaultFileSecurity(),
    ).withLock("command-registration", operation);
  const launcher = join(
    paths.directory,
    platform === "win32" ? "novamira-hq.exe" : "novamira-hq",
  );
  const digest = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  async function exists(file: string) {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function record(): Promise<RecordData | undefined> {
    if (!(await exists(paths.record))) return undefined;
    if (!(await lstat(paths.record)).isFile())
      throw new Error(
        "Command registration record is not an owned regular file.",
      );
    const value: unknown = JSON.parse(await readFile(paths.record, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("executable" in value) ||
      typeof value.executable !== "string" ||
      !("digest" in value) ||
      typeof value.digest !== "string"
    )
      throw new Error(
        "Invalid command registration. Preserve the record and contact support.",
      );
    if (!isAbsolute(value.executable) || !/^[a-f0-9]{64}$/.test(value.digest))
      throw new Error("Invalid command registration paths or digest.");
    return value as RecordData;
  }
  async function owned(value: RecordData | undefined) {
    if (!(await exists(launcher))) return;
    if (
      !value ||
      !(await lstat(launcher)).isFile() ||
      (await digest(launcher)) !== value.digest
    )
      throw new Error(
        `Command conflict at ${launcher}; existing file was preserved.`,
      );
  }
  async function valid(executable: string) {
    if (
      !isAbsolute(executable) ||
      executable === launcher ||
      !(await exists(executable)) ||
      !(await lstat(executable)).isFile()
    )
      return false;
    try {
      await access(executable, constants.X_OK);
    } catch {
      return false;
    }
    if (platform !== "darwin") return true;
    if (
      basename(executable) !== "novamira-hq-desktop" ||
      executable.startsWith("/Volumes/") ||
      executable.includes("/AppTranslocation/") ||
      executable.includes("/.Trash/")
    )
      return false;
    try {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        [
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          join(dirname(dirname(executable)), "Info.plist"),
        ],
        { timeout: 5000, maxBuffer: 65536 },
      );
      return stdout.trim() === "ai.novamira.hq.desktop";
    } catch {
      return false;
    }
  }
  async function resolve(): Promise<string> {
    const value = await record();
    if (!value)
      throw new Error(
        "Terminal command is not registered. Open Novamira HQ and enable command access.",
      );
    if (await valid(value.executable)) return value.executable;
    if (platform === "darwin") {
      const suffix = "Contents/MacOS/novamira-hq-desktop";
      const candidates = options.discover
        ? []
        : [
            join(
              options.home ?? homedir(),
              "Applications/Novamira HQ.app",
              suffix,
            ),
            join("/Applications/Novamira HQ.app", suffix),
          ];
      try {
        const found = options.discover
          ? await options.discover()
          : (
              await exec(
                "/usr/bin/mdfind",
                ["kMDItemCFBundleIdentifier == 'ai.novamira.hq.desktop'"],
                { timeout: 5000, maxBuffer: 65536 },
              )
            ).stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((app) => join(app, suffix));
        candidates.push(...found);
      } catch {
        /* Standard directories remain usable without Spotlight. */
      }
      const matches: string[] = [];
      for (const candidate of new Set(candidates)) {
        if (await valid(candidate)) {
          const canonical = await realpath(candidate);
          if (!matches.includes(canonical)) matches.push(canonical);
        }
      }
      if (matches.length === 1 && matches[0] !== undefined) return matches[0];
      if (matches.length > 1)
        throw new Error(
          "Multiple Novamira HQ applications found. Open the intended copy and repair command access.",
        );
    }
    throw new Error(
      "Registered Novamira HQ application is missing. Open the moved application to refresh command access, or reinstall and repair it.",
    );
  }
  async function status(): Promise<CommandRegistrationStatus> {
    try {
      const value = await record();
      await owned(value);
      const installed = value !== undefined && (await exists(launcher));
      let executable: string | undefined;
      let message: string | undefined;
      if (installed) {
        try {
          executable = await resolve();
        } catch (error) {
          message = (error as Error).message;
        }
      }
      const onPath = (options.path ?? process.env.PATH ?? "")
        .split(delimiter)
        .includes(paths.directory);
      let pathCommand: string | undefined;
      for (const directory of (options.path ?? process.env.PATH ?? "").split(
        delimiter,
      )) {
        if (!directory) continue;
        for (const name of platform === "win32"
          ? [
              "novamira-hq.com",
              "novamira-hq.exe",
              "novamira-hq.bat",
              "novamira-hq.cmd",
            ]
          : ["novamira-hq"]) {
          const candidate = join(directory, name);
          if (await exists(candidate)) {
            pathCommand = candidate;
            break;
          }
        }
        if (pathCommand) break;
      }
      return {
        state: installed
          ? executable
            ? "enabled"
            : "missing-app"
          : "disabled",
        launcher,
        directory: paths.directory,
        onPath,
        pathCommand,
        shadowed: pathCommand !== undefined && pathCommand !== launcher,
        executable,
        message,
        pathInstruction: `Add ${paths.directory} to your user PATH, then restart terminals and agents. Use the absolute launcher path until then.`,
      };
    } catch (error) {
      return {
        state: "conflict",
        launcher,
        directory: paths.directory,
        message: (error as Error).message,
      };
    }
  }
  async function save(value: RecordData) {
    const temporary = `${paths.record}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, paths.record);
    } finally {
      await unlink(temporary).catch(() => {
        /* Already renamed or removed. */
      });
    }
  }
  async function enable() {
    const source = options.launcherSource ?? options.executable;
    const value = await record();
    await owned(value);
    if (!(await valid(options.executable)))
      throw new Error(
        "Command access requires an installed desktop executable (a Novamira HQ app bundle on macOS).",
      );
    await secureDirectory(paths.directory, defaultFileSecurity());
    if (!(await exists(launcher))) {
      await copyFile(source, launcher, constants.COPYFILE_EXCL);
      await chmod(launcher, 0o700);
    } else if (value && (await digest(source)) !== value.digest) {
      const temporary = `${launcher}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
        await chmod(temporary, 0o700);
        await rename(temporary, launcher);
      } catch (error) {
        throw new Error(
          "Could not refresh the native launcher. Close running HQ commands and MCP agents, then repair command access.",
          { cause: error },
        );
      } finally {
        await unlink(temporary).catch(() => {
          /* Already renamed or removed. */
        });
      }
    }
    await save({
      version: 1,
      executable: options.executable,
      digest: await digest(launcher),
    });
    return status();
  }
  return {
    launcher,
    status,
    enable: () => locked(enable),
    repair: () => locked(enable),
    resolve,
    async refresh() {
      if (await record()) return locked(enable);
      return status();
    },
    remove: () =>
      locked(async () => {
        const value = await record();
        await owned(value);
        if (value) {
          if (await exists(launcher)) await unlink(launcher);
          await unlink(paths.record);
        }
        return status();
      }),
  };
}

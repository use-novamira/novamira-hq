// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { platformPaths } from "../config/paths.js";
import {
  atomicWriteFile,
  atomicWritePrivateFile,
} from "../config/atomic-write.js";
import { defaultFileSecurity } from "../config/file-security.js";
import { ProfileLockManager } from "../config/lock.js";
import {
  createSkillRegistrar,
  type RegistrarOptions,
  type RegistrarAgent,
  type EntrySkill,
} from "./registrar.js";

export const ENTRY_SKILLS = ["novamira-hq", "novamira-site"] as const;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

/** Refuse symlink/junction parents, including manual skill links. */
async function safeParents(path: string) {
  let current = resolve(path);
  while (current !== parse(current).root) {
    const value = await stat(current);
    // macOS's system temporary directories use these fixed OS-owned aliases.
    if (
      process.platform === "darwin" &&
      (current === "/var" || current === "/tmp") &&
      value?.isSymbolicLink() &&
      (await realpath(current)) === `/private${current}`
    ) {
      current = dirname(current);
      continue;
    }
    if (value && !value.isDirectory())
      throw new Error(
        "Conflict: linked or non-directory skill path; existing files were preserved.",
      );
    current = dirname(current);
  }
}

export function createOwnedSkills(options: RegistrarOptions) {
  const env = options.env ?? process.env;
  const paths = platformPaths(env);
  const security = defaultFileSecurity();
  const registrar = createSkillRegistrar(options);
  const asset = (skill: EntrySkill) =>
    readFile(
      new URL(`../../skills/${skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
  async function inspect(
    agent: RegistrarAgent,
    skill: EntrySkill,
    signal: AbortSignal,
  ) {
    const target = await registrar.target(agent, skill, signal);
    const recordPath = join(
      paths.stateDir,
      "agent-skills",
      `${digest(target)}.json`,
    );
    let ownedDigest: string | undefined;
    if (await stat(recordPath)) {
      if (!(await lstat(recordPath)).isFile())
        throw new Error(
          "Invalid skill ownership record; preserve it and contact support.",
        );
      const record: unknown = JSON.parse(await readFile(recordPath, "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        !("version" in record) ||
        record.version !== 1 ||
        !("path" in record) ||
        record.path !== target ||
        !("digest" in record) ||
        typeof record.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.digest)
      )
        throw new Error(
          "Invalid skill ownership record; preserve it and contact support.",
        );
      ownedDigest = record.digest;
    }
    const expected = await asset(skill);
    let state: "missing" | "installed" | "outdated" | "conflict" = "missing";
    try {
      await safeParents(target);
      if (await stat(target)) {
        const entries = await readdir(target);
        const file = join(target, "SKILL.md");
        if (entries.length === 0 && ownedDigest) state = "missing";
        else if (
          entries.length !== 1 ||
          entries[0] !== "SKILL.md" ||
          !(await stat(file))?.isFile() ||
          !ownedDigest ||
          digest(await readFile(file, "utf8")) !== ownedDigest
        )
          state = "conflict";
        else
          state = ownedDigest === digest(expected) ? "installed" : "outdated";
      }
    } catch {
      state = "conflict";
    }
    return {
      name: skill,
      path: target,
      state,
      expected,
      recordPath,
      ownedDigest,
    };
  }
  return {
    async status(agent: RegistrarAgent, skill: EntrySkill) {
      const entry = await inspect(agent, skill, new AbortController().signal);
      return { name: entry.name, path: entry.path, state: entry.state };
    },
    async apply(
      agent: RegistrarAgent,
      skill: EntrySkill,
      action: "install" | "repair" | "remove",
      signal: AbortSignal,
    ) {
      // A fresh manager coordinates separate windows/processes as well as calls.
      return new ProfileLockManager(paths.stateDir, security).withLock(
        "agent-skills",
        async () => {
          signal.throwIfAborted();
          const entry = await inspect(agent, skill, signal);
          if (entry.state === "conflict")
            throw new Error(
              "Conflict: existing or edited skill was preserved. Move it aside yourself, then retry.",
            );
          if (action === "remove") {
            if (!entry.ownedDigest)
              return "No HQ-owned installation to remove.";
            if (entry.state !== "missing")
              await unlink(join(entry.path, "SKILL.md"));
            if (await stat(entry.path)) await rmdir(entry.path);
            await unlink(entry.recordPath);
            return "Removed HQ-owned entry point.";
          }
          if (entry.state === "installed")
            return "Already installed and current.";
          if (entry.state === "outdated" && action !== "repair")
            throw new Error(
              "Entry point changed in this release. Use Repair to update the HQ-owned copy.",
            );
          await mkdir(paths.cacheDir, { recursive: true, mode: 0o700 });
          const stage = await mkdtemp(join(paths.cacheDir, "agent-setup-"));
          await security.secureDirectory(stage);
          try {
            // Upstream's --yes overwrites directories. Run it only in a private
            // disposable agent home, then publish its verified copy ourselves.
            const isolated = {
              ...env,
              HOME: stage,
              USERPROFILE: stage,
              CLAUDE_CONFIG_DIR: join(stage, ".claude"),
              XDG_CONFIG_HOME: join(stage, "config"),
              XDG_STATE_HOME: join(stage, "state"),
              XDG_CACHE_HOME: join(stage, "cache"),
              APPDATA: join(stage, "roaming"),
              LOCALAPPDATA: join(stage, "local"),
              NOVAMIRA_HQ_HOME: join(stage, "hq"),
            };
            const local = createSkillRegistrar({ ...options, env: isolated });
            const result = await local.installSkill(agent, skill, signal);
            if (!result.ok) throw new Error(result.message);
            // Exact-target verification also guards the pinned registry metadata.
            if (result.path !== (await local.target(agent, skill, signal)))
              throw new Error("Registrar target verification failed.");
            signal.throwIfAborted();
            const current = await inspect(agent, skill, signal);
            if (current.state !== entry.state)
              throw new Error(
                "Skill changed during setup; retry after reviewing it.",
              );
            await safeParents(entry.path);
            await mkdir(dirname(entry.path), { recursive: true });
            if (!(await stat(entry.path))) await mkdir(entry.path);
            // Record the exact small entry-point digest; runtime guidance is never copied.
            if (entry.state === "outdated") {
              await atomicWritePrivateFile(
                join(entry.path, "SKILL.md"),
                entry.expected,
                security,
              );
            } else {
              await copyFile(
                join(result.path, "SKILL.md"),
                join(entry.path, "SKILL.md"),
                constants.COPYFILE_EXCL,
              );
            }
            await atomicWriteFile(
              entry.recordPath,
              JSON.stringify({
                version: 1,
                path: entry.path,
                digest: digest(entry.expected),
              }),
              security,
            );
            return "Installed. Restart the agent to discover both entry points.";
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        },
      );
    },
  };
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { platformPaths } from "../config/paths.js";
import { defaultFileSecurity } from "../config/file-security.js";
import { nodeSpawnChild, type SpawnChild } from "../integration/spawn.js";

/** Reviewed user-scope capabilities of skills@1.5.18; directory rules stay upstream. */
export const REGISTRAR_AGENTS = ["claude-code", "windsurf"] as const;
export type RegistrarAgent = (typeof REGISTRAR_AGENTS)[number];

const AGENT_NAMES: Record<RegistrarAgent, string> = {
  "claude-code": "Claude Code",
  windsurf: "Windsurf",
};

export interface RegistrarOptions {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnChild;
}

export type RegistrationResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

interface InstalledSkill {
  name: string;
  path: string;
  agents: string[];
}

class RegistrarFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Desktop setup primitive. Call once per explicitly selected agent. */
export function createSkillRegistrar(options: RegistrarOptions) {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? nodeSpawnChild;
  const invoke = (args: readonly string[], signal: AbortSignal) =>
    spawn({
      command: options.command,
      args: [...(options.prefixArgs ?? []), "--skill-registrar", ...args],
      env: {
        ...env,
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        DENO_NO_PROMPT: "1",
      },
      signal,
      timeoutMs: 30_000,
      maxStdoutBytes: 262_144,
      maxStderrBytes: 32_768,
    });
  const failure = (reason: string): RegistrationResult => ({
    ok: false,
    reason,
    message: `Skill registration ${reason}. Check the selected agent's user-scope skill directory permissions and retry from Settings. HQ remains available.`,
  });
  const cancelled = (signal: AbortSignal): boolean => signal.aborted;
  async function list(
    agent: RegistrarAgent,
    signal: AbortSignal,
  ): Promise<InstalledSkill[]> {
    const result = await invoke(["list", agent], signal);
    if (result.kind !== "exited" || result.code !== 0)
      throw new RegistrarFailure(
        result.kind === "exited" ? "failed" : result.kind,
      );
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item: unknown) => {
        if (typeof item !== "object" || item === null) return false;
        const value = item as Partial<InstalledSkill>;
        return (
          typeof value.name === "string" &&
          typeof value.path === "string" &&
          isAbsolute(value.path) &&
          Array.isArray(value.agents) &&
          value.agents.every((name: unknown) => typeof name === "string")
        );
      })
    )
      throw new Error("invalid_result");
    // 1.5.18 also scans other agents despite --agent; filter its display labels.
    return (parsed as InstalledSkill[]).filter((skill) =>
      skill.agents.includes(AGENT_NAMES[agent]),
    );
  }
  async function installHosting(
    agent: RegistrarAgent,
    signal: AbortSignal,
  ): Promise<RegistrationResult> {
    if (!REGISTRAR_AGENTS.includes(agent)) return failure("unsupported_agent");
    if (cancelled(signal)) return failure("aborted");
    let stage: string | undefined;
    try {
      if (
        (await list(agent, signal)).some(
          (skill) => skill.name === "novamira-hq",
        )
      )
        return failure("conflict");
      const asset = await readFile(
        new URL("../../skills/novamira-hq/SKILL.md", import.meta.url),
        "utf8",
      );
      const { cacheDir } = platformPaths(env);
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      stage = await mkdtemp(join(cacheDir, "skill-registration-"));
      await defaultFileSecurity().secureDirectory(stage);
      await writeFile(join(stage, "SKILL.md"), asset, { mode: 0o600 });
      const result = await invoke(["install", agent, stage], signal);
      if (result.kind !== "exited" || result.code !== 0)
        return failure(result.kind === "exited" ? "failed" : result.kind);
      // Upstream can report per-target copy failures with exit code zero.
      const installed = (await list(agent, signal)).find(
        (skill) => skill.name === "novamira-hq" && skill.agents.length > 0,
      );
      if (
        /Failed to install|Installation failed/.test(
          result.stdout + result.stderr,
        )
      )
        return failure("failed");
      if (!installed || installed.path.startsWith(stage))
        return failure("verification_failed");
      const target = join(installed.path, "SKILL.md");
      if (
        !(await lstat(installed.path)).isDirectory() ||
        !(await lstat(target)).isFile() ||
        (await readFile(target, "utf8")) !== asset
      )
        return failure("verification_failed");
      return { ok: true, path: installed.path };
    } catch (error) {
      return failure(
        cancelled(signal)
          ? "aborted"
          : error instanceof RegistrarFailure
            ? error.reason
            : "failed",
      );
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
    }
  }
  return {
    agents: REGISTRAR_AGENTS,
    /** Fresh hosting entry installation only; ownership-aware repair is a setup-service concern. */
    async installHosting(
      agent: RegistrarAgent,
      signal: AbortSignal,
    ): Promise<RegistrationResult> {
      try {
        return await installHosting(agent, signal);
      } catch {
        return failure("staging_cleanup_failed");
      }
    },
  };
}

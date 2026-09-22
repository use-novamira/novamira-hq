// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bundled agent skills: two instruction bundles, one installable stub, and
 * a reader for the packaged `skills/` directory.
 *
 * **What the Go did.** `internal/skills/skills.go` (225 lines) `//go:embed`ed
 * three `SKILL.md` files plus a Codex agent stub, exposed `List`/`Get`/`GetAll`/
 * `Path`, and — the bulk of it — *wrote files into the operator's home*:
 * `InstallCodexStub` hand-wrote `~/.agents/skills/novamira/SKILL.md` and
 * `ensureClaudeSymlink` symlinked `~/.claude/skills/novamira` at it, with a
 * "wrong target — remove and recreate" branch that silently deleted whatever
 * symlink was already there. `Path` returned the fictional string
 * `"embedded:skills/core/SKILL.md"`, which no tool could open.
 *
 * **What HQ does instead, and why.**
 *
 * 1. *No writer in this module.* Desktop delegates registration to the pinned
 *    embedded registrar through `src/agent-setup/`, with explicit selection.
 *    There is **no `skills install` and no `setup` command**, and
 *    nothing in `src/skills/` opens a file for writing. Go's
 *    `InstallCodexStub`, `ensureClaudeSymlink`, `CodexStubPath`, `InstallScope`
 *    and `InstallResult` are deleted, and `internal/setup/setup.go` — a
 *    42-line wrapper around the writer — went with them.
 * 2. *No `site` bundle.* Go's third bundle described Application Passwords,
 *    `novamira site exec` and the REST shim: all of it on the far side of the
 *    boundary rule. Site guidance ships with `@novamira/cli`. `GetAll`, which
 *    concatenated the three, is deleted too — the two survivors do not compose
 *    into one document.
 * 3. *A real path.* {@link SkillStore.path} returns an absolute filesystem path
 *    to a file that exists in the installed package, so `skills path hosting`
 *    is something an agent can actually `cat`.
 * 4. *A read, not an embed.* Node has no `//go:embed`. The bundles live at the
 *    repository root in `skills/`, are shipped by `package.json`'s `files`, and
 *    are resolved relative to this module's own URL — the same trick
 *    `@novamira/cli`'s `GuideStore` uses. `tsc` does not copy them and does not
 *    need to; do **not** add them to `scripts/copy-static.mjs`, which exists
 *    only because `src/web/static/` lives *inside* `src/`.
 *
 * **Three directories, not two.** `skills/novamira-hq/` is the installable
 * hosting identity registered by desktop setup — while `core`
 * and `hosting` are the two bundles reachable through `novamira-hq skills get`.
 * A globally installed skill directory called `core` would be a land-grab on
 * every agent that supports skills.
 *
 * **This module is a leaf.** It imports `node:fs/promises`, `node:path`,
 * `node:url` and `../errors.js`, and nothing else. `src/doctor/` imports it;
 * it imports no part of HQ back.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "../errors.js";

/** The two bundles `novamira-hq skills get` serves. There is no `site`. */
export const SKILL_NAMES = ["core", "hosting"] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

/** What `skills get` and `skills path` resolve to when given no name. */
export const DEFAULT_SKILL: SkillName = "core";

/**
 * The hosting directory desktop agent setup installs, and the
 * global identity the operator sees in their agent. It is deliberately *not*
 * `novamira`: that name belongs to `@novamira/cli`, and an operator with both
 * tools installed must end up with two distinct skills.
 */
export const AGENT_SKILL_DIRECTORY = "novamira-hq";

export interface SkillSummary {
  readonly name: SkillName;
  readonly description: string;
}

export interface SkillDocument {
  readonly name: SkillName;
  /** An absolute path to a file that exists; never Go's `embedded:…` fiction. */
  readonly path: string;
  readonly content: string;
}

/**
 * What {@link SkillStore.readable} answers, and the evidence of the doctor's
 * `skills.bundled` check.
 */
export interface SkillReadability {
  readonly core: boolean;
  readonly hosting: boolean;
  /** `skills/novamira-hq/SKILL.md`, the stub desktop agent setup installs. */
  readonly agentStub: boolean;
  /** The labels above that came back false, in a stable order. */
  readonly missing: readonly string[];
}

/**
 * Go's `List()` (skills.go:57-72), minus the `site` entry and with the second
 * reworded: HQ is not "the Novamira CLI", it is the hosting-side tool.
 */
const DESCRIPTIONS: Readonly<Record<SkillName, string>> = {
  core: "Router for version-matched Novamira HQ instructions.",
  hosting: "Provider-neutral WordPress hosting operations through Novamira HQ.",
};

/**
 * The cross-reference each shipped file must still contain.
 *
 * This is Go's `BundledSkillsReadable` (skills.go:220-224) plus the surviving
 * half of `CodexStubContainsLoader` (skills.go:210-216) — which in Go checked an
 * *installed copy* in the operator's home, and here checks the **shipped** stub,
 * because HQ installs nothing. A bundle that no longer routes to the next one is
 * a broken package, and the doctor says so.
 */
const CROSS_REFERENCES: Readonly<Record<string, string>> = {
  core: "novamira-hq skills get hosting",
  hosting:
    "novamira-hq --json --profile <hosting-profile> hosting providers validate",
  agentStub: "novamira-hq skills get core",
};

function isSkillName(value: string): value is SkillName {
  return (SKILL_NAMES as readonly string[]).includes(value);
}

/**
 * Reader for the packaged `skills/` tree.
 *
 * The root is a constructor parameter purely so a contract test can point it at
 * a temporary directory with a file removed; production constructs it with no
 * arguments and gets the installed package's own directory.
 */
export class SkillStore {
  private readonly root: string;

  constructor(
    root: string = fileURLToPath(new URL("../../skills/", import.meta.url)),
  ) {
    this.root = root;
  }

  /** Static metadata; no I/O, because a listing must not fail on a bad install. */
  list(): readonly SkillSummary[] {
    return SKILL_NAMES.map((name) => ({
      name,
      description: DESCRIPTIONS[name],
    }));
  }

  /**
   * Narrow an operator-supplied name to a bundle.
   *
   * An empty name means {@link DEFAULT_SKILL}, matching Go's `Path("")`. An
   * unknown name is a `usage_error`, where Go returned a bare `fmt.Errorf` that
   * would have exited 1 — a user typo is exit 2 in HQ's taxonomy.
   */
  resolveName(name: string): SkillName {
    const trimmed = name.trim();
    if (trimmed === "") return DEFAULT_SKILL;
    if (isSkillName(trimmed)) return trimmed;
    throw new CliError(
      "usage_error",
      `There is no bundled skill named ${trimmed}. Novamira HQ ships ${SKILL_NAMES.join(" and ")}; site guidance ships with @novamira/cli.`,
      { details: { skill: trimmed, known: SKILL_NAMES } },
    );
  }

  /** The absolute path of a bundle's `SKILL.md`. */
  path(name: string): string {
    return join(this.root, this.resolveName(name), "SKILL.md");
  }

  /** Read one bundle. `""` means {@link DEFAULT_SKILL}. */
  async get(name: string): Promise<SkillDocument> {
    const resolved = this.resolveName(name);
    const path = this.path(resolved);
    return { name: resolved, path, content: await this.read(resolved, path) };
  }

  /**
   * The doctor's `skills.bundled` evidence: does every shipped file read, is it
   * non-empty, and does it still carry its cross-reference?
   *
   * It never throws. A missing file is exactly the condition being reported, so
   * turning it into an exception would make the check report "the check could
   * not be completed" instead of the truth.
   */
  async readable(): Promise<SkillReadability> {
    const [core, hosting, agentStub] = await Promise.all([
      this.intact(this.path("core"), CROSS_REFERENCES.core),
      this.intact(this.path("hosting"), CROSS_REFERENCES.hosting),
      this.intact(
        join(this.root, AGENT_SKILL_DIRECTORY, "SKILL.md"),
        CROSS_REFERENCES.agentStub,
      ),
    ]);
    const missing: string[] = [];
    if (!core) missing.push("core");
    if (!hosting) missing.push("hosting");
    if (!agentStub) missing.push(AGENT_SKILL_DIRECTORY);
    return { core, hosting, agentStub, missing: Object.freeze(missing) };
  }

  /**
   * A read failure is `internal_error`, not a user error: the name was valid, so
   * the package itself is broken. The underlying message is deliberately not
   * propagated — it can carry an absolute path from someone else's machine —
   * and only the resolved path goes into `details`.
   */
  private async read(name: SkillName, path: string): Promise<string> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw new CliError(
        "internal_error",
        `The bundled skill ${name} could not be read from the installed package.`,
        { details: { skill: name, path }, cause: error },
      );
    }
    if (content === "") {
      throw new CliError(
        "internal_error",
        `The bundled skill ${name} could not be read from the installed package.`,
        { details: { skill: name, path } },
      );
    }
    return content;
  }

  private async intact(
    path: string,
    crossReference: string | undefined,
  ): Promise<boolean> {
    try {
      const content = await readFile(path, "utf8");
      return (
        content !== "" &&
        crossReference !== undefined &&
        content.includes(crossReference)
      );
    } catch {
      return false;
    }
  }
}

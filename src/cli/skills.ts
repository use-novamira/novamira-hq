// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `novamira-hq skills list | get [name] | path [name]`.
 *
 * **What the Go did.** `newSkillsCommand` (`internal/cli/support.go:128-232`)
 * registered four subcommands and four flags. HQ ships three subcommands and
 * **no flags at all**:
 *
 * - `--full` was hidden and did nothing — Go's own comment says "the flag is
 *   reserved for future truncation" (skills.go:76) and `Get` ignored it.
 * - `--all` concatenated three bundles with newlines. One of the three no
 *   longer exists, and the two survivors are a router and a reference manual:
 *   pasting them together produces a document that contradicts itself about
 *   which tool to run next.
 * - `install` — and the separate top-level `setup` command
 *   (`support.go:239-267`) — wrote an agent stub into the operator's home and
 *   symlinked `~/.claude/skills/novamira` at it. This command remains read-only.
 *   Desktop registration lives separately in `src/agent-setup/` and uses the
 *   isolated, pinned registrar with explicit agent selection.
 *
 * **Declaring no options is itself the safety property.** A global option name
 * is reserved across the whole tree — commander lets an ancestor consume a
 * matching option anywhere in argv — so a subcommand that declares none cannot
 * shadow `--profile`, `--json`, `--timeout`, `--yes`, `--no-color`, `--quiet`,
 * `--verbose`, `--version` or `--help`.
 * `test/cli-program-phase4-contract.test.mjs` checks that tree-wide; this file
 * simply gives it nothing to find.
 *
 * **`skills get` human mode prints the markdown raw**, with no framing and no
 * summary line — Go's `fmt.Print(content)`, and the shape an agent expects when
 * it pipes the output straight into its context. It is the one place in HQ where
 * a `human` value is a whole document rather than a report, which is why it is
 * stated here rather than left to be noticed.
 *
 * **This group is local.** It reads two files out of the installed package. It
 * never resolves a hosting profile, never builds a provider client, and never
 * touches the network, so every handler goes through `runLocalCommand`.
 */

import type { Command } from "commander";

import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

export interface SkillsHandlers {
  skillsList(options: GlobalOptions): Promise<void>;
  /** `name` is `undefined` when none was given; the store defaults it to `core`. */
  skillsGet(name: string | undefined, options: GlobalOptions): Promise<void>;
  skillsPath(name: string | undefined, options: GlobalOptions): Promise<void>;
}

export function createSkillsHandlers(
  dependencies: CommandDependencies,
): SkillsHandlers {
  const { skills } = dependencies;

  return {
    skillsList: (options) =>
      runLocalCommand(dependencies, options, () => {
        const summaries = skills.list();
        return {
          data: { skills: summaries },
          // Go's `fmt.Printf("%s - %s\n", …)` per row (support.go:139).
          human: summaries
            .map((skill) => `${skill.name} - ${skill.description}`)
            .join("\n"),
        };
      }),

    skillsGet: (name, options) =>
      runLocalCommand(dependencies, options, async () => {
        const document = await skills.get(name ?? "");
        return { data: document, human: document.content };
      }),

    skillsPath: (name, options) =>
      runLocalCommand(dependencies, options, () => {
        // `resolveName` first, so an unknown name is a `usage_error` rather than
        // a path to a file that does not exist.
        const resolved = skills.resolveName(name ?? "");
        const path = skills.path(resolved);
        return { data: { name: resolved, path }, human: path };
      }),
  };
}

/**
 * Attach the `skills` group to the root program.
 *
 * Registered beside `config` rather than under `hosting`: the bundles describe
 * how to drive HQ, which is not an operation on a hosting profile.
 */
export function registerSkillsCommands(
  parent: Command,
  handlers: SkillsHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const skills = parent
    .command("skills")
    .description("read the bundled agent skill instructions");

  skills
    .command("list")
    .description("list the bundled skills")
    .action(async (...values: unknown[]) =>
      handlers.skillsList(optionsFor(values)),
    );

  skills
    .command("get")
    .description("print a bundled skill's markdown (default: core)")
    .argument("[name]", "core or hosting")
    .action(async (name: string | undefined, ...values: unknown[]) =>
      handlers.skillsGet(name, optionsFor(values)),
    );

  skills
    .command("path")
    .description("print a bundled skill's file path (default: core)")
    .argument("[name]", "core or hosting")
    .action(async (name: string | undefined, ...values: unknown[]) =>
      handlers.skillsPath(name, optionsFor(values)),
    );
}

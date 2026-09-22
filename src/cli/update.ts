// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Command } from "commander";
import { updateNotice } from "../update/index.js";
import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

export interface UpdateCommandOptions {
  readonly check?: boolean;
}
export interface UpdateHandlers {
  update(options: UpdateCommandOptions, globals: GlobalOptions): Promise<void>;
}

export function createUpdateHandlers(
  dependencies: CommandDependencies,
): UpdateHandlers {
  return {
    update: (_options, globals) =>
      runLocalCommand(dependencies, globals, async ({ renderer }) => {
        const status = await dependencies
          .createUpdateChecker(globals.timeout)
          .check();
        renderer.note(
          status.updateAvailable
            ? updateNotice(status)
            : `Novamira HQ ${status.current} is up to date.`,
        );
        return { data: { ...status, updated: false, distribution: "desktop" } };
      }),
  };
}

export function registerUpdateCommands(
  parent: Command,
  handlers: UpdateHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  parent
    .command("update")
    .description("check desktop releases and report download links")
    .option("--check", "report desktop releases (same as update)", false)
    .action(async (options: UpdateCommandOptions, command: Command) =>
      handlers.update(options, optionsFor([command])),
    );
}

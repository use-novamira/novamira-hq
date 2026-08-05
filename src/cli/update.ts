// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `novamira-hq update [--check]`.
 *
 * **What the Go had.** Four spellings of one idea: `update`, `update check`,
 * `update install`, and a top-level `upgrade` alias (`internal/cli/support.go:30-95`).
 * `update` with no subcommand printed the check; `update install` refused
 * outright unless `DetectInstallMethod` guessed `standalone`, and otherwise
 * printed the `brew upgrade` / `go install` line the operator should run
 * instead.
 *
 * **What HQ ships.** One command, one option, matching `@novamira/cli`'s frozen
 * grammar exactly so an operator learns it once and it means the same thing in
 * both tools. The `upgrade` alias is deleted: an alias is a second name for the
 * same thing, and the contract has to describe both.
 *
 * **Why there is no refusal branch.** Go refused because it was about to replace
 * its own executable and could only do that safely for one packaging. HQ never
 * replaces an executable — it runs `npm install --global` (or the Bun global
 * equivalent) and lets the package manager do what package managers do. So
 * there is nothing to detect and nothing to refuse; the command that ran is
 * reported in `data.command` either way, which is Go's honest fallback made
 * unconditional.
 *
 * **The check here is a forced registry read, not the cached refresh.** The
 * background notice in `src/main.ts` uses `UpdateChecker.refresh()`, which is
 * bounded to one request per 24 hours. An operator who typed `update` asked, so
 * this path calls `check()` and pays for the request every time.
 *
 * **`--check` is command-local and free against the reserved globals**
 * (`--profile --json --timeout --yes --no-color --quiet --verbose --version
 * --help`). An explicitly given `--timeout` bounds the **installer child** as
 * well as the registry request — that is what `GlobalOptions.timeoutExplicit`
 * is for, and it is why the default is not simply passed through: 30 seconds is
 * a sensible registry deadline and a hopeless `npm install` deadline.
 *
 * **The installer's output never reaches stdout.** It goes to
 * `Renderer.childOutput`, which is stderr-only and suppressed by `--quiet`, so
 * `--json` still emits exactly one envelope on stdout no matter how chatty npm
 * is. Nothing from the child is parsed, stored, or rendered as markup.
 */

import type { Command } from "commander";

import { installVersion, type InstallRunner } from "../update/index.js";
import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

export interface UpdateCommandOptions {
  /** `--check`: report what is published and install nothing. */
  readonly check?: boolean;
}

export interface UpdateHandlers {
  update(options: UpdateCommandOptions, globals: GlobalOptions): Promise<void>;
}

export function createUpdateHandlers(
  dependencies: CommandDependencies,
): UpdateHandlers {
  return {
    update: (options, globals) =>
      runLocalCommand(dependencies, globals, async ({ renderer }) => {
        const checker = dependencies.createUpdateChecker(globals.timeout);
        const status = await checker.check();

        if (options.check === true || !status.updateAvailable) {
          renderer.note(
            status.updateAvailable
              ? `A new novamira-hq release is available: ${status.current} -> ${status.latest}. Run "novamira-hq update" to install it.`
              : `novamira-hq ${status.current} is the latest release.`,
          );
          return {
            data: {
              current: status.current,
              latest: status.latest,
              updateAvailable: status.updateAvailable,
              // `--check` reports; a bare `update` that found nothing to do
              // reports that it did nothing, so the two are distinguishable in
              // JSON without reading the flags back.
              ...(options.check === true ? {} : { updated: false }),
            },
          };
        }

        renderer.childOutput(
          `Updating novamira-hq ${status.current} -> ${status.latest}...\n`,
        );
        const runner: InstallRunner = dependencies.createInstallRunner(
          globals.timeoutExplicit ? globals.timeout : undefined,
        );
        const result = await installVersion(
          status.current,
          status.latest,
          runner,
          (chunk) => {
            renderer.childOutput(chunk);
          },
          undefined,
          checker.registryIdentity,
        );
        return { data: result };
      }),
  };
}

/** Attach `update` to the root program, beside `dashboard` and `doctor`. */
export function registerUpdateCommands(
  parent: Command,
  handlers: UpdateHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  parent
    .command("update")
    .description("check for and install a newer Novamira HQ release")
    .option(
      "--check",
      "report the published version and install nothing",
      false,
    )
    .action(async (options: UpdateCommandOptions, command: Command) =>
      handlers.update(options, optionsFor([command])),
    );
}

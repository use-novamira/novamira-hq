// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { CliError } from "../errors.js";

/** Executable name; also the name every usage message tells the user to run. */
export const PROGRAM_NAME = "novamira-hq";

/**
 * Default per-operation timeout. Matches novamira-cli and the HTTP client's
 * per-attempt budget, so `--timeout` means the same thing in both tools.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/**
 * The global options every command receives. HQ deliberately carries only the
 * subset of novamira-cli's globals that mean the same thing here (plan §5.7):
 * there is no `--site` and no `--max-output`.
 */
export interface GlobalOptions {
  /** `--json`: emit exactly one JSON envelope on stdout. */
  readonly json: boolean;
  /** `--quiet`: suppress nonessential diagnostics. */
  readonly quiet: boolean;
  /** `--verbose`: emit redacted diagnostics on stderr. */
  readonly verbose: boolean;
  /** False for `--no-color`. `NO_COLOR` is applied by the composition root. */
  readonly color: boolean;
  /** `--yes`: approve destructive operations without confirmation. */
  readonly yes: boolean;
  /** `--timeout <ms>`: operation timeout in milliseconds. */
  readonly timeout: number;
  /** True when `--timeout` was given, so long operations can inherit it. */
  readonly timeoutExplicit: boolean;
}

/**
 * Every command the program can run, as a typed interface. `program.ts` knows
 * the option grammar; `commands.ts` knows how to satisfy it. Phase 4 adds the
 * hosting handlers here and nothing else in this file changes shape.
 */
export interface CommandHandlers {
  version(version: string, options: GlobalOptions): void | Promise<void>;
  configPath(options: GlobalOptions): void | Promise<void>;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

export function createProgram(
  version: string,
  handlers: CommandHandlers,
): Command {
  const program = new Command();
  program
    .name(PROGRAM_NAME)
    .description("Hosting provisioning CLI and local dashboard for Novamira")
    .showSuggestionAfterError()
    .exitOverride()
    .option("--json", "emit exactly one JSON value on stdout", false)
    .option(
      "--timeout <ms>",
      "operation timeout in milliseconds",
      positiveInteger,
      DEFAULT_OPERATION_TIMEOUT_MS,
    )
    .option("--yes", "approve destructive operations", false)
    .option("--no-color", "disable ANSI color")
    .option("--quiet", "suppress nonessential diagnostics", false)
    .option("--verbose", "emit redacted diagnostics", false)
    .option("--version", "print the HQ version", false);

  /**
   * Commander appends the active `Command` to the action arguments, so the
   * innermost subcommand's options win while the program's globals still
   * apply. Called with `[]` for the root action.
   */
  const optionsFor = (values: readonly unknown[]): GlobalOptions => {
    const active =
      values.findLast((value): value is Command => value instanceof Command) ??
      program;
    return {
      ...active.optsWithGlobals<GlobalOptions>(),
      timeoutExplicit:
        active.getOptionValueSourceWithGlobals("timeout") !== "default",
    };
  };

  const config = program
    .command("config")
    .description("inspect HQ configuration");
  config
    .command("path")
    .description("print the resolved HQ configuration and state paths")
    .action(async (...values: unknown[]) =>
      handlers.configPath(optionsFor(values)),
    );

  // ---------------------------------------------------------------------------
  // PHASE 4 REGISTRATION POINT
  //
  // The hosting command tree (`hosting sites`, `hosting env`, `hosting deploy`,
  // ~110 subcommands ported from internal/cli) attaches here, e.g.
  //
  //   registerHostingCommands(program, handlers, optionsFor);
  //
  // from a new `src/cli/hosting.ts`. Add the corresponding method signatures to
  // `CommandHandlers` above and implement them in `commands.ts`; `main.ts` needs
  // no change. Keep using `optionsFor(values)` so subcommand options inherit the
  // globals, and remember the boundary rule: no WordPress site tokens, no
  // Application Passwords, no Ability proxying.
  // ---------------------------------------------------------------------------

  program.action(async () => {
    if (program.opts<{ readonly version: boolean }>().version) {
      await handlers.version(version, optionsFor([]));
      return;
    }
    throw new CliError(
      "usage_error",
      `A command is required. Run ${PROGRAM_NAME} --help.`,
    );
  });

  return program;
}

export function isHelpExit(error: unknown): boolean {
  return (
    error instanceof CommanderError && error.code === "commander.helpDisplayed"
  );
}

export function isCommanderUsageError(error: unknown): boolean {
  return error instanceof CommanderError;
}

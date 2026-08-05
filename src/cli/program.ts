// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { CliError } from "../errors.js";
import {
  registerDashboardCommands,
  type DashboardHandlers,
} from "./dashboard.js";
import { registerDoctorCommands, type DoctorHandlers } from "./doctor.js";
import {
  registerHostingCommands,
  type HostingCommandHandlers,
} from "./hosting/index.js";
import { registerSkillsCommands, type SkillsHandlers } from "./skills.js";
import { registerUpdateCommands, type UpdateHandlers } from "./update.js";

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
  /**
   * `--profile <name>`: the hosting profile to operate through. Optional here
   * because the local commands (`--version`, `config path`) need none; the
   * hosting shell in `hosting-command.ts` fails closed when one is required.
   */
  readonly profile?: string;
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
 * the option grammar; `commands.ts` knows how to satisfy it. Phase 4 added the
 * hosting handlers, Phase 6 the dashboard, Phase 7 `skills`, `doctor` and
 * `update`; the shape of this file has not otherwise changed.
 */
export interface CommandHandlers
  extends
    HostingCommandHandlers,
    DashboardHandlers,
    SkillsHandlers,
    DoctorHandlers,
    UpdateHandlers {
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
    .option("--profile <name>", "hosting profile to operate through")
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

  // The hosting command tree: the `hosting` parent and every group under it,
  // plus the hosting-profile subcommands that extend the `config` command
  // created just above. `optionsFor` is handed through so a subcommand's
  // options are merged over the globals by the same reader the local commands
  // use. The boundary rule holds across all of it: no WordPress site tokens, no
  // Application Passwords, no Ability proxying.
  registerHostingCommands(program, handlers, optionsFor);

  // The bundled agent skills: a third top-level group, beside `config` and
  // `hosting`, because the instructions describe how to drive HQ rather than an
  // operation on a hosting profile. It declares no options at all, so nothing
  // in it can shadow a reserved global.
  registerSkillsCommands(program, handlers, optionsFor);

  // `dashboard`, `doctor` and `update` are top-level commands, like Go's. They
  // are registered after the hosting tree only so that `--help` lists them
  // last; nothing depends on the order, and registration never dereferences
  // `handlers` outside its action — `createProgram("test", {})` is a supported
  // call in the contract tests. `update` deliberately has no `upgrade` alias:
  // Go carried one (`support.go:30-95`) and a second name for one command is a
  // second thing the contract has to describe.
  registerDashboardCommands(program, handlers, optionsFor);
  registerDoctorCommands(program, handlers, optionsFor);
  registerUpdateCommands(program, handlers, optionsFor);

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

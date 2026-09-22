// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `novamira-hq doctor [--offline] [--fix]`.
 *
 * **What the Go did.** `newDoctorCommand` (`internal/cli/support.go:270-…`)
 * loaded the config, called `doctor.BuildReport`, and printed
 * `doctor.FormatHuman` — a flat list of `key: value` lines with no severity, so
 * "site profiles: (none)" and "bundled skills readable: no" looked identical.
 *
 * **What HQ does instead.** One aligned line per check —
 * `status  id  summary` — and a trailing `status: <overall>`. The status column
 * is what Go's report had no room for: an operator scanning the output looks at
 * one column, and an agent parsing `--json` gets the report object verbatim
 * under `data`.
 *
 * **The exit-code rule, which is the whole reason this file is short.** A
 * completed report is a **successful invocation**: exit 0 and `ok: true`, even
 * when the overall status is `warn` or `fail`. The handler therefore never
 * inspects `report.status` to decide anything; it renders and returns. Only a
 * failure to *produce* a report — which the engine makes very hard, since a
 * throwing check is isolated into a failed record — takes the normal typed
 * nonzero path. Contract tests freeze this, and the installers depend on
 * it: their smoke test is `novamira-hq doctor --offline`, run on a machine with
 * no profiles and no site CLI, where two checks warn and everything is fine.
 *
 * **`--offline` and `--fix` are command-local and free against the reserved
 * globals** (`--profile --json --timeout --yes --no-color --quiet --verbose
 * --version --help`). `--profile`, when given, narrows `profile.credentials` to
 * that one profile; the check still runs and still cannot fail, so `doctor` is
 * the one command in HQ that accepts `--profile` without requiring it.
 *
 * **What `--fix` may touch, exhaustively:** owner-only permissions on HQ's own
 * private paths, and creating the state directory. It writes no credential,
 * removes no profile, edits no configuration file and calls no provider.
 *
 * **What `--offline` removes, exhaustively:** the ninth check,
 * `update.available`, which is the only one that reaches a network. It is
 * dropped from the definition list rather than run and reported "skipped", so an
 * offline report has eight rows; and `src/main.ts` suppresses the background
 * release notice for this command when the flag is given, so `doctor --offline`
 * makes no request at all — which is precisely what the installers' smoke test
 * needs it to promise.
 *
 * **Verbose mode prints evidence to stderr, never to stdout.** Human mode's
 * table carries summaries only — `evidence` can be long and is structured — so
 * `--verbose` emits one `renderer.diagnostic("doctor", check)` per non-passing
 * check, which goes through the same redaction every diagnostic does.
 */

import type { Command } from "commander";

import {
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "../doctor/index.js";
import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

export interface DoctorCommandOptions {
  /** `--offline`: perform no network operation of any kind. */
  readonly offline?: boolean;
  /** `--fix`: repair private-path permissions and initialize the state directory. */
  readonly fix?: boolean;
}

export interface DoctorHandlers {
  doctor(options: DoctorCommandOptions, globals: GlobalOptions): Promise<void>;
}

/** `pass  runtime.node          Node 22.14.0 on linux/x64.` */
export function formatDoctorReport(report: DoctorReport): string {
  const width = report.checks.reduce(
    (widest, check) => Math.max(widest, check.id.length),
    0,
  );
  const lines = report.checks.map(
    (check) =>
      `${check.status.padEnd(4)}  ${check.id.padEnd(width)}  ${check.summary}`,
  );
  return [...lines, `status: ${report.status}`].join("\n");
}

export function createDoctorHandlers(
  dependencies: CommandDependencies,
): DoctorHandlers {
  return {
    doctor: (options, globals) =>
      runLocalCommand(dependencies, globals, async ({ renderer, io }) => {
        const report = await runDoctor(
          {
            paths: dependencies.paths,
            security: dependencies.security,
            store: dependencies.store,
            credentials: dependencies.credentials,
            skills: dependencies.skills,
            probeSiteCli: dependencies.probeSiteCli,
            // The ninth check's factory. `doctorDefinitions` drops the check
            // entirely under `--offline`, so passing it unconditionally is
            // safe: the option, not the wiring, is what decides.
            createUpdateChecker: dependencies.createUpdateChecker,
            environment: io.env,
          },
          {
            fix: options.fix === true,
            offline: options.offline === true,
            ...(globals.profile === undefined
              ? {}
              : { profile: globals.profile }),
          },
        );
        if (globals.verbose) {
          for (const check of report.checks) {
            if (check.status === "pass") continue;
            renderer.diagnostic("doctor", check satisfies DoctorCheck);
          }
        }
        // No status inspection: a produced report is a success. See the header.
        return { data: report, human: formatDoctorReport(report) };
      }),
  };
}

export function registerDoctorCommands(
  parent: Command,
  handlers: DoctorHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  parent
    .command("doctor")
    .description("check the local installation and report what is wrong")
    .option("--offline", "perform no network operation", false)
    .option("--fix", "repair private-path permissions and state storage", false)
    .action(async (options: DoctorCommandOptions, command: Command) =>
      handlers.doctor(options, optionsFor([command])),
    );
}

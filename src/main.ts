// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { createCommandHandlers } from "./cli/commands.js";
import {
  createProgram,
  DEFAULT_OPERATION_TIMEOUT_MS,
  isCommanderUsageError,
  isHelpExit,
  PROGRAM_NAME,
  type GlobalOptions,
} from "./cli/program.js";
import { defaultFileSecurity } from "./config/file-security.js";
import { ProfileLockManager } from "./config/lock.js";
import { platformPaths, type PathEnvironment } from "./config/paths.js";
import { ConfigStore } from "./config/profiles.js";
import { asCliError, CliError } from "./errors.js";
import {
  createHostingClientFactory,
  type ProviderRegistry,
} from "./hosting/factory.js";
import { PROVIDER_REGISTRY } from "./hosting/providers/index.js";
import {
  createRenderer,
  type OutputStreams,
  type Renderer,
} from "./output/render.js";

/** Kept in step with `package.json`'s `version`; the release job matches them. */
export const VERSION = "0.1.0";

export interface RuntimeEnvironment extends PathEnvironment {
  readonly NO_COLOR?: string;
  /**
   * The rest of the process environment. Credential references and the
   * providers' identity variables are resolved from the very environment the
   * paths were resolved from, so a test that isolates `NOVAMIRA_HQ_HOME` also
   * isolates every credential lookup.
   */
  readonly [name: string]: string | undefined;
}

/**
 * Seams the composition root exposes to tests. Production passes nothing and
 * gets the real, complete provider registry.
 */
export interface MainOverrides {
  /**
   * The provider constructors the hosting client factory may build from.
   * Defaults to `PROVIDER_REGISTRY`; a test injects a fake so that no
   * invocation can reach a live provider API.
   */
  readonly registry?: ProviderRegistry;
}

/**
 * Reconstruct the global options after a failure that happened before (or
 * during) parsing, when no command handler ever ran. Commander's defaults are
 * used where available and the raw argv is scanned for the flags that change
 * how the failure itself is reported.
 */
function fallbackOptions(
  program: Command | undefined,
  argv: readonly string[],
): GlobalOptions {
  const parsed = program?.opts<Partial<GlobalOptions>>() ?? {};
  return {
    json: parsed.json === true || argv.includes("--json"),
    quiet: parsed.quiet === true || argv.includes("--quiet"),
    verbose: parsed.verbose === true || argv.includes("--verbose"),
    color: parsed.color !== false && !argv.includes("--no-color"),
    yes: parsed.yes === true || argv.includes("--yes"),
    timeout: parsed.timeout ?? DEFAULT_OPERATION_TIMEOUT_MS,
    timeoutExplicit: false,
  };
}

/**
 * Point a command and every subcommand at the injected streams. Commander
 * copies the output configuration into a subcommand when the subcommand is
 * created, so configuring only the root would leave `config --help` writing to
 * the real `process.stdout` instead of the streams the caller supplied.
 */
function configureOutput(command: Command, streams: OutputStreams): void {
  command.configureOutput({
    // Help and version text is commander's; failures are the renderer's.
    writeOut: (value) => streams.stdout.write(value),
    writeErr: () => undefined,
  });
  for (const child of command.commands) configureOutput(child, streams);
}

/**
 * Composition root. Builds the one lock manager, the one config store and the
 * one renderer this process uses, runs the parsed command, and funnels every
 * failure through `asCliError` -> `Renderer.failure` -> `exitCodeFor`. It never
 * rejects: the returned number is the process exit code.
 */
export async function main(
  argv: readonly string[],
  streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr },
  environment: RuntimeEnvironment = process.env,
  overrides: MainOverrides = {},
): Promise<number> {
  const requestId = randomUUID();
  let renderer: Renderer | undefined;
  let program: Command | undefined;

  // One renderer per process: the first command to run fixes the output mode,
  // and the failure path below reuses it so `meta.requestId` is stable.
  const rendererFor = (options: GlobalOptions): Renderer => {
    renderer ??= createRenderer(
      {
        json: options.json,
        quiet: options.quiet,
        verbose: options.verbose,
        color: options.color && environment.NO_COLOR === undefined,
        requestId,
      },
      streams,
    );
    return renderer;
  };

  try {
    const paths = platformPaths(environment);
    const security = defaultFileSecurity();
    // Exactly one lock manager per process: it rejects re-entrant acquisition
    // of the same key, and two managers behave like two processes.
    const locks = new ProfileLockManager(paths.stateDir, security);
    const store = new ConfigStore(paths.configFile, locks, security);

    // Exactly one hosting client factory per process, over the complete
    // provider registry. Diagnostics are routed to the renderer that the first
    // command created; before that there is nothing to write to, and an HTTP
    // request cannot have happened yet either.
    const hosting = createHostingClientFactory({
      store,
      registry: overrides.registry ?? PROVIDER_REGISTRY,
      env: environment,
      http: {
        onDiagnostic: (diagnostic) => renderer?.diagnostic("http", diagnostic),
      },
    });

    const handlers = createCommandHandlers({
      version: VERSION,
      paths,
      store,
      hosting,
      rendererFor,
    });

    // PHASE 4: build the credential store and pass its resolver into
    // `createHostingClientFactory` so `stored` credential references resolve
    // through the OS keychain rather than the env-only default resolver.

    program = createProgram(VERSION, handlers);
    configureOutput(program, streams);

    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (isHelpExit(error)) return 0;
    const cliError = isCommanderUsageError(error)
      ? new CliError(
          "usage_error",
          `Invalid command usage. Run ${PROGRAM_NAME} --help.`,
        )
      : asCliError(error);
    const active = renderer ?? rendererFor(fallbackOptions(program, argv));
    return active.failure(cliError);
  }
}

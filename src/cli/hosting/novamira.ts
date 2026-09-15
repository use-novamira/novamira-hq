// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting novamira setup`, ported from `newNovamiraCommand` /
 * `setupNovamiraSiteProfile` in `internal/cli/hosting_novamira.go`.
 *
 * This module is deliberately the thinnest group in the tree. Everything the
 * command actually does lives one layer down in `src/provisioning/`, because
 * Phase 6's dashboard runs the same sequence with no commander, no `Renderer`
 * and no `CommandIo` in the graph; what stays here is the option grammar, the
 * translation of that grammar into a {@link NovamiraSetupRequest}, and the two
 * renderings of the result. `src/provisioning/` never imports `src/cli/`.
 *
 * **Four Go flags are gone, permanently.** Go's setup ended by creating a
 * WordPress Application Password and storing it in a `site_profiles` entry, so
 * it needed `--username`, `--app-name`, `--site-profile` and
 * `--replace-profile`. Under the boundary rule HQ holds no site token, creates
 * no WordPress user and stores no site profile: the run ends at the two
 * `novamira_ai_abilities_*` options and emits the `novamira auth login` handoff
 * instead. Do not reintroduce any of the four.
 *
 * **`--version` became `--plugin-version`.** `--version` is a program-level
 * global, and commander lets an ancestor consume a matching option anywhere in
 * argv, so the name is reserved across the whole tree — the same reason
 * `hosting wp plugins install` and `hosting php set-version` spell theirs
 * `--plugin-version` and `--php-version`.
 *
 * **`--preflight` and `--compat-check` are two different preflights.**
 * `--preflight` is the DB-backed WP-CLI probe that runs *before* the install;
 * `--compat-check` is the unauthenticated read of the site's public discovery
 * document that runs *after* it and decides whether `novamira auth login` would
 * succeed. Naming both "preflight" would be a bug factory, so they stay
 * distinct.
 *
 * Nothing here writes to stdout: the body returns a {@link RenderedResult} and
 * `runHostingCommand` renders it through the one envelope. Progress goes to
 * `renderer.note`, which is stderr in human mode and suppressed under `--json`
 * and `--quiet`, so a progress line can never contaminate the JSON envelope.
 */

import type { Command } from "commander";

import { handoffData, handoffHuman } from "../../provisioning/handoff.js";
import { globalHttpFetch, type HttpFetch } from "../../provisioning/http.js";
import { NOVAMIRA_LATEST_SOURCE_ALIAS } from "../../provisioning/plugin.js";
import {
  provisionNovamira,
  type NovamiraSetupRequest,
} from "../../provisioning/setup.js";
import type { CommandDependencies } from "../commands.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  addPollingOptions,
} from "../flags.js";
import { runHostingCommand, type HostingOptions } from "../hosting-command.js";
import type { RenderedResult } from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Command options                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `hosting novamira setup`, one field per flag. Every boolean carries the
 * default commander applies, so a field is `undefined` only when this interface
 * is satisfied by something other than a parsed command line.
 */
export interface NovamiraSetupCommandOptions {
  readonly env?: string;
  /** `--url`: overrides the discovered `wp option get home`. */
  readonly url?: string;
  /** `--source`: defaults to {@link NOVAMIRA_LATEST_SOURCE_ALIAS}. */
  readonly source?: string;
  /** `--plugin-version`: never `--version`, which is a reserved global. */
  readonly pluginVersion?: string;
  readonly force?: boolean;
  readonly activate?: boolean;
  readonly activateNetwork?: boolean;
  readonly ignoreRequirements?: boolean;
  /** `--preflight`: the DB-backed WP-CLI probe before the install. */
  readonly preflight?: boolean;
  readonly validateSource?: boolean;
  readonly wait?: boolean;
  readonly aiAbilities?: boolean;
  /** `--compat-check`: the site compatibility read after the install. */
  readonly compatCheck?: boolean;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* Handler interface                                                          */
/* -------------------------------------------------------------------------- */

export interface NovamiraHandlers {
  /** `hosting novamira setup`. */
  novamiraSetup(
    options: NovamiraSetupCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
}

/**
 * Seams for {@link createNovamiraHandlers}; production supplies none. `fetch`
 * covers both non-provider outbound requests the command can make — validating
 * the canonical plugin download endpoint and reading the one unauthenticated
 * compatibility document — so a contract test can exercise the whole sequence
 * offline.
 */
export interface NovamiraCommandOverrides {
  /** Defaults to {@link globalHttpFetch}. */
  readonly fetch?: HttpFetch;
  /** Total deadline for the compatibility read. */
  readonly metadataTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Translate the parsed command line into the service request. Defaults are
 * applied here rather than left to the service so that the CLI's grammar and
 * the service's own fallbacks cannot disagree about what `hosting novamira
 * setup` with no flags means.
 *
 * `--env` is passed through unresolved: the service raises the `usage_error`
 * itself, before it issues any provider request, so the dashboard gets the same
 * diagnostic without going through commander.
 */
function setupRequest(
  options: NovamiraSetupCommandOptions,
): NovamiraSetupRequest {
  return {
    envId: options.env ?? "",
    ...(options.url === undefined ? {} : { url: options.url }),
    source: options.source ?? NOVAMIRA_LATEST_SOURCE_ALIAS,
    ...(options.pluginVersion === undefined
      ? {}
      : { pluginVersion: options.pluginVersion }),
    force: options.force ?? false,
    activate: options.activate ?? true,
    activateNetwork: options.activateNetwork ?? false,
    ignoreRequirements: options.ignoreRequirements ?? false,
    preflight: options.preflight ?? true,
    validateSource: options.validateSource ?? true,
    wait: options.wait ?? true,
    ...(options.aiAbilities === undefined
      ? {}
      : { aiAbilities: options.aiAbilities }),
    compatCheck: options.compatCheck ?? true,
    intervalSeconds: options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
  };
}

export function createNovamiraHandlers(
  dependencies: CommandDependencies,
  overrides: NovamiraCommandOverrides = {},
): NovamiraHandlers {
  const http: HttpFetch = overrides.fetch ?? globalHttpFetch;

  return {
    novamiraSetup: (options, globals) =>
      runHostingCommand(
        dependencies,
        globals,
        async ({ client, entry, renderer, io }): Promise<RenderedResult> => {
          // `io.env` is the only thing this handler takes from `CommandIo`; the
          // service sees a plain record and never reads `process.env` itself.
          const result = await provisionNovamira(
            {
              client,
              hostingProfile: entry.name,
              environment: io.env,
              fetch: http,
              ...(overrides.metadataTimeoutMs === undefined
                ? {}
                : { metadataTimeoutMs: overrides.metadataTimeoutMs }),
              report: (_level, message) => {
                renderer.note(message);
              },
            },
            setupRequest(options),
          );
          return {
            data: handoffData(result),
            human: handoffHuman(result),
            warnings: result.warnings,
          };
        },
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Attach `novamira` to `parent` — the `hosting` command in the assembled
 * program.
 *
 * The registration order below is the shipped flag order and is compared
 * exactly by the program contract test. Every true-defaulting boolean is two
 * entries, `--x` then `--no-x`, the idiom `hosting wp plugins install` already
 * uses: commander needs the negation declared for the option to be settable
 * both ways, and declaring them adjacently keeps the help text readable.
 */
export function registerNovamiraCommands(
  parent: Command,
  handlers: NovamiraHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const novamira = parent
    .command("novamira")
    .description("Novamira plugin provisioning");

  const setup = novamira
    .command("setup")
    .description(
      "install and configure the Novamira plugin, then print the site CLI handoff",
    )
    .option("--env <id>", "environment id")
    .option(
      "--url <url>",
      "WordPress site URL override (defaults to wp option get home)",
    )
    .option(
      "--source <source>",
      `Novamira plugin slug, local zip path, or remote zip URL (${NOVAMIRA_LATEST_SOURCE_ALIAS} resolves to the newest Novamira release)`,
      NOVAMIRA_LATEST_SOURCE_ALIAS,
    )
    .option("--plugin-version <version>", "WordPress.org plugin version")
    .option("--force", "overwrite an already installed plugin", false)
    .option("--activate", "activate the plugin after installing", true)
    .option("--no-activate", "do not activate the plugin after installing")
    .option("--activate-network", "network activate after installing", false)
    .option(
      "--ignore-requirements",
      "ignore WordPress or PHP version requirements",
      false,
    )
    .option(
      "--preflight",
      "run a DB-backed WP-CLI preflight before installing",
      true,
    )
    .option("--no-preflight", "skip the WP-CLI preflight")
    .option("--validate-source", "check a remote zip URL first", true)
    .option("--no-validate-source", "do not check a remote zip URL")
    .option("--wait", "wait for the provider operation to complete", true)
    .option(
      "--no-wait",
      "fail instead of waiting when the provider answers asynchronously",
    )
    // "AI Abilities" is one letter clear of the boundary-rule test's
    // /ability/i: these two descriptions are normative, so do not paraphrase
    // them into "Ability".
    .option(
      "--ai-abilities",
      "explicitly enable AI Abilities on an existing installation (new installs enable automatically)",
      false,
    )
    .option(
      "--no-ai-abilities",
      "preserve AI Abilities on an existing installation",
    )
    .option(
      "--compat-check",
      "verify the site satisfies the site CLI compatibility matrix",
      true,
    )
    .option("--no-compat-check", "skip the site compatibility check");

  addPollingOptions(setup).action(
    async (options: NovamiraSetupCommandOptions, command: Command) =>
      handlers.novamiraSetup(options, optionsFor([command])),
  );
}

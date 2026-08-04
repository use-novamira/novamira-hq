// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting wp`, `hosting wp-cli`, `hosting logs` and `hosting analytics`,
 * ported from the `newWpCommand` / `newWpCliCommand` / `newLogsCommand` /
 * `newAnalyticsCommand` trees in `internal/cli/hosting.go` plus the plugin
 * install orchestration in `internal/cli/wp_install.go`.
 *
 * Three things about the shape of this file.
 *
 * 1. Go built `plugins` and `themes` from one `newWpAssetCommand(flags, use,
 *    plugins bool)` helper and branched on the boolean at every dispatch. HQ
 *    keeps the shared builder but carries {@link WpAssetKind} — a two-member
 *    union — instead of a bare bool, so the branches are exhaustive `switch`es
 *    that cannot be passed the wrong way round. The handler interface therefore
 *    has three asset-parameterised methods rather than six near-duplicates.
 * 2. Nothing here writes to stdout. Each command body returns a
 *    {@link RenderedResult} and `runHostingCommand` renders it through the one
 *    envelope, so `--json` is handled in exactly one place.
 * 3. Go validated `--file` and `--metric` inside `RunE` with `validateEnum`;
 *    HQ keeps the validation in the handler (via {@link requireEnum}) rather
 *    than moving it into a commander parser, so a value that reaches a handler
 *    from anywhere is checked and the failure is a `usage_error` envelope
 *    instead of a bare parse message.
 *
 * `wp plugins install` is the only command in the group that does more than one
 * provider round trip. It reproduces Go's sequence exactly: resolve and
 * optionally validate `--source`, run a DB-backed WP-CLI preflight, dispatch the
 * install, wait for the operation, then activate the plugin in a second WP-CLI
 * call when the provider lets HQ observe WP-CLI results. Resolving
 * `--source novamira-latest` and `--validate-source` are the only outbound
 * requests HQ makes to a host that is not a hosting provider; both go through
 * the injectable `fetch` seam on {@link createWpHandlers} so contract tests stay
 * offline.
 *
 * Every step of that sequence that is not CLI grammar now lives one layer down,
 * in `src/provisioning/`: source resolution and validation, the preflight and
 * its DB_HOST hint, activation, and WP-CLI output extraction (`wpCliOutput` and
 * the echo stripper, in `src/provisioning/wp-cli.ts`). `hosting novamira setup`
 * runs the same machinery, and it must be callable from Phase 6's dashboard
 * with no commander in the graph, so the shared parts moved rather than being
 * copied. What stays here is what reads a CLI option: `pollBudget`,
 * `installActivationPlan` (which consults `--from-json` and `--command-id`) and
 * `preparedInstallPayload` (which needs `CommandIo`).
 */

import type { Command } from "commander";

import {
  assertNever,
  wpCliResultsObservable,
  type ActionRequest,
  type ProviderClient,
  type ReadRequest,
} from "../../hosting/client.js";
import type { OperationStatus } from "../../hosting/types.js";
import type { HttpFetch } from "../../provisioning/http.js";
import {
  NOVAMIRA_LATEST_RELEASE_API,
  NOVAMIRA_LATEST_SOURCE_ALIAS,
  activateInstalledPlugin,
  inferPluginSlug,
  installPreflightApplies,
  preflightWpCli,
  resolvePluginSource,
  validateRemotePluginSource,
  type ActivationPlan,
} from "../../provisioning/plugin.js";
import type { PollBudget } from "../../provisioning/wp-cli.js";
import type { CommandDependencies } from "../commands.js";
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  addFromJsonOption,
  addPollingOptions,
  collect,
  parseUnsignedInteger,
  requireEnum,
} from "../flags.js";
import {
  operationFailure,
  runHostingCommand,
  waitForOperationStatus,
  type HostingOptions,
} from "../hosting-command.js";
import { requireOption, type CommandIo, type JsonValue } from "../inputs.js";
import {
  buildQuery,
  wpAssetUpdateAllPayload,
  wpAssetUpdatePayload,
  wpCliPayload,
  wpPluginInstallPayload,
  type WpAssetKind,
  type WpAssetUpdateAllOptions,
  type WpAssetUpdateOptions,
  type WpCliRunOptions,
  type WpPluginInstallOptions,
} from "../payloads.js";
import { renderAction, renderOperation, renderRaw } from "../print.js";
import type { RenderedResult } from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Go's `--file` enum for `hosting logs get`. */
const LOG_FILES = ["error", "access", "kinsta-cache-perf"] as const;

/** Go's `--file` default. */
const DEFAULT_LOG_FILE: (typeof LOG_FILES)[number] = "error";

/** Go's `--lines` default. */
const DEFAULT_LOG_LINES = 1000;

/** Go's `--metric` enum for `hosting analytics usage`. */
const USAGE_METRICS = ["visits", "bandwidth", "cdn-bandwidth"] as const;

/** Go's `--metric` enum for `hosting analytics env`. */
const ENV_METRICS = [
  "cdn-bandwidth",
  "visits",
  "bandwidth",
  "diskspace",
  "top-countries",
  "top-cities",
  "top-client-ips",
  "visits-dispersion",
  "response-codes",
] as const;

/** The metric whose query carries a `time_zone` even when none was given. */
const DISKSPACE_METRIC = "diskspace";

/** Go's default `time_zone` for the `diskspace` metric. */
const DEFAULT_DISKSPACE_TIME_ZONE = "00:00";

/** Go's `--time-span` default. */
const DEFAULT_ANALYTICS_TIME_SPAN = "7_days";

/* -------------------------------------------------------------------------- */
/* Command options                                                            */
/* -------------------------------------------------------------------------- */

/** `hosting wp <plugins|themes> list`. */
interface WpAssetListOptions {
  readonly env?: string;
  /** `--company`: list the company-wide catalogue instead of an environment. */
  readonly company?: boolean;
}

/** `hosting wp <plugins|themes> update`. */
interface WpAssetUpdateCommandOptions extends WpAssetUpdateOptions {
  readonly env?: string;
}

/** `hosting wp <plugins|themes> update-all`. */
interface WpAssetUpdateAllCommandOptions extends WpAssetUpdateAllOptions {
  readonly env?: string;
}

/** `hosting wp plugins install`. */
interface WpPluginInstallCommandOptions extends WpPluginInstallOptions {
  readonly env?: string;
  /** Run a DB-backed WP-CLI preflight before installing. Defaults to true. */
  readonly preflight?: boolean;
  /** HEAD-check a remote `--source` zip before installing. Defaults to true. */
  readonly validateSource?: boolean;
  /** Wait for the provider operation to complete. Defaults to true. */
  readonly wait?: boolean;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

/** `hosting wp-cli run`. */
interface WpCliRunCommandOptions extends WpCliRunOptions {
  readonly env?: string;
}

/** `hosting logs get`. */
interface LogsGetOptions {
  readonly env?: string;
  readonly file?: string;
  readonly lines?: number;
}

/** `hosting analytics usage`. */
interface AnalyticsUsageOptions {
  readonly site?: string;
  readonly metric?: string;
}

/** `hosting analytics env`. */
interface AnalyticsEnvOptions {
  readonly env?: string;
  readonly metric?: string;
  readonly timeSpan?: string;
  readonly company?: string;
  readonly from?: string;
  readonly to?: string;
  /** Present exactly when `--time-zone` was given (Go's `Flags().Changed`). */
  readonly timeZone?: string;
}

/* -------------------------------------------------------------------------- */
/* Handler interface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The WordPress-asset, WP-CLI, logs and analytics handlers. `asset` stands in
 * for Go's `plugins bool`, so `plugins` and `themes` share one implementation
 * exactly as they shared `newWpAssetCommand`.
 */
export interface WpHandlers {
  /** `hosting wp <plugins|themes> list`. */
  wpAssetList(
    asset: WpAssetKind,
    options: WpAssetListOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp <plugins|themes> update`. */
  wpAssetUpdate(
    asset: WpAssetKind,
    options: WpAssetUpdateCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp <plugins|themes> update-all`. */
  wpAssetUpdateAll(
    asset: WpAssetKind,
    options: WpAssetUpdateAllCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp plugins install`. */
  wpPluginInstall(
    options: WpPluginInstallCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting wp-cli run`. */
  wpCliRun(
    options: WpCliRunCommandOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting logs get`. */
  logsGet(options: LogsGetOptions, globals: HostingOptions): Promise<void>;
  /** `hosting analytics usage`. */
  analyticsUsage(
    options: AnalyticsUsageOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting analytics env`. */
  analyticsEnv(
    options: AnalyticsEnvOptions,
    globals: HostingOptions,
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Provider request selection                                                 */
/* -------------------------------------------------------------------------- */

function assetListRequest(
  asset: WpAssetKind,
  options: WpAssetListOptions,
): ReadRequest {
  if (options.company === true) {
    // Go passes `CompanyID: nil`, leaving the profile's company to the client.
    switch (asset) {
      case "plugins":
        return { kind: "company-plugins" };
      case "themes":
        return { kind: "company-themes" };
      default:
        return assertNever(asset);
    }
  }
  const envId = requireOption(options.env, "--env");
  switch (asset) {
    case "plugins":
      return { kind: "plugins", envId };
    case "themes":
      return { kind: "themes", envId };
    default:
      return assertNever(asset);
  }
}

function assetUpdateRequest(
  asset: WpAssetKind,
  envId: string,
  body: JsonValue,
): ActionRequest {
  switch (asset) {
    case "plugins":
      return { kind: "update-plugin", envId, body };
    case "themes":
      return { kind: "update-theme", envId, body };
    default:
      return assertNever(asset);
  }
}

function assetUpdateAllRequest(
  asset: WpAssetKind,
  envId: string,
  body: JsonValue,
): ActionRequest {
  switch (asset) {
    case "plugins":
      return { kind: "bulk-update-plugins", envId, body };
    case "themes":
      return { kind: "bulk-update-themes", envId, body };
    default:
      return assertNever(asset);
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin install orchestration                                               */
/* -------------------------------------------------------------------------- */

/**
 * Seams for {@link createWpHandlers}; production supplies none. The `fetch`
 * seam and the two source-resolution helpers behind it now live in
 * `src/provisioning/`, which owns everything from "the operator named a source"
 * to "the plugin is active"; this group keeps only what reads a CLI option.
 */
interface WpCommandOverrides {
  /** Defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Defaults to {@link NOVAMIRA_LATEST_RELEASE_API}. */
  readonly latestReleaseApi?: string;
}

function pollBudget(options: WpPluginInstallCommandOptions): PollBudget {
  return {
    intervalSeconds: options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
  };
}

/**
 * Go's `wpPluginInstallActivationPlan`. A `--from-json` body or an InstaWP
 * saved command is opaque to HQ, so neither can be followed by an activation;
 * nor can a source whose slug cannot be inferred.
 */
function installActivationPlan(
  options: WpPluginInstallCommandOptions,
): ActivationPlan | undefined {
  if (options.fromJson !== undefined && options.fromJson !== "")
    return undefined;
  if (options.commandId !== undefined && options.commandId !== 0)
    return undefined;
  const activate = options.activate ?? true;
  const network = options.activateNetwork ?? false;
  if (!activate && !network) return undefined;
  const slug = inferPluginSlug(options.source ?? "");
  if (slug === "") return undefined;
  return { slug, network };
}

/**
 * Go's `wpPluginInstallPreparedPayload`. When HQ can see WP-CLI results and is
 * going to wait anyway, activation is deferred to its own command so that a
 * silent activation failure inside the install run cannot be mistaken for
 * success.
 */
async function preparedInstallPayload(
  options: WpPluginInstallCommandOptions,
  canObserveWpCli: boolean,
  io: CommandIo,
): Promise<{ readonly body: JsonValue; readonly activation?: ActivationPlan }> {
  const activation = installActivationPlan(options);
  const defer =
    activation !== undefined && (options.wait ?? true) && canObserveWpCli;
  const body = await wpPluginInstallPayload(
    defer ? { ...options, activate: false, activateNetwork: false } : options,
    io,
  );
  return activation === undefined ? { body } : { body, activation };
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

export function createWpHandlers(
  dependencies: CommandDependencies,
  overrides: WpCommandOverrides = {},
): WpHandlers {
  const http: HttpFetch =
    overrides.fetch ?? ((input, init) => fetch(input, init));
  const latestReleaseApi =
    overrides.latestReleaseApi ?? NOVAMIRA_LATEST_RELEASE_API;

  const runInstall = async (
    client: ProviderClient,
    io: CommandIo,
    options: WpPluginInstallCommandOptions,
  ): Promise<RenderedResult> => {
    // Go resolves and validates --source before it demands --env, so a typo in
    // the source is reported first regardless of the other options.
    let resolved = options.source ?? "";
    if (resolved !== "") {
      resolved = await resolvePluginSource(resolved, http, latestReleaseApi);
      if (options.validateSource ?? true)
        await validateRemotePluginSource(resolved, http);
    }
    const effective: WpPluginInstallCommandOptions =
      resolved === "" ? options : { ...options, source: resolved };

    const envId = requireOption(options.env, "--env");
    const budget = pollBudget(options);
    const canObserveWpCli = wpCliResultsObservable(client);
    const { body, activation } = await preparedInstallPayload(
      effective,
      canObserveWpCli,
      io,
    );

    if (
      (options.preflight ?? true) &&
      canObserveWpCli &&
      installPreflightApplies(body)
    )
      await preflightWpCli(client, envId, budget);

    const result = await client.action({ kind: "run-wp-cli", envId, body });

    const activateIfPlanned = async (): Promise<
      OperationStatus | undefined
    > => {
      if (activation === undefined || !canObserveWpCli) return undefined;
      return activateInstalledPlugin(client, envId, activation, budget);
    };

    if ((options.wait ?? true) && result.operationId !== undefined) {
      const status = await waitForOperationStatus(
        client,
        result.operationId,
        budget,
      );
      if (status.failed) throw operationFailure(status);
      const activated = await activateIfPlanned();
      return renderOperation(activated ?? status);
    }

    const activated = await activateIfPlanned();
    return activated === undefined
      ? renderAction(result)
      : renderOperation(activated);
  };

  return {
    wpAssetList: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderRaw(await client.read(assetListRequest(asset, options))),
      ),

    wpAssetUpdate: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpAssetUpdatePayload(options, io);
        // Go passes `--env` through unchecked here; an empty id reaches the
        // provider and is reported by it.
        const envId = options.env ?? "";
        return renderAction(
          await client.action(assetUpdateRequest(asset, envId, body)),
        );
      }),

    wpAssetUpdateAll: (asset, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpAssetUpdateAllPayload(options, asset, io);
        const envId = options.env ?? "";
        return renderAction(
          await client.action(assetUpdateAllRequest(asset, envId, body)),
        );
      }),

    wpPluginInstall: (options, globals) =>
      runHostingCommand(dependencies, globals, ({ client, io }) =>
        runInstall(client, io, options),
      ),

    wpCliRun: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await wpCliPayload(options, io);
        return renderAction(
          await client.action({
            kind: "run-wp-cli",
            envId: options.env ?? "",
            body,
          }),
        );
      }),

    logsGet: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const fileName = requireEnum(
          options.file ?? DEFAULT_LOG_FILE,
          "--file",
          LOG_FILES,
        );
        return renderRaw(
          await client.read({
            kind: "logs",
            envId: options.env ?? "",
            fileName,
            lines: options.lines ?? DEFAULT_LOG_LINES,
          }),
        );
      }),

    analyticsUsage: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const metric = options.metric ?? "";
        // Go only validates a non-empty metric: the provider picks its own
        // default when none is asked for.
        if (metric !== "") requireEnum(metric, "--metric", USAGE_METRICS);
        return renderRaw(
          await client.read({
            kind: "analytics-usage",
            siteId: options.site ?? "",
            metric,
          }),
        );
      }),

    analyticsEnv: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const metric = options.metric ?? "";
        if (metric !== "") requireEnum(metric, "--metric", ENV_METRICS);
        // Go read `Flags().Changed("time-zone")`; an option with no default is
        // `undefined` exactly when it was not given, so `--time-zone ""` still
        // counts as given and still resolves to "omit it" through buildQuery.
        const timeZone =
          metric === DISKSPACE_METRIC
            ? (options.timeZone ?? DEFAULT_DISKSPACE_TIME_ZONE)
            : options.timeZone;
        const query = buildQuery([
          ["time_span", options.timeSpan ?? DEFAULT_ANALYTICS_TIME_SPAN],
          ["company_id", options.company],
          ["from", options.from],
          ["to", options.to],
          ["time_zone", timeZone],
        ]);
        return renderRaw(
          await client.read({
            kind: "analytics-env",
            envId: options.env ?? "",
            metric,
            query,
          }),
        );
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Commander invokes an action handler with the declared arguments, then the
 * command's own options, then the command itself. None of these commands takes
 * a positional argument, so every handler below is `(options, command)` and
 * `optionsFor([command])` resolves the globals exactly as `program.ts` does.
 */

function registerAssetCommands(
  parent: Command,
  asset: WpAssetKind,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const noun = asset === "plugins" ? "plugin" : "theme";
  const group = parent
    .command(asset)
    .description(`${asset} operations on a provider environment`);

  group
    .command("list")
    .description(`list ${asset}`)
    .option("--env <id>", "environment id")
    .option("--company", "list the company-wide catalogue instead", false)
    .action(async (options: WpAssetListOptions, command: Command) =>
      handlers.wpAssetList(asset, options, optionsFor([command])),
    );

  if (asset === "plugins") registerPluginInstall(group, handlers, optionsFor);

  const update = group
    .command("update")
    .description(`update one ${noun}`)
    .option("--env <id>", "environment id")
    .option("--name <name>", `${noun} slug`)
    .option("--update-version <version>", `${noun} version to update to`);
  addFromJsonOption(update).action(
    async (options: WpAssetUpdateCommandOptions, command: Command) =>
      handlers.wpAssetUpdate(asset, options, optionsFor([command])),
  );

  const updateAll = group
    .command("update-all")
    .description(`update several ${asset} in one request`)
    .option("--env <id>", "environment id")
    .option("--name <name>", `${noun} slug (repeatable)`, collect, []);
  addFromJsonOption(updateAll).action(
    async (options: WpAssetUpdateAllCommandOptions, command: Command) =>
      handlers.wpAssetUpdateAll(asset, options, optionsFor([command])),
  );
}

function registerPluginInstall(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const install = parent
    .command("install")
    .description("install a plugin through the provider's WP-CLI endpoint")
    .option("--env <id>", "environment id")
    .option(
      "--source <source>",
      `plugin slug, local zip path, or remote zip URL (${NOVAMIRA_LATEST_SOURCE_ALIAS} resolves to the newest Novamira release)`,
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
      "--command-id <id>",
      "InstaWP saved command id to run instead of a built command",
      parseUnsignedInteger,
      0,
    )
    .option("--preflight", "run a DB-backed WP-CLI preflight first", true)
    .option("--no-preflight", "skip the WP-CLI preflight")
    .option("--validate-source", "check a remote zip URL first", true)
    .option("--no-validate-source", "do not check a remote zip URL")
    .option("--wait", "wait for the provider operation to complete", true)
    .option("--no-wait", "return as soon as the provider accepts the request");
  addPollingOptions(addFromJsonOption(install)).action(
    async (options: WpPluginInstallCommandOptions, command: Command) =>
      handlers.wpPluginInstall(options, optionsFor([command])),
  );
}

function registerWpCliCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const wpCli = parent.command("wp-cli").description("WP-CLI operations");
  const run = wpCli
    .command("run")
    .description("run a WP-CLI command on an environment")
    .option("--env <id>", "environment id")
    .option("--command <command>", "the WP-CLI command line to run")
    .option(
      "--command-stdin",
      "read the WP-CLI command line from stdin",
      false,
    );
  addFromJsonOption(run).action(
    async (options: WpCliRunCommandOptions, command: Command) =>
      handlers.wpCliRun(options, optionsFor([command])),
  );
}

function registerLogsCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const logs = parent.command("logs").description("log operations");
  logs
    .command("get")
    .description("read an environment log file")
    .option("--env <id>", "environment id")
    .option("--file <name>", LOG_FILES.join("|"), DEFAULT_LOG_FILE)
    .option(
      "--lines <count>",
      "number of trailing lines to read",
      parseUnsignedInteger,
      DEFAULT_LOG_LINES,
    )
    .action(async (options: LogsGetOptions, command: Command) =>
      handlers.logsGet(options, optionsFor([command])),
    );
}

function registerAnalyticsCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const analytics = parent
    .command("analytics")
    .description("analytics operations");

  analytics
    .command("usage")
    .description("site usage analytics")
    .option("--site <id>", "site id")
    .option("--metric <metric>", USAGE_METRICS.join("|"))
    .action(async (options: AnalyticsUsageOptions, command: Command) =>
      handlers.analyticsUsage(options, optionsFor([command])),
    );

  analytics
    .command("env")
    .description("environment analytics")
    .option("--env <id>", "environment id")
    .option("--metric <metric>", ENV_METRICS.join("|"))
    .option(
      "--time-span <span>",
      "provider time span",
      DEFAULT_ANALYTICS_TIME_SPAN,
    )
    .option("--company <id>", "company id")
    .option("--from <from>", "range start, as the provider expects it")
    .option("--to <to>", "range end, as the provider expects it")
    .option(
      "--time-zone <offset>",
      `time zone offset (defaults to ${DEFAULT_DISKSPACE_TIME_ZONE} for the ${DISKSPACE_METRIC} metric)`,
    )
    .action(async (options: AnalyticsEnvOptions, command: Command) =>
      handlers.analyticsEnv(options, optionsFor([command])),
    );
}

/**
 * Attach `wp`, `wp-cli`, `logs` and `analytics` to `parent` — the `hosting`
 * command in the assembled program.
 */
export function registerWpCommands(
  parent: Command,
  handlers: WpHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const wp = parent.command("wp").description("WordPress asset operations");
  registerAssetCommands(wp, "plugins", handlers, optionsFor);
  registerAssetCommands(wp, "themes", handlers, optionsFor);
  registerWpCliCommands(parent, handlers, optionsFor);
  registerLogsCommands(parent, handlers, optionsFor);
  registerAnalyticsCommands(parent, handlers, optionsFor);
}

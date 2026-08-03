// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting providers`, `hosting regions`, `hosting activity` and `hosting ops`,
 * ported from the `newProvidersCommand` / `newRegionsCommand` /
 * `newActivityCommand` / `newOpsCommand` trees in `internal/cli/hosting.go`.
 *
 * These are the read-only, provider-neutral commands: they answer "does this
 * credential work", "what can this provider do", "where can it run", "what
 * happened lately" and "is that operation finished yet". None of them mutates a
 * provider resource and none of them takes a request body, so there is no
 * `--from-json` anywhere in this group.
 *
 * Two things differ from the Go original.
 *
 * 1. Go's `RunE` bodies each repeated `selectedClient(flags)` and then printed
 *    to stdout themselves. Here the grammar (`registerHostingInventoryCommands`)
 *    and the work (`createHostingInventoryHandlers`) are separated, and every
 *    handler goes through {@link runHostingCommand}, which resolves the profile,
 *    builds the client and renders exactly one envelope carrying `meta.profile`
 *    and `meta.provider`.
 * 2. `ops wait` no longer needs its own zero-interval guard: `--interval-seconds`
 *    is parsed by `parsePositiveInteger`, so a busy loop cannot even be spelled
 *    on the command line, and {@link waitForOperationStatus} still fails closed
 *    for a value that arrived from anywhere else.
 *
 * `--profile` is a global option in the v1 contract and is registered by
 * `program.ts`, never here.
 */

import type { Command } from "commander";

import type { CommandDependencies } from "../commands.js";
import { addPollingOptions, parseUnsignedInteger } from "../flags.js";
import {
  operationFailure,
  runHostingCommand,
  waitForOperationStatus,
  type HostingOptions,
} from "../hosting-command.js";
import { buildQuery } from "../payloads.js";
import {
  disableSiteDeleteCapability,
  renderOperation,
  renderRaw,
  renderValidation,
} from "../print.js";
import type { GlobalOptions } from "../program.js";

/** Go's `--limit` default for `hosting activity list`. */
const DEFAULT_ACTIVITY_LIMIT = 10;

/** Go's `--offset` default for `hosting activity list`. */
const DEFAULT_ACTIVITY_OFFSET = 0;

/** Options of `hosting regions list`. */
interface RegionsListOptions {
  /** `--company <id>`: provider account scope; the profile's default when unset. */
  readonly company?: string;
}

/** Options of `hosting activity list`. */
interface ActivityListOptions {
  /** `--limit <n>`: Go's `uint32`, defaulted to 10 and always sent. */
  readonly limit: number;
  /** `--offset <n>`: Go's `uint32`, defaulted to 0 and always sent. */
  readonly offset: number;
  readonly category?: string;
  /** `--site <id>`: sent as the `site_id` query parameter. */
  readonly site?: string;
  /** `--initiated-by <id>`: sent as `id_initiated_by`. */
  readonly initiatedBy?: string;
  /**
   * `--api-key <id>`: sent as `id_api_key`. This is the provider-side
   * *identifier* of an API key, never a key value; HQ takes no secret on argv.
   */
  readonly apiKey?: string;
  readonly language?: string;
  readonly company?: string;
}

/** Options of `hosting ops wait`. */
interface OpsWaitOptions {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
}

/**
 * One method per subcommand of this group. Each takes its own parsed options
 * (when it has any) plus the global options the program resolved.
 */
export interface HostingInventoryHandlers {
  /** `hosting providers validate` */
  providersValidate(options: HostingOptions): Promise<void>;
  /** `hosting providers capabilities` */
  providersCapabilities(options: HostingOptions): Promise<void>;
  /** `hosting regions list` */
  regionsList(
    options: RegionsListOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting activity list` */
  activityList(
    options: ActivityListOptions,
    globals: HostingOptions,
  ): Promise<void>;
  /** `hosting ops get <operation_id>` */
  opsGet(operationId: string, globals: HostingOptions): Promise<void>;
  /** `hosting ops wait <operation_id>` */
  opsWait(
    operationId: string,
    options: OpsWaitOptions,
    globals: HostingOptions,
  ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Go's `optStr`: an option that was not given, and an option given as the empty
 * string, both mean "omit the field". Returns a spreadable fragment so
 * `exactOptionalPropertyTypes` never sees an explicit `undefined`.
 */
function optionalCompanyId(company: string | undefined): {
  readonly companyId?: string;
} {
  return company === undefined || company === "" ? {} : { companyId: company };
}

export function createHostingInventoryHandlers(
  dependencies: CommandDependencies,
): HostingInventoryHandlers {
  return {
    providersValidate: (options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderValidation(await client.validate()),
      ),

    providersCapabilities: (options) =>
      runHostingCommand(dependencies, options, async ({ client }) => {
        const value = await client.read({ kind: "capabilities" });
        // `hosting sites delete` is deliberately not registered, so a provider
        // that advertises sites.delete must not be reported as offering it.
        return renderRaw(disableSiteDeleteCapability(value));
      }),

    regionsList: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "regions",
            ...optionalCompanyId(options.company),
          }),
        ),
      ),

    activityList: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        // Order is Go's `pushQuery` order; several provider APIs care.
        const query = buildQuery([
          ["limit", options.limit],
          ["offset", options.offset],
          ["category", options.category],
          ["site_id", options.site],
          ["id_initiated_by", options.initiatedBy],
          ["id_api_key", options.apiKey],
          ["language", options.language],
        ]);
        return renderRaw(
          await client.read({
            kind: "activity",
            ...optionalCompanyId(options.company),
            query,
          }),
        );
      }),

    opsGet: (operationId, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderOperation(await client.operationStatus(operationId)),
      ),

    opsWait: (operationId, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const status = await waitForOperationStatus(client, operationId, {
          intervalSeconds: options.intervalSeconds,
          timeoutSeconds: options.timeoutSeconds,
        });
        // Go turned a failed operation into an error here rather than printing
        // it; the shared helper returns it so this command can do the same.
        if (status.failed) throw operationFailure(status);
        return renderOperation(status);
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

export function registerHostingInventoryCommands(
  parent: Command,
  handlers: HostingInventoryHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const providers = parent
    .command("providers")
    .description("provider credential operations");

  providers
    .command("validate")
    .description("validate the profile's provider credential")
    .action(async (...values: unknown[]) =>
      handlers.providersValidate(optionsFor(values)),
    );

  providers
    .command("capabilities")
    .description("list the operations this provider supports")
    .action(async (...values: unknown[]) =>
      handlers.providersCapabilities(optionsFor(values)),
    );

  const regions = parent.command("regions").description("region operations");

  regions
    .command("list")
    .description("list the regions available to this provider")
    .option("--company <id>", "company id")
    .action(async (options: RegionsListOptions, ...values: unknown[]) =>
      handlers.regionsList(options, optionsFor(values)),
    );

  const activity = parent
    .command("activity")
    .description("activity log operations");

  activity
    .command("list")
    .description("list activity entries")
    .option(
      "--limit <n>",
      "limit",
      parseUnsignedInteger,
      DEFAULT_ACTIVITY_LIMIT,
    )
    .option(
      "--offset <n>",
      "offset",
      parseUnsignedInteger,
      DEFAULT_ACTIVITY_OFFSET,
    )
    .option("--category <name>", "category")
    .option("--site <id>", "site id")
    .option("--initiated-by <id>", "initiated by id")
    .option("--api-key <id>", "API key id (an identifier, never a key value)")
    .option("--language <code>", "language")
    .option("--company <id>", "company id")
    .action(async (options: ActivityListOptions, ...values: unknown[]) =>
      handlers.activityList(options, optionsFor(values)),
    );

  const ops = parent.command("ops").description("operation status");

  ops
    .command("get")
    .description("get the status of an asynchronous provider operation")
    .argument("<operation_id>", "provider operation id")
    .action(async (operationId: string, ...values: unknown[]) =>
      handlers.opsGet(operationId, optionsFor(values)),
    );

  addPollingOptions(
    ops
      .command("wait")
      .description("poll an asynchronous provider operation until it finishes")
      .argument("<operation_id>", "provider operation id"),
  ).action(
    async (
      operationId: string,
      options: OpsWaitOptions,
      ...values: unknown[]
    ) => handlers.opsWait(operationId, options, optionsFor(values)),
  );
}

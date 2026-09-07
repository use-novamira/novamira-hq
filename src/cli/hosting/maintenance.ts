// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `hosting backups`, `hosting cache`, `hosting php`, `hosting redirects`
 * and `hosting denied-ips` command groups, ported from the `newBackupsCommand`,
 * `newCacheCommand`, `newPhpCommand`, `newRedirectsCommand` and
 * `newDeniedIpsCommand` trees in `internal/cli/hosting.go`.
 *
 * These five groups are the "operate an existing environment" half of the
 * hosting tree: nothing here creates or destroys a site, every subcommand is
 * either a raw provider read rendered through {@link renderRaw} or a single
 * provider action rendered through {@link renderAction}, and none of them holds
 * a secret.
 *
 * The file keeps grammar and behaviour apart, the way `program.ts` and
 * `commands.ts` are apart:
 *
 * - {@link registerMaintenanceCommands} owns the commander grammar and nothing
 *   else. It never touches a provider, so the option surface can be asserted
 *   without a client;
 * - {@link createMaintenanceHandlers} owns the behaviour. Every handler is one
 *   {@link runHostingCommand} call, so profile resolution, client construction,
 *   the `meta.profile` / `meta.provider` fields and the success envelope are
 *   identical across all twelve subcommands.
 *
 * Two deliberate departures from the Go source, both narrowing what can reach a
 * provider:
 *
 * 1. Go's `cacheKindFromArg` mapped every unrecognised `--kind` onto the site
 *    cache after `validateEnum` had already rejected it, so the fallback was
 *    dead code that would have silently cleared the wrong layer if it ever ran.
 *    Here `--kind` is parsed by {@link oneOf}, so an invalid value fails during
 *    commander's own parse and the handler receives a `CacheKind`.
 * 2. Go passed an omitted `--env` / `--target-env` through as `""`, and every
 *    provider interpolates that id into a URL path segment — the request went
 *    out and came back as a confusing provider 404. {@link requireRequestId}
 *    reports it as `usage_error` naming the flag instead. This is the only
 *    required-ness this file adds, and it applies only to ids that travel in
 *    the request path, never to a field `--from-json` could have supplied.
 */

import { Command, type OptionValues } from "commander";

import type { CommandDependencies } from "../commands.js";
import { CliError } from "../../errors.js";
import {
  executeBackupRestore,
  prepareBackupRestore,
} from "../../hosting/backup-restore.js";
import { CACHE_KINDS, type CacheKind } from "../../hosting/types.js";
import {
  addFromJsonOption,
  collect,
  oneOf,
  parseUnsignedInteger,
} from "../flags.js";
import { runHostingCommand, type HostingOptions } from "../hosting-command.js";
import {
  backupCreatePayload,
  buildQuery,
  cacheClearPayload,
  deniedIpsSetPayload,
  phpSetVersionPayload,
  requiredPayload,
} from "../payloads.js";
import { renderAction, renderRaw } from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Parsed option shapes                                                       */
/* -------------------------------------------------------------------------- */

/** `backups list`, `backups downloadable`, `php restart`, `denied-ips list`. */
interface EnvValues {
  readonly env?: string;
}

/** `backups create`. */
interface BackupsCreateValues {
  readonly env?: string;
  readonly fromJson?: string;
  /** Present only when `--tag` was given, including as an empty string. */
  readonly tag?: string;
}

/** `backups restore`: intentionally typed, with no raw JSON escape hatch. */
interface BackupsRestoreValues {
  readonly env?: string;
  readonly backupId?: string;
  readonly allContent: boolean;
  readonly notifiedUserId?: string;
}

/** `cache clear`. `kind` always has a value: `--kind` defaults to `site`. */
interface CacheClearValues {
  readonly fromJson?: string;
  readonly kind: CacheKind;
  readonly env?: string;
  readonly cdnCacheId?: string;
  readonly clearSubdirectories: boolean;
  readonly url?: string;
}

/** `php set-version`. */
interface PhpSetVersionValues {
  readonly fromJson?: string;
  readonly env?: string;
  /**
   * `--php-version`. Go spelled this `--version`, but `--version` is a global
   * in the v1 contract and commander lets an ancestor's option consume a match
   * anywhere in argv, so the leaf flag would never see its value.
   */
  readonly phpVersion?: string;
  readonly optOutAutoUpdates: boolean;
}

/** `redirects list`. `limit` and `offset` are absent unless the flag was given. */
interface RedirectsListValues {
  readonly env?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly key?: string;
  readonly order?: string;
  readonly search?: string;
  readonly regexSearch: boolean;
}

/** `redirects apply`. */
interface RedirectsApplyValues {
  readonly env?: string;
  readonly fromJson?: string;
}

/** `denied-ips set`. */
interface DeniedIpsSetValues {
  readonly fromJson?: string;
  readonly env?: string;
  readonly ip: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One method per subcommand. Each takes the subcommand's own parsed options
 * (and its positional arguments, first) plus the global options, and renders
 * through the injected renderer rather than returning anything.
 */
export interface MaintenanceHandlers {
  backupsList(values: EnvValues, options: HostingOptions): Promise<void>;
  backupsDownloadable(
    values: EnvValues,
    options: HostingOptions,
  ): Promise<void>;
  backupsCreate(
    values: BackupsCreateValues,
    options: HostingOptions,
  ): Promise<void>;
  backupsRestore(
    values: BackupsRestoreValues,
    options: HostingOptions,
  ): Promise<void>;
  cacheClear(values: CacheClearValues, options: HostingOptions): Promise<void>;
  phpRestart(values: EnvValues, options: HostingOptions): Promise<void>;
  phpSetVersion(
    values: PhpSetVersionValues,
    options: HostingOptions,
  ): Promise<void>;
  redirectsList(
    values: RedirectsListValues,
    options: HostingOptions,
  ): Promise<void>;
  redirectsApply(
    values: RedirectsApplyValues,
    options: HostingOptions,
  ): Promise<void>;
  deniedIpsList(values: EnvValues, options: HostingOptions): Promise<void>;
  deniedIpsSet(
    values: DeniedIpsSetValues,
    options: HostingOptions,
  ): Promise<void>;
}

/**
 * An id that travels in the provider request path rather than in the request
 * body. `--from-json` cannot supply one, so the message deliberately does not
 * mention it (unlike `requireOption`, which reports a *payload* field).
 */
function requireRequestId(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new CliError("usage_error", `${flag} is required.`, {
      details: { flag },
    });
  }
  return value;
}

export function createMaintenanceHandlers(
  dependencies: CommandDependencies,
): MaintenanceHandlers {
  return {
    backupsList: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "backups",
            envId: requireRequestId(values.env, "--env"),
          }),
        ),
      ),

    backupsDownloadable: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "downloadable-backups",
            envId: requireRequestId(values.env, "--env"),
          }),
        ),
      ),

    backupsCreate: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireRequestId(values.env, "--env");
        const body = await backupCreatePayload(values, io);
        return renderAction(
          await client.action({ kind: "create-backup", envId, body }),
        );
      }),

    backupsRestore: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) => {
        if (!options.yes)
          throw new CliError(
            "confirmation_required",
            "Backup restore overwrites hosting data; pass --yes to continue.",
            { details: { flag: "--yes" } },
          );
        const plan = await prepareBackupRestore(client, {
          targetEnvironmentId: requireRequestId(values.env, "--env"),
          backupId: requireRequestId(values.backupId, "--backup-id"),
          allContent: values.allContent,
          ...(values.notifiedUserId === undefined
            ? {}
            : { notifiedUserId: values.notifiedUserId }),
        });
        return renderRaw(
          await executeBackupRestore(client, plan, {
            intervalSeconds: 5,
            timeoutSeconds: options.timeoutExplicit
              ? Math.max(1, Math.ceil(options.timeout / 1000))
              : 300,
          }),
        );
      }),

    cacheClear: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) =>
        renderAction(
          await client.action({
            kind: "clear-cache",
            cache: values.kind,
            body: await cacheClearPayload(values, io),
          }),
        ),
      ),

    phpRestart: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "restart-php",
            envId: requireRequestId(values.env, "--env"),
          }),
        ),
      ),

    phpSetVersion: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) =>
        renderAction(
          await client.action({
            kind: "set-php-version",
            body: await phpSetVersionPayload(values, io),
          }),
        ),
      ),

    redirectsList: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "redirects",
            envId: requireRequestId(values.env, "--env"),
            // Order is Go's: limit, offset, key, order, search_query,
            // regex_search. `--regex-search` is only ever sent when set, as a
            // provider that treats the parameter's presence as truthy would
            // otherwise see `regex_search=false` and enable it.
            query: buildQuery([
              ["limit", values.limit],
              ["offset", values.offset],
              ["key", values.key],
              ["order", values.order],
              ["search_query", values.search],
              ["regex_search", values.regexSearch ? "true" : undefined],
            ]),
          }),
        ),
      ),

    redirectsApply: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireRequestId(values.env, "--env");
        const body = await requiredPayload(
          values.fromJson,
          "redirects apply",
          io,
        );
        return renderAction(
          await client.action({ kind: "apply-redirects", envId, body }),
        );
      }),

    deniedIpsList: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "denied-ips",
            envId: requireRequestId(values.env, "--env"),
          }),
        ),
      ),

    deniedIpsSet: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) =>
        renderAction(
          await client.action({
            kind: "set-denied-ips",
            body: await deniedIpsSetPayload(values, io),
          }),
        ),
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The innermost command's own options. `optionsFor` resolves the *globals* off
 * the same argument list; this resolves the subcommand-local ones, without
 * depending on where commander happens to place them positionally.
 *
 * Commander's `OptionValues` is an index signature, so it satisfies an
 * all-optional option interface structurally. The four shapes with a
 * defaulted member (`--kind`, `--clear-subdirectories`, `--opt-out-auto-updates`,
 * `--regex-search`, `--ip`) name themselves at the call site, because only the
 * grammar below guarantees the default is there; the grammar tests parse every
 * subcommand and assert the values each handler was handed.
 */
function optionValues(values: readonly unknown[]): OptionValues {
  const active = values.findLast(
    (value): value is Command => value instanceof Command,
  );
  if (active === undefined) {
    throw new CliError(
      "internal_error",
      "Command options were not supplied by the parser.",
    );
  }
  return active.opts();
}

/** `--env <id>`, spelled identically by every group in this file. */
function addEnvOption(command: Command): Command {
  return command.option("--env <id>", "environment id");
}

function registerBackupsCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const backups = parent.command("backups").description("backup operations");

  addEnvOption(backups.command("list").description("list backups")).action(
    async (...values: unknown[]) =>
      handlers.backupsList(optionValues(values), optionsFor(values)),
  );

  addEnvOption(
    backups.command("downloadable").description("list downloadable backups"),
  ).action(async (...values: unknown[]) =>
    handlers.backupsDownloadable(optionValues(values), optionsFor(values)),
  );

  const create = backups.command("create").description("create a backup");
  addEnvOption(create);
  addFromJsonOption(create);
  create
    .option("--tag <tag>", "label stored with the backup")
    .action(async (...values: unknown[]) =>
      handlers.backupsCreate(optionValues(values), optionsFor(values)),
    );

  const restore = backups
    .command("restore")
    .description("restore a complete backup after creating a safety backup");
  addEnvOption(restore);
  restore
    .option("--backup-id <id>", "backup id from this environment's catalog")
    .option(
      "--all-content",
      "explicitly acknowledge overwriting all environment content",
      false,
    )
    .option(
      "--notified-user-id <id>",
      "Kinsta user id to notify about the restore",
    )
    .action(async (...values: unknown[]) =>
      handlers.backupsRestore(
        optionValues(values) as unknown as BackupsRestoreValues,
        optionsFor(values),
      ),
    );
}

function registerCacheCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const cache = parent.command("cache").description("cache operations");
  const clear = cache.command("clear").description("clear a cache layer");
  addFromJsonOption(clear);
  addEnvOption(clear);
  clear
    .option(
      "--kind <kind>",
      `cache layer to clear (${CACHE_KINDS.join("|")})`,
      oneOf(CACHE_KINDS),
      "site" as CacheKind,
    )
    .option("--cdn-cache-id <id>", "CDN cache to clear, for --kind cdn")
    .option(
      "--clear-subdirectories",
      "also clear subdirectories of --url, for --kind edge",
      false,
    )
    .option("--url <url>", "URL to clear, for --kind edge")
    .action(async (...values: unknown[]) =>
      handlers.cacheClear(
        optionValues(values) as CacheClearValues,
        optionsFor(values),
      ),
    );
}

function registerPhpCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const php = parent.command("php").description("PHP operations");

  addEnvOption(php.command("restart").description("restart PHP")).action(
    async (...values: unknown[]) =>
      handlers.phpRestart(optionValues(values), optionsFor(values)),
  );

  const setVersion = php
    .command("set-version")
    .description("set the PHP version");
  addFromJsonOption(setVersion);
  addEnvOption(setVersion);
  setVersion
    .option("--php-version <version>", "PHP version to run")
    .option("--opt-out-auto-updates", "opt out of automatic PHP updates", false)
    .action(async (...values: unknown[]) =>
      handlers.phpSetVersion(
        optionValues(values) as PhpSetVersionValues,
        optionsFor(values),
      ),
    );
}

function registerRedirectsCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const redirects = parent
    .command("redirects")
    .description("redirect operations");

  const list = redirects.command("list").description("list redirects");
  addEnvOption(list);
  list
    .option(
      "--limit <count>",
      "maximum redirects to return",
      parseUnsignedInteger,
    )
    .option("--offset <count>", "redirects to skip", parseUnsignedInteger)
    .option("--key <key>", "field to sort by")
    .option("--order <order>", "sort direction")
    .option("--search <query>", "search query")
    .option("--regex-search", "treat --search as a regular expression", false)
    .action(async (...values: unknown[]) =>
      handlers.redirectsList(
        optionValues(values) as RedirectsListValues,
        optionsFor(values),
      ),
    );

  const apply = redirects.command("apply").description("apply redirects");
  addEnvOption(apply);
  addFromJsonOption(apply).action(async (...values: unknown[]) =>
    handlers.redirectsApply(optionValues(values), optionsFor(values)),
  );
}

function registerDeniedIpsCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const deniedIps = parent
    .command("denied-ips")
    .description("denied IP operations");

  addEnvOption(deniedIps.command("list").description("list denied IPs")).action(
    async (...values: unknown[]) =>
      handlers.deniedIpsList(optionValues(values), optionsFor(values)),
  );

  const set = deniedIps.command("set").description("set the denied IP list");
  addFromJsonOption(set);
  addEnvOption(set);
  set
    .option("--ip <ip>", "denied IP; repeat for more than one", collect, [])
    .action(async (...values: unknown[]) =>
      handlers.deniedIpsSet(
        optionValues(values) as DeniedIpsSetValues,
        optionsFor(values),
      ),
    );
}

/**
 * Attach `backups`, `cache`, `php`, `redirects` and `denied-ips` to the command
 * they belong under — `hosting` in the real program, a throwaway `Command` in a
 * test. Nothing here reads configuration or reaches a provider.
 */
export function registerMaintenanceCommands(
  parent: Command,
  handlers: MaintenanceHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  registerBackupsCommands(parent, handlers, optionsFor);
  registerCacheCommands(parent, handlers, optionsFor);
  registerPhpCommands(parent, handlers, optionsFor);
  registerRedirectsCommands(parent, handlers, optionsFor);
  registerDeniedIpsCommands(parent, handlers, optionsFor);
}

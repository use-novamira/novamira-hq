// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting sites` and `hosting envs`, ported from `newSitesCommand` and
 * `newEnvsCommand` in `internal/cli/hosting.go`.
 *
 * The two trees live in one module because they are one feature: an
 * environment is a site's child, `envs create` addresses its parent with
 * `--site`, and the three create modes (`create`, `create-plain`, `clone`)
 * are the same design repeated on both levels. Splitting them would put the
 * `SiteCreateMode` and `EnvironmentCreateMode` dispatch in two files that have
 * to be read together anyway.
 *
 * The file has two halves, mirroring how `program.ts` and `commands.ts` are
 * separated:
 *
 * - {@link SitesHandlers} plus {@link createSitesHandlers} — what each
 *   subcommand *does*: build a payload, dispatch one provider request, describe
 *   the result. Nothing here knows what a flag is called.
 * - {@link registerSitesCommands} — the commander grammar: the flags, their
 *   defaults, their parsers, and the mapping from parsed options onto a handler
 *   call. Nothing here talks to a provider.
 *
 * Three things deliberately differ from the Go source.
 *
 * 1. **`hosting sites delete` is not registered.** Go kept
 *    `newSitesDeleteCommand` around but never added it to the tree
 *    (`TestSitesDeleteCommandIsNotRegistered`), and `print.ts`'s
 *    `disableSiteDeleteCapability` reports `sites.delete` as unsupported for
 *    exactly that reason. {@link SitesHandlers.sitesDelete} is kept for the same
 *    reason Go kept the constructor — so the provider action wiring survives if
 *    the command is ever restored — but {@link registerSitesCommands} must not
 *    register it while the capability is advertised as disabled.
 * 2. **`--no-db`, `--no-files` and `--no-search-replace`** are cobra booleans in
 *    Go and commander *negated* booleans here, so commander parses them into
 *    `db`/`files`/`searchReplace` (defaulting to `true`). The grammar half
 *    inverts them back into the `noDb`/`noFiles`/`noSearchReplace` shape
 *    `environmentPushPayload` expects, so argv and the request body are both
 *    unchanged.
 * 3. **`sites list` does not pass a company id.** Go called
 *    `client.ListSites(profile.CompanyID, includeEnvs)`; every HQ provider
 *    client already falls back to the profile's configured company, so passing
 *    it again here would only create a second place for the two to disagree.
 */

import type { Command } from "commander";

import { CliError } from "../../errors.js";
import type { CommandDependencies } from "../commands.js";
import {
  addFromJsonOption,
  addSecretSourceOptions,
  collect,
} from "../flags.js";
import { runHostingCommand, type HostingOptions } from "../hosting-command.js";
import {
  DEFAULT_WP_LANGUAGE,
  environmentClonePayload,
  environmentCreatePayload,
  environmentCreatePlainPayload,
  environmentPushPayload,
  siteClonePayload,
  siteCreatePayload,
  siteCreatePlainPayload,
  siteResetPayload,
  type EnvironmentCloneOptions,
  type EnvironmentCreateOptions,
  type EnvironmentCreatePlainOptions,
  type EnvironmentPushOptions,
  type SiteCloneOptions,
  type SiteCreateOptions,
  type SiteCreatePlainOptions,
  type SiteResetOptions,
} from "../payloads.js";
import {
  renderAction,
  renderEnvironment,
  renderEnvironments,
  renderSite,
  renderSites,
} from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Handler options                                                            */
/* -------------------------------------------------------------------------- */

/** `hosting sites list`. */
export interface SitesListOptions {
  /** `--include-envs`: ask the provider to embed each site's environments. */
  readonly includeEnvs?: boolean;
}

/**
 * The `--site` scope shared by every `hosting envs` subcommand. Go declared it
 * once per command as `f.site` and passed `""` when it was not given; the
 * provider clients keep that contract, so an absent option stays an empty
 * string rather than becoming a usage error here.
 */
export interface EnvironmentScopeOptions {
  /** `--site <id>`: the parent site. */
  readonly site?: string;
}

/** `hosting envs list`. */
export type EnvsListOptions = EnvironmentScopeOptions;

/** `hosting envs get <env_id>`. */
export type EnvsGetOptions = EnvironmentScopeOptions;

/** `hosting envs create`. `--site` is a request field, not a payload field. */
export interface EnvsCreateOptions
  extends EnvironmentCreateOptions, EnvironmentScopeOptions {}

/** `hosting envs create-plain`. */
export interface EnvsCreatePlainOptions
  extends EnvironmentCreatePlainOptions, EnvironmentScopeOptions {}

/** `hosting envs clone`. */
export interface EnvsCloneOptions
  extends EnvironmentCloneOptions, EnvironmentScopeOptions {}

/** `hosting envs push`. */
export interface EnvsPushOptions
  extends EnvironmentPushOptions, EnvironmentScopeOptions {}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One method per `hosting sites` / `hosting envs` subcommand. Each takes its
 * parsed arguments and options followed by the invocation's global options
 * (`HostingOptions` is `GlobalOptions` plus the global `--profile`).
 */
export interface SitesHandlers {
  sitesList(options: SitesListOptions, globals: HostingOptions): Promise<void>;
  sitesGet(siteId: string, globals: HostingOptions): Promise<void>;
  /**
   * `hosting sites delete` is NOT part of the command grammar — see the module
   * comment. This method exists only so the provider action wiring survives,
   * exactly as Go retained `newSitesDeleteCommand`. Registering it would
   * contradict `disableSiteDeleteCapability`, which tells every provider's
   * capability listing that HQ does not expose site deletion.
   */
  sitesDelete(siteId: string, globals: HostingOptions): Promise<void>;
  sitesCreate(
    options: SiteCreateOptions,
    globals: HostingOptions,
  ): Promise<void>;
  sitesCreatePlain(
    options: SiteCreatePlainOptions,
    globals: HostingOptions,
  ): Promise<void>;
  sitesClone(options: SiteCloneOptions, globals: HostingOptions): Promise<void>;
  sitesReset(
    siteId: string,
    options: SiteResetOptions,
    globals: HostingOptions,
  ): Promise<void>;

  envsList(options: EnvsListOptions, globals: HostingOptions): Promise<void>;
  envsGet(
    envId: string,
    options: EnvsGetOptions,
    globals: HostingOptions,
  ): Promise<void>;
  envsDelete(envId: string, globals: HostingOptions): Promise<void>;
  envsCreate(
    options: EnvsCreateOptions,
    globals: HostingOptions,
  ): Promise<void>;
  envsCreatePlain(
    options: EnvsCreatePlainOptions,
    globals: HostingOptions,
  ): Promise<void>;
  envsClone(options: EnvsCloneOptions, globals: HostingOptions): Promise<void>;
  envsPush(options: EnvsPushOptions, globals: HostingOptions): Promise<void>;
}

/** The error Go raised from `envs get` when no environment matched. */
function environmentNotFound(envId: string, siteId: string): CliError {
  return new CliError(
    "not_found",
    `Environment "${envId}" was not found for site "${siteId}".`,
    { details: { environment: envId, site: siteId } },
  );
}

export function createSitesHandlers(
  dependencies: CommandDependencies,
): SitesHandlers {
  return {
    sitesList: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        const sites = await client.listSites({
          includeEnvironments: options.includeEnvs ?? false,
        });
        return renderSites(sites);
      }),

    sitesGet: (siteId, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderSite(await client.getSite(siteId)),
      ),

    sitesDelete: (siteId, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderAction(await client.action({ kind: "delete-site", siteId })),
      ),

    sitesCreate: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await siteCreatePayload(options, io);
        return renderAction(
          await client.action({ kind: "create-site", mode: "wordpress", body }),
        );
      }),

    sitesCreatePlain: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await siteCreatePlainPayload(options, io);
        return renderAction(
          await client.action({ kind: "create-site", mode: "plain", body }),
        );
      }),

    sitesClone: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await siteClonePayload(options, io);
        return renderAction(
          await client.action({ kind: "create-site", mode: "clone", body }),
        );
      }),

    sitesReset: (siteId, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await siteResetPayload(options, io);
        return renderAction(
          await client.action({ kind: "reset-site", siteId, body }),
        );
      }),

    envsList: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderEnvironments(await client.listEnvironments(options.site ?? "")),
      ),

    envsGet: (envId, options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) => {
        // Go had no per-environment provider read, so it listed the site's
        // environments and matched by id. Keeping that shape keeps `envs get`
        // working on every provider rather than only those with a detail route.
        const siteId = options.site ?? "";
        const environments = await client.listEnvironments(siteId);
        const environment = environments.find((entry) => entry.id === envId);
        if (environment === undefined) throw environmentNotFound(envId, siteId);
        return renderEnvironment(environment);
      }),

    envsDelete: (envId, globals) =>
      runHostingCommand(dependencies, globals, async ({ client }) =>
        renderAction(
          await client.action({ kind: "delete-environment", envId }),
        ),
      ),

    envsCreate: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await environmentCreatePayload(options, io);
        return renderAction(
          await client.action({
            kind: "create-environment",
            siteId: options.site ?? "",
            mode: "wordpress",
            body,
          }),
        );
      }),

    envsCreatePlain: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await environmentCreatePlainPayload(options, io);
        return renderAction(
          await client.action({
            kind: "create-environment",
            siteId: options.site ?? "",
            mode: "plain",
            body,
          }),
        );
      }),

    envsClone: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await environmentClonePayload(options, io);
        return renderAction(
          await client.action({
            kind: "create-environment",
            siteId: options.site ?? "",
            mode: "clone",
            body,
          }),
        );
      }),

    envsPush: (options, globals) =>
      runHostingCommand(dependencies, globals, async ({ client, io }) => {
        const body = await environmentPushPayload(options, io);
        return renderAction(
          await client.action({
            kind: "push-environment",
            siteId: options.site ?? "",
            body,
          }),
        );
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `--no-*` options as commander parses them: a negated boolean stores the
 * *positive* name and defaults to `true`.
 */
interface EnvsPushCommandOptions extends Omit<
  EnvsPushOptions,
  "noDb" | "noFiles" | "noSearchReplace"
> {
  readonly db: boolean;
  readonly files: boolean;
  readonly searchReplace: boolean;
}

/** The WordPress-install options `sites create` and `envs create` share. */
function addWordPressInstallOptions(command: Command): Command {
  command.option("--site-title <title>", "WordPress site title");
  command.option("--admin-email <email>", "WordPress administrator email");
  command.option("--admin-user <user>", "WordPress administrator user name");
  addSecretSourceOptions(command, "admin-password", "the admin password");
  return command.option(
    "--wp-language <locale>",
    "WordPress locale",
    DEFAULT_WP_LANGUAGE,
  );
}

export function registerSitesCommands(
  parent: Command,
  handlers: SitesHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  registerSites(parent, handlers, optionsFor);
  registerEnvs(parent, handlers, optionsFor);
}

function registerSites(
  parent: Command,
  handlers: SitesHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const sites = parent.command("sites").description("site operations");

  sites
    .command("list")
    .description("list sites")
    .option("--include-envs", "include each site's environments", false)
    .action(async (options: SitesListOptions, command: Command) => {
      await handlers.sitesList(options, optionsFor([command]));
    });

  sites
    .command("get")
    .description("get a site")
    .argument("<site_id>", "provider site id")
    .action(async (siteId: string, _options: unknown, command: Command) => {
      await handlers.sitesGet(siteId, optionsFor([command]));
    });

  // `sites delete` is intentionally absent; see the module comment and
  // `disableSiteDeleteCapability`. Do not add it here.

  const create = sites.command("create").description("create a WordPress site");
  addFromJsonOption(create);
  create.option("--display-name <name>", "site display name");
  create.option("--site-name <name>", "InstaWP site name");
  create.option("--template-slug <slug>", "InstaWP template slug");
  create.option("--reserved", "create a reserved InstaWP site", false);
  create.option("--shared", "use a shared InstaWP template", false);
  create.option("--email <email>", "InstaWP guest email for shared templates");
  create.option("--region <region>", "provider region");
  addWordPressInstallOptions(create);
  create.option("--is-multisite", "install as a multisite network", false);
  create.option(
    "--is-subdomain-multisite",
    "use subdomains for the multisite network",
    false,
  );
  create.option("--woocommerce", "install WooCommerce", false);
  create.option("--wordpressseo", "install Yoast SEO", false);
  create.action(async (options: SiteCreateOptions, command: Command) => {
    await handlers.sitesCreate(options, optionsFor([command]));
  });

  const createPlain = sites
    .command("create-plain")
    .description("create a plain site");
  addFromJsonOption(createPlain);
  createPlain.option("--display-name <name>", "site display name");
  createPlain.option("--region <region>", "provider region");
  createPlain.action(
    async (options: SiteCreatePlainOptions, command: Command) => {
      await handlers.sitesCreatePlain(options, optionsFor([command]));
    },
  );

  const clone = sites.command("clone").description("clone a site");
  addFromJsonOption(clone);
  clone.option("--display-name <name>", "site display name");
  clone.option("--source-env <id>", "environment to clone from");
  clone.action(async (options: SiteCloneOptions, command: Command) => {
    await handlers.sitesClone(options, optionsFor([command]));
  });

  const reset = sites
    .command("reset")
    .description("reset a site")
    .argument("<site_id>", "provider site id");
  addFromJsonOption(reset);
  addSecretSourceOptions(reset, "admin-password", "the admin password");
  reset.action(
    async (siteId: string, options: SiteResetOptions, command: Command) => {
      await handlers.sitesReset(siteId, options, optionsFor([command]));
    },
  );
}

function registerEnvs(
  parent: Command,
  handlers: SitesHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const envs = parent.command("envs").description("environment operations");

  envs
    .command("list")
    .description("list environments")
    .option("--site <id>", "provider site id")
    .action(async (options: EnvsListOptions, command: Command) => {
      await handlers.envsList(options, optionsFor([command]));
    });

  envs
    .command("get")
    .description("get an environment")
    .argument("<env_id>", "provider environment id")
    .option("--site <id>", "provider site id")
    .action(
      async (envId: string, options: EnvsGetOptions, command: Command) => {
        await handlers.envsGet(envId, options, optionsFor([command]));
      },
    );

  const create = envs
    .command("create")
    .description("create a WordPress environment")
    .option("--site <id>", "provider site id");
  addFromJsonOption(create);
  create.option("--display-name <name>", "environment display name");
  addWordPressInstallOptions(create);
  create.option("--is-premium", "create a premium environment", false);
  create.option("--is-multisite", "install as a multisite network", false);
  create.option(
    "--is-subdomain-multisite",
    "use subdomains for the multisite network",
    false,
  );
  create.option("--woocommerce", "install WooCommerce", false);
  create.option(
    "--wordpress-plugin-edd",
    "install Easy Digital Downloads",
    false,
  );
  create.option("--wordpressseo", "install Yoast SEO", false);
  create.action(async (options: EnvsCreateOptions, command: Command) => {
    await handlers.envsCreate(options, optionsFor([command]));
  });

  const createPlain = envs
    .command("create-plain")
    .description("create a plain environment")
    .option("--site <id>", "provider site id");
  addFromJsonOption(createPlain);
  createPlain.option("--display-name <name>", "environment display name");
  createPlain.option("--is-premium", "create a premium environment", false);
  createPlain.action(
    async (options: EnvsCreatePlainOptions, command: Command) => {
      await handlers.envsCreatePlain(options, optionsFor([command]));
    },
  );

  const clone = envs
    .command("clone")
    .description("clone an environment")
    .option("--site <id>", "provider site id");
  addFromJsonOption(clone);
  clone.option("--display-name <name>", "environment display name");
  clone.option("--source-env <id>", "environment to clone from");
  clone.option("--is-premium", "create a premium environment", false);
  clone.action(async (options: EnvsCloneOptions, command: Command) => {
    await handlers.envsClone(options, optionsFor([command]));
  });

  const push = envs
    .command("push")
    .description("push an environment onto another")
    .option("--site <id>", "provider site id");
  addFromJsonOption(push);
  push.option("--source-env <id>", "environment to push from");
  push.option("--target-env <id>", "environment to push onto");
  push.option("--no-db", "do not push the database");
  push.option("--no-files", "do not push files");
  push.option("--no-search-replace", "do not run search and replace");
  push.option(
    "--file <path>",
    "push only this path; repeatable",
    collect,
    [] as readonly string[],
  );
  push.action(async (options: EnvsPushCommandOptions, command: Command) => {
    const { db, files, searchReplace, ...rest } = options;
    await handlers.envsPush(
      {
        ...rest,
        noDb: !db,
        noFiles: !files,
        noSearchReplace: !searchReplace,
      },
      optionsFor([command]),
    );
  });

  envs
    .command("delete")
    .description("delete an environment")
    .argument("<env_id>", "provider environment id")
    .action(async (envId: string, _options: unknown, command: Command) => {
      await handlers.envsDelete(envId, optionsFor([command]));
    });
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `hosting novamira setup` service, ported from
 * `setupNovamiraSiteProfile` / `installNovamiraForSetup` /
 * `ensureNovamiraSetupPHPVersion` / `enableNovamiraAIAbilitiesForSetup` in
 * `internal/cli/hosting_novamira.go`.
 *
 * **What Go did, and what HQ deletes.** Go's sequence was: check PHP, install
 * and activate the plugin over provider WP-CLI, write the two
 * `novamira_ai_abilities_*` options, then `wp user application-password
 * create`, then store a `site_profiles` entry holding that password. The last
 * two steps are gone permanently under the boundary rule — HQ never holds a
 * WordPress site token, creates no WordPress user, and stores no site profile —
 * and with them the `--username`, `--app-name`, `--site-profile` and
 * `--replace-profile` flags and the `rest_url` / `username` / `credential` /
 * `site_profile` / `config_path` output fields.
 *
 * **What HQ adds.** Go reported success on a site where `novamira auth login`
 * would immediately fail `server_unsupported`. That is the defect this phase
 * fixes: the run now ends with one unauthenticated read of the site's public
 * discovery document, evaluated against HQ's own copy of the site CLI's
 * matrix, and emits the handoff only when the site provably is ready.
 *
 * **The signature has no commander in it.** No `Renderer`, no `CommandIo`, no
 * `Command`. Phase 6's dashboard calls `provisionNovamira` directly, so
 * `src/provisioning/` must never import `src/cli/`; the CLI handler is a thin
 * adapter over this function. Progress is an optional `(level, message)`
 * callback that the CLI wires to `renderer.note` and the dashboard wires to a
 * job log, and the environment is an injected record rather than
 * `process.env`.
 *
 * **The fatal asymmetry is deliberate.** The PHP gate is fatal and runs first,
 * before anything is installed, because it prevents a doomed mutation. The
 * compatibility preflight is fatal and runs last, after the site has been
 * mutated, because a site that is not ready means the command did not do its
 * job — and `ok: true` with a warning attached is still a success envelope a
 * wrapper script would proceed past. `CliError.details` carries the whole
 * install record on that failure, so nothing about what landed is lost. The one
 * escape hatch is `--no-compat-check`, which is honest: `status: "skipped"`,
 * `ready: null`, plus a warning.
 */

import { CliError, asCliError } from "../errors.js";
import {
  wpCliResultsObservable,
  type ProviderClient,
} from "../hosting/client.js";
import { waitForOperationStatus } from "../hosting/operations.js";
import { shellJoin, wpCliCommandPayload } from "../hosting/shell.js";
import type { InvocationWarning } from "../output/render.js";
import {
  checkSiteCompatibility,
  metadataUrl,
  type CompatibilityOptions,
  type ServerCompatibility,
} from "./compatibility.js";
import { connectHandoff, type Handoff } from "./handoff.js";
import type { HttpFetch } from "./http.js";
import {
  NOVAMIRA_LATEST_RELEASE_API,
  NOVAMIRA_LATEST_SOURCE_ALIAS,
  activatePlugin,
  inferPluginSlug,
  installPreflightApplies,
  installedPluginIsActive,
  pluginInstallCommand,
  preflightWpCli,
  resolvePluginSource,
  validateRemotePluginSource,
  type ActivationPlan,
} from "./plugin.js";
import { PHP_VERSION_COMMAND, ensureNovamiraSetupPhp } from "./phpcompat.js";
import {
  normalizeSiteUrl,
  type InsecureHttpEnvironment,
  type NormalizedSite,
} from "./site-url.js";
import { contextualize, runWpCliForOutput, type PollBudget } from "./wp-cli.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The polling defaults, duplicated from `src/cli/flags.ts`'s
 * `DEFAULT_POLL_INTERVAL_SECONDS` / `DEFAULT_POLL_TIMEOUT_SECONDS` rather than
 * imported: those constants belong to the CLI's option grammar, which this
 * layer may not depend on. The two must stay in step.
 */
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 300;

/** Read at the end of Phase B; the front-end URL an agent connects to. */
const HOME_URL_COMMAND = "wp option get home";

/** Go's two AI-Abilities writes. The second is built through `shellJoin`. */
const AI_ABILITIES_ENABLE_COMMAND =
  "wp option update novamira_ai_abilities_enabled 1";
const AI_ABILITIES_DOMAIN_OPTION = "novamira_ai_abilities_domain";

/* -------------------------------------------------------------------------- */
/* Request, dependencies, result                                              */
/* -------------------------------------------------------------------------- */

export type ProgressLevel = "info" | "ok";
export type ProgressReporter = (level: ProgressLevel, message: string) => void;

export interface NovamiraSetupRequest {
  readonly envId: string;
  /** Overrides `wp option get home`. */
  readonly url?: string;
  /** Defaults to `NOVAMIRA_LATEST_SOURCE_ALIAS`. */
  readonly source?: string;
  readonly pluginVersion?: string;
  readonly force?: boolean;
  /** Defaults to true. */
  readonly activate?: boolean;
  readonly activateNetwork?: boolean;
  readonly ignoreRequirements?: boolean;
  /** DB-backed WP-CLI preflight. Defaults to true. */
  readonly preflight?: boolean;
  /** Defaults to true. */
  readonly validateSource?: boolean;
  /** Defaults to true. */
  readonly wait?: boolean;
  /** Defaults to true. */
  readonly aiAbilities?: boolean;
  /** Defaults to true. */
  readonly compatCheck?: boolean;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface NovamiraSetupDependencies {
  readonly client: ProviderClient;
  /** The hosting profile name, for the result only. */
  readonly hostingProfile: string;
  /** Injected, never `process.env`. */
  readonly environment: InsecureHttpEnvironment;
  /** The one outbound-HTTP seam. Production passes `globalHttpFetch`. */
  readonly fetch: HttpFetch;
  readonly latestReleaseApi?: string;
  readonly metadataTimeoutMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Optional progress channel: the CLI's `renderer.note`, Phase 6's job log. */
  readonly report?: ProgressReporter;
}

export type CompatibilityStatus = "supported" | "skipped";

export interface CompatibilityReport {
  readonly status: CompatibilityStatus;
  readonly metadataUrl: string | null;
  readonly pluginVersion: string | null;
  readonly restApiVersion: number | null;
  readonly wordpressVersion: string | null;
  readonly minimumWordpressVersion: string | null;
  readonly features: Readonly<Record<string, boolean>> | null;
}

export interface NovamiraSetupResult {
  readonly hostingProfile: string;
  readonly envId: string;
  readonly siteUrl: string;
  readonly plugin: {
    readonly slug: string;
    readonly source: string;
    readonly version: string | null;
    readonly activated: boolean;
    readonly networkActivated: boolean;
  };
  readonly aiAbilities: {
    readonly enabled: boolean;
    readonly domain: string | null;
  };
  readonly compatibility: CompatibilityReport;
  /**
   * `true` when verified ready, `null` when the check was skipped. Never
   * `false`: a site that is not ready throws, and keeping the union at
   * `true | null` makes that invariant a type rather than a comment.
   */
  readonly ready: true | null;
  readonly handoff: Handoff;
  /** Non-fatal notices for the envelope's `meta.warnings`. */
  readonly warnings: readonly InvocationWarning[];
}

const SKIPPED_COMPATIBILITY: CompatibilityReport = {
  status: "skipped",
  metadataUrl: null,
  pluginVersion: null,
  restApiVersion: null,
  wordpressVersion: null,
  minimumWordpressVersion: null,
  features: null,
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `--env` gate. `src/cli/inputs.ts`'s `requireOption` says "unless
 * --from-json is used", which is false here: setup has no `--from-json`, so it
 * would send an operator looking for a flag that does not exist.
 */
function requireEnvId(value: string): string {
  if (value === "")
    throw new CliError("usage_error", "--env is required.", {
      details: { flag: "--env" },
    });
  return value;
}

/**
 * Re-raise `error` with the install record merged into its details, preserving
 * its code, message and retryability. A failed compatibility preflight still
 * has to tell the operator exactly what landed on the site.
 */
function withInstallRecord(
  error: unknown,
  record: Readonly<Record<string, unknown>>,
): CliError {
  const cause = asCliError(error);
  return new CliError(cause.code, cause.message, {
    retryable: cause.retryable,
    cause: error,
    ...(cause.remoteCode === undefined ? {} : { remoteCode: cause.remoteCode }),
    details: { ...record, ...cause.details },
  });
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export async function provisionNovamira(
  dependencies: NovamiraSetupDependencies,
  request: NovamiraSetupRequest,
): Promise<NovamiraSetupResult> {
  const { client, hostingProfile, environment } = dependencies;
  const http = dependencies.fetch;
  const latestReleaseApi =
    dependencies.latestReleaseApi ?? NOVAMIRA_LATEST_RELEASE_API;
  const report: ProgressReporter = dependencies.report ?? (() => undefined);
  const budget: PollBudget = {
    intervalSeconds: request.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
    timeoutSeconds: request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
  const warnings: InvocationWarning[] = [];

  /* -- Phase A: local and non-provider validation --------------------------- */
  // Nothing below may issue a provider request until A4 has passed.

  const envId = requireEnvId(request.envId);

  // Go refused a provider whose WP-CLI results it could not observe because it
  // needed to capture an Application Password out of them. That reason is
  // deleted, but HQ still reads back the PHP version, the plugin's activation
  // status and the site URL, so the gate itself stays.
  if (!wpCliResultsObservable(client)) {
    throw new CliError(
      "provider_unsupported",
      "hosting novamira setup requires provider WP-CLI output so it can read the PHP version, confirm the plugin is active, and discover the site URL.",
      { details: { provider: client.provider } },
    );
  }

  const requestedUrl = request.url ?? "";
  let site: NormalizedSite | undefined =
    requestedUrl === ""
      ? undefined
      : normalizeSiteUrl(requestedUrl, environment, "--url");

  // Go resolved `--source` inside `installNovamiraForSetup`, i.e. after the PHP
  // round trip. HQ resolves it here: it is an outbound non-provider request,
  // and a `--source` typo must be reported before HQ starts round-tripping the
  // provider. This adds no provider command, so Go's "exactly one command is
  // issued when the PHP check fails" property still holds.
  report("info", "Resolving the Novamira plugin source.");
  const source = request.source ?? NOVAMIRA_LATEST_SOURCE_ALIAS;
  const resolvedSource = await resolvePluginSource(
    source,
    http,
    latestReleaseApi,
  );
  if (request.validateSource ?? true)
    await validateRemotePluginSource(resolvedSource, http);
  report("ok", "Plugin source resolved.");

  const slug = inferPluginSlug(resolvedSource);
  const wantsActivate = request.activate ?? true;
  const wantsNetwork = request.activateNetwork ?? false;
  const activation: ActivationPlan | undefined =
    (wantsActivate || wantsNetwork) && slug !== ""
      ? { slug, network: wantsNetwork }
      : undefined;
  // The fallback for a source that names no slug — a CI build such as
  // `novamira-pr123.zip`, which neither the asset pattern nor the release URL
  // identifies. There is then no plugin to pass to `wp plugin status` or
  // `wp plugin activate`, so the only way to activate at all is on the install
  // line, exactly as Go's `wpPluginInstallPreparedPayload` did whenever the
  // inferred slug was empty. Deferring is still preferred wherever it is
  // possible; silently installing an inactive plugin is not an option, because
  // Phase C would then 404 three times and fail the run.
  const inlineActivate = activation === undefined && wantsActivate;
  const inlineNetwork = activation === undefined && wantsNetwork;

  /* -- Phase B: the provider sequence --------------------------------------- */

  // B1. The PHP gate, always before the install: it exists to prevent a doomed
  // mutation, so a failure here must leave the site untouched.
  report("info", "Checking PHP version.");
  let phpOutput: string;
  try {
    phpOutput = await runWpCliForOutput(
      client,
      envId,
      PHP_VERSION_COMMAND,
      budget,
    );
  } catch (error) {
    throw contextualize(
      error,
      "Failed to check the PHP version before plugin install",
    );
  }
  const phpVersion = ensureNovamiraSetupPhp(phpOutput);
  report("ok", `PHP ${phpVersion} is supported.`);

  // B2. The DB-backed WP-CLI preflight, including its DB_HOST hint.
  const installLine = pluginInstallCommand(resolvedSource, {
    ...(request.pluginVersion === undefined
      ? {}
      : { pluginVersion: request.pluginVersion }),
    force: request.force ?? false,
    // No `--activate` / `--activate-network` on the install line whenever an
    // `ActivationPlan` exists: WP-CLI observability was asserted in Phase A and
    // `wait` defaults true, so activation is deferred to B4/B5 where a failure
    // is observable. The flags reappear only in the no-slug fallback above.
    activate: inlineActivate,
    activateNetwork: inlineNetwork,
    ignoreRequirements: request.ignoreRequirements ?? false,
  });
  const installBody = wpCliCommandPayload(installLine);

  if ((request.preflight ?? true) && installPreflightApplies(installBody)) {
    report("info", "Running WP-CLI preflight.");
    await preflightWpCli(client, envId, budget);
    report("ok", "WP-CLI preflight passed.");
  }

  // B3. The install itself. Go's asymmetry is preserved exactly: the async
  // branch never inspects `result.status`, the sync branch never waits.
  report("info", "Installing the Novamira plugin.");
  const installResult = await client.action({
    kind: "run-wp-cli",
    envId,
    body: installBody,
  });
  if (installResult.operationId !== undefined) {
    if (!(request.wait ?? true)) {
      throw new CliError(
        "usage_error",
        "hosting novamira setup requires --wait when the provider returns an async plugin install operation.",
        { details: { flag: "--wait" } },
      );
    }
    const status = await waitForOperationStatus(
      client,
      installResult.operationId,
      budget,
    );
    if (status.failed) {
      throw new CliError(
        "provider_error",
        `Plugin install operation ${status.operationId} failed: ${status.message ?? "provider reported failure"}`,
        {
          details: {
            provider: status.provider,
            operationId: status.operationId,
            status: status.status,
          },
        },
      );
    }
  } else if (installResult.status >= 400) {
    throw new CliError(
      "provider_error",
      `Plugin install failed: provider returned status ${String(installResult.status)}: ${installResult.message ?? "request failed"}`,
      {
        details: {
          provider: installResult.provider,
          status: installResult.status,
        },
      },
    );
  }
  report("ok", "Novamira plugin installed.");

  // B4/B5. Activation, as its own observable WP-CLI call. `installedPluginIsActive`
  // and `activatePlugin` are called separately rather than through
  // `activateInstalledPlugin` so "was already active" can be reported
  // differently without issuing a second `wp plugin status`.
  if (activation !== undefined) {
    report("info", "Activating the Novamira plugin.");
    if (await installedPluginIsActive(client, envId, activation, budget)) {
      report("ok", "Novamira plugin was already active.");
    } else {
      await activatePlugin(client, envId, activation, budget);
      report("ok", "Novamira plugin activated.");
    }
  }

  // B6. `home`, not `siteurl`: `home` is the public front-end URL an agent
  // connects to and the URL the plugin serves its discovery document under.
  // They differ on a "WordPress in its own directory" install, and using
  // `siteurl` would make every check in Phase C fail spuriously.
  if (site === undefined) {
    report("info", "Discovering the WordPress site URL.");
    let homeOutput: string;
    try {
      homeOutput = await runWpCliForOutput(
        client,
        envId,
        HOME_URL_COMMAND,
        budget,
      );
    } catch (error) {
      throw contextualize(error, "Failed to discover the WordPress site URL");
    }
    site = normalizeSiteUrl(homeOutput, environment, HOME_URL_COMMAND);
    report("ok", "Site URL resolved.");
  }

  // B7/B8. The AI-Abilities options. B8's host goes through `shellJoin`: a
  // hostile hostname refused by `shellQuote` is the only thing standing between
  // untrusted site metadata and a provider's shell.
  const aiAbilities = request.aiAbilities ?? true;
  if (aiAbilities) {
    report("info", "Enabling Novamira AI Abilities.");
    const domainCommand = shellJoin([
      "wp",
      "option",
      "update",
      AI_ABILITIES_DOMAIN_OPTION,
      site.host,
    ]);
    try {
      await runWpCliForOutput(
        client,
        envId,
        AI_ABILITIES_ENABLE_COMMAND,
        budget,
      );
    } catch (error) {
      throw contextualize(error, "Failed to enable Novamira AI Abilities");
    }
    try {
      await runWpCliForOutput(client, envId, domainCommand, budget);
    } catch (error) {
      throw contextualize(
        error,
        "Failed to lock Novamira AI Abilities to the site domain",
      );
    }
    report("ok", "Novamira AI Abilities enabled.");
  }

  /* -- Phase C: the compatibility preflight --------------------------------- */

  let compatibility = SKIPPED_COMPATIBILITY;
  let ready: true | null = null;

  if (request.compatCheck ?? true) {
    report("info", "Checking site compatibility.");
    const compatibilityOptions: CompatibilityOptions = {
      fetch: http,
      ...(dependencies.metadataTimeoutMs === undefined
        ? {}
        : { timeoutMs: dependencies.metadataTimeoutMs }),
      ...(dependencies.sleep === undefined
        ? {}
        : { sleep: dependencies.sleep }),
    };
    let block: ServerCompatibility;
    try {
      block = await checkSiteCompatibility(site, compatibilityOptions);
    } catch (error) {
      throw withInstallRecord(error, {
        hostingProfile,
        env: envId,
        siteUrl: site.siteUrl,
        metadataUrl: metadataUrl(site.siteUrl),
        pluginSlug: slug,
        pluginSource: resolvedSource,
        aiAbilities,
      });
    }
    compatibility = {
      status: "supported",
      metadataUrl: metadataUrl(site.siteUrl),
      pluginVersion: block.plugin_version,
      restApiVersion: block.rest_api_version,
      wordpressVersion: block.wordpress_version,
      minimumWordpressVersion: block.minimum_wordpress_version,
      features: block.features,
    };
    ready = true;
    report(
      "ok",
      `Novamira ${block.plugin_version} satisfies the site CLI compatibility matrix.`,
    );
  } else {
    warnings.push({
      code: "compatibility_not_checked",
      message:
        "Site compatibility was not checked (--no-compat-check); novamira auth login may fail.",
    });
  }

  if (site.insecure) {
    warnings.push({
      code: "insecure_http",
      message:
        "This site was checked over plain HTTP. novamira auth login will refuse this URL unless it is run with NOVAMIRA_ALLOW_INSECURE_HTTP=1.",
    });
  }

  /* -- Phase D: the handoff -------------------------------------------------- */
  // HQ writes no credential, stores no profile, and creates no WordPress user.

  return {
    hostingProfile,
    envId,
    siteUrl: site.siteUrl,
    plugin: {
      slug,
      source: resolvedSource,
      version: compatibility.pluginVersion,
      activated: activation !== undefined || inlineActivate || inlineNetwork,
      networkActivated: activation?.network ?? inlineNetwork,
    },
    aiAbilities: {
      enabled: aiAbilities,
      domain: aiAbilities ? site.host : null,
    },
    compatibility,
    ready,
    handoff: connectHandoff(site.siteUrl),
    warnings,
  };
}

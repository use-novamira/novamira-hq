// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HQ's own copy of the site CLI's v1 compatibility matrix, and the single
 * unauthenticated read that evaluates it.
 *
 * The Go program had nothing like this. `hosting novamira setup` finished by
 * writing a site profile and reporting success, and an operator on WordPress
 * 6.8 — or on a Novamira build older than 1.11.1 — discovered the problem only
 * when `novamira auth login` failed with `server_unsupported`. HQ closes that
 * gap by checking the same matrix, from the same public document, before it
 * claims the site is ready.
 *
 * **This module must never import `@novamira/cli`.** The site CLI is an
 * optional integration, never a dependency (AGENTS.md), so this is a
 * deliberate, reviewable copy of two of its files:
 *
 * - `novamira-cli/src/auth/metadata.ts` — the matrix and the document checks.
 * - `novamira-cli/src/semver.ts` — the SemVer comparison, including the rule
 *   that a prerelease sorts below the matching final release.
 *
 * Diff those two files against this one when the site CLI's matrix moves.
 *
 * **The request.** Exactly one `GET {siteUrl}/.well-known/oauth-protected-resource`
 * — the RFC 9728 *append* form, under the site's own path. Never the insert
 * form: the plugin marks the append form `required` and the insert form
 * `optional` (`novamira/includes/oauth/endpoints/discovery.php`,
 * `discovery_probes()`) precisely because on a subdirectory install the insert
 * form lands on a domain root this WordPress does not own. The request carries
 * `Accept` and `User-Agent` and NOTHING else: no `Authorization`, no `Cookie`,
 * ever. Nothing here is authenticated and nothing here may become so — that is
 * the boundary rule, and it is why reading this document is permitted at all.
 *
 * Redirects are manual and never followed. Following one would issue a second
 * site request, potentially outside the sole boundary exception.
 *
 * **Deliberate narrowing of `metadata.resource`.** HQ checks only that the
 * advertised `resource` is a same-origin URL. It does not compare it against
 * `{siteUrl}/wp-json/mcp/novamira-oauth` or the plain-permalink
 * `index.php?rest_route=` form the way the site CLI's `restUrlFromResource`
 * does, because HQ cannot know the site's permalink style or its
 * `rest_url_prefix` filter, and a false "not ready" on a working site is
 * strictly worse than a missed exotic case.
 *
 * **Tolerance rule.** A required field that is missing, wrongly typed or of a
 * disallowed value rejects the document; any *additional* member — top level,
 * inside `novamira`, inside `features`, or as an extra array element — is
 * ignored. The plugin is free to add fields in 1.12 and HQ must not break.
 *
 * **No cache.** The site CLI's five-minute TTL is right for a long-lived
 * client. HQ reads once per invocation, immediately after mutating the site,
 * and a stale answer is exactly the wrong answer.
 */

import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import { redactText } from "../output/redact.js";
import { compareSemver, parseSemver } from "../semver.js";
import { VERSION } from "../version.js";
import {
  discardBody,
  readBoundedText,
  type HttpFetch,
  type HttpResponse,
} from "./http.js";
import {
  normalizeSiteUrl,
  type InsecureHttpEnvironment,
  type NormalizedSite,
} from "./site-url.js";

/* -------------------------------------------------------------------------- */
/* The matrix                                                                 */
/* -------------------------------------------------------------------------- */

export const MINIMUM_WORDPRESS_VERSION = "6.9";
export const MINIMUM_NOVAMIRA_VERSION = "1.11.1";
export const REQUIRED_REST_API_VERSION = 1;
export const REQUIRED_FEATURES = [
  "abilities_bearer_auth",
  "agent_context",
  "rest_skills",
  "generalized_execution_shim",
] as const;

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
/** 256 KiB. The real document is under 1 KiB; a themed 404 page is not. */
export const METADATA_MAX_BYTES = 262_144;
export const DEFAULT_METADATA_TIMEOUT_MS = 10_000;

/** The stable machine handle for each check, reported in `details.check`. */
export const COMPATIBILITY_CHECKS = [
  "metadata.reachable",
  "metadata.document",
  "metadata.resource",
  "metadata.authorization_server",
  "metadata.bearer_methods",
  "metadata.scopes",
  "compat.block",
  "compat.wordpress",
  "compat.wordpress_consistency",
  "compat.plugin",
  "compat.rest_contract",
  "compat.features",
] as const;

export type CompatibilityCheck = (typeof COMPATIBILITY_CHECKS)[number];

/** The plugin's `novamira` block, as published. Wire names preserved. */
export interface ServerCompatibility {
  readonly plugin_version: string;
  readonly rest_api_version: number;
  readonly wordpress_version: string;
  readonly minimum_wordpress_version: string;
  readonly features: Readonly<Record<string, boolean>>;
}

/**
 * What a diagnostic names when it reports a failed check. Optional on the
 * standalone validators so they keep the signatures the spec froze; the fetch
 * path always supplies it, so the normative messages always carry the real URL.
 */
export interface CompatibilityContext {
  readonly siteUrl: string;
  readonly metadataUrl: string;
}

const ANONYMOUS_CONTEXT: CompatibilityContext = {
  siteUrl: "this site",
  metadataUrl: "the compatibility metadata",
};

function unsupported(
  check: CompatibilityCheck,
  message: string,
  context: CompatibilityContext,
  observed: Readonly<Record<string, unknown>> = {},
): CliError {
  return new CliError("server_unsupported", message, {
    details: {
      check,
      siteUrl: context.siteUrl,
      metadataUrl: context.metadataUrl,
      ...observed,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Version comparison                                                         */
/* -------------------------------------------------------------------------- */

/**
 * SemVer moved down to the leaf `src/semver.ts` in batch 7-2.
 *
 * It used to live here, because this was the first module in HQ that needed the
 * rule that a prerelease sorts below the matching final release. `src/update/`
 * then needed the same comparison, and `src/update/` importing
 * `src/provisioning/` would be a layering smell — the update checker has
 * nothing to do with provisioning a WordPress site. The code is unchanged; only
 * its address moved, and it is re-exported here so every existing caller,
 * including `test/provisioning-contract.test.mjs`, keeps importing it from this
 * module. Diff `src/semver.ts` against `novamira-cli/src/semver.ts` when the
 * site CLI's matrix moves.
 */
export {
  compareSemver,
  isSemver,
  parseSemver,
  InvalidSemverError,
  type Semver,
} from "../semver.js";

/** WordPress versions are dotted-numeric, not SemVer: `6.9`, `6.10.2`. */
export function parseDotted(value: string): readonly number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return undefined;
  return value.split(".").map(Number);
}

export function compareDotted(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Document validation                                                        */
/* -------------------------------------------------------------------------- */

/** `{siteUrl}/.well-known/oauth-protected-resource` (the append form). */
export function metadataUrl(siteUrl: string): string {
  return `${siteUrl}${PROTECTED_RESOURCE_PATH}`;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value as readonly unknown[];
  if (entries.some((entry) => typeof entry !== "string")) return undefined;
  return entries as readonly string[];
}

/**
 * Shape-check the `novamira` block: check 7 (`compat.block`). Every required
 * field must be present and correctly typed; additional members are ignored.
 */
export function readCompatibilityBlock(
  value: unknown,
  context: CompatibilityContext = ANONYMOUS_CONTEXT,
): ServerCompatibility {
  const block = asRecord(value);
  if (block === undefined) {
    throw unsupported(
      "compat.block",
      `The document at ${context.metadataUrl} has no "novamira" compatibility block. That block has shipped since Novamira ${MINIMUM_NOVAMIRA_VERSION}, so this site is running an older build, or another plugin is serving that URL. Reinstall with --source novamira-latest --force.`,
      context,
    );
  }

  const invalid = (field: string): CliError =>
    unsupported(
      "compat.block",
      `The Novamira compatibility block at ${context.metadataUrl} is incomplete or invalid (${field} is missing or the wrong type). novamira auth login will reject this site.`,
      context,
      { field },
    );

  const pluginVersion = block.plugin_version;
  if (typeof pluginVersion !== "string") throw invalid("plugin_version");
  const restApiVersion = block.rest_api_version;
  if (
    typeof restApiVersion !== "number" ||
    !Number.isSafeInteger(restApiVersion)
  )
    throw invalid("rest_api_version");
  const wordpressVersion = block.wordpress_version;
  if (typeof wordpressVersion !== "string") throw invalid("wordpress_version");
  const minimumWordpressVersion = block.minimum_wordpress_version;
  if (typeof minimumWordpressVersion !== "string")
    throw invalid("minimum_wordpress_version");
  const features = asRecord(block.features);
  if (features === undefined) throw invalid("features");
  if (Object.values(features).some((flag) => typeof flag !== "boolean"))
    throw invalid("features");

  return {
    plugin_version: pluginVersion,
    rest_api_version: restApiVersion,
    wordpress_version: wordpressVersion,
    minimum_wordpress_version: minimumWordpressVersion,
    features: features as Readonly<Record<string, boolean>>,
  };
}

/** Checks 8–12, in order. The first failure is the one reported. */
export function assertCompatible(
  compatibility: ServerCompatibility,
  context: CompatibilityContext = ANONYMOUS_CONTEXT,
): void {
  assertWordPress(compatibility, context);
  assertPlugin(compatibility, context);
  assertRestContract(compatibility, context);
  assertFeatures(compatibility, context);
}

function assertWordPress(
  compatibility: ServerCompatibility,
  context: CompatibilityContext,
): void {
  const observed = {
    pluginVersion: compatibility.plugin_version,
    wordpressVersion: compatibility.wordpress_version,
    minimumWordpressVersion: compatibility.minimum_wordpress_version,
  };
  const wordpress = parseDotted(compatibility.wordpress_version);
  if (wordpress === undefined) {
    throw unsupported(
      "compat.wordpress",
      `This site reports the WordPress version "${compatibility.wordpress_version}", which is not a version number Novamira HQ can compare. novamira auth login will reject this site.`,
      context,
      observed,
    );
  }
  const minimum = parseDotted(MINIMUM_WORDPRESS_VERSION);
  if (minimum !== undefined && compareDotted(wordpress, minimum) < 0) {
    throw unsupported(
      "compat.wordpress",
      `Novamira ${compatibility.plugin_version} is installed and active, but this site runs WordPress ${compatibility.wordpress_version}. Novamira needs WordPress ${MINIMUM_WORDPRESS_VERSION} or newer, so novamira auth login will fail until WordPress is updated. Update WordPress on this environment, then rerun this command.`,
      context,
      observed,
    );
  }
  const declared = parseDotted(compatibility.minimum_wordpress_version);
  if (declared === undefined || compareDotted(declared, wordpress) > 0) {
    throw unsupported(
      "compat.wordpress_consistency",
      `This site reports WordPress ${compatibility.wordpress_version} but says Novamira needs at least WordPress ${compatibility.minimum_wordpress_version}. The compatibility metadata contradicts itself; the plugin files are probably a partial or interrupted install. Reinstall with --source novamira-latest --force.`,
      context,
      observed,
    );
  }
}

function assertPlugin(
  compatibility: ServerCompatibility,
  context: CompatibilityContext,
): void {
  const observed = { pluginVersion: compatibility.plugin_version };
  const version = parseSemver(compatibility.plugin_version);
  if (version === undefined) {
    throw unsupported(
      "compat.plugin",
      `The Novamira plugin on this site reports the version "${compatibility.plugin_version}", which is not a semantic version. novamira auth login cannot compare it and will reject the site.`,
      context,
      observed,
    );
  }
  const minimum = parseSemver(MINIMUM_NOVAMIRA_VERSION);
  if (minimum === undefined || compareSemver(version, minimum) >= 0) return;
  const prereleaseOfMinimum =
    version.prerelease !== undefined &&
    version.major === minimum.major &&
    version.minor === minimum.minor &&
    version.patch === minimum.patch;
  throw unsupported(
    "compat.plugin",
    prereleaseOfMinimum
      ? `The Novamira plugin on this site reports version ${compatibility.plugin_version}, a prerelease of ${MINIMUM_NOVAMIRA_VERSION}. The site CLI treats a prerelease as older than the matching final release, so novamira auth login will refuse it. Install the released ${MINIMUM_NOVAMIRA_VERSION} or newer with --source novamira-latest --force.`
      : `The Novamira plugin on this site reports version ${compatibility.plugin_version}, but novamira auth login requires ${MINIMUM_NOVAMIRA_VERSION} or newer. Reinstall with --source novamira-latest --force, then rerun this command.`,
    context,
    observed,
  );
}

function assertRestContract(
  compatibility: ServerCompatibility,
  context: CompatibilityContext,
): void {
  if (compatibility.rest_api_version === REQUIRED_REST_API_VERSION) return;
  throw unsupported(
    "compat.rest_contract",
    `The Novamira plugin on this site serves REST contract ${String(compatibility.rest_api_version)}, but the 1.x site CLI speaks contract ${String(REQUIRED_REST_API_VERSION)} only. Install a Novamira 1.x plugin build.`,
    context,
    { restApiVersion: compatibility.rest_api_version },
  );
}

function assertFeatures(
  compatibility: ServerCompatibility,
  context: CompatibilityContext,
): void {
  for (const feature of REQUIRED_FEATURES) {
    // Absent and `false` behave identically, on purpose: the plugin turns a
    // feature on only once its implementation ships.
    if (compatibility.features[feature] === true) continue;
    throw unsupported(
      "compat.features",
      `The Novamira plugin on this site does not enable the required server feature "${feature}". Novamira turns a feature on only once its implementation ships, so this is an in-progress or partial build. Reinstall with --source novamira-latest --force.`,
      context,
      { feature },
    );
  }
}

/**
 * Checks 3–7 on the whole document, then the block. Check 2 (the body is a JSON
 * object at all) is repeated here so the function is safe to call standalone.
 */
export function validateProtectedResourceMetadata(
  document: unknown,
  site: NormalizedSite,
): ServerCompatibility {
  const context: CompatibilityContext = {
    siteUrl: site.siteUrl,
    metadataUrl: metadataUrl(site.siteUrl),
  };

  const object = asRecord(document);
  if (object === undefined) {
    throw unsupported(
      "metadata.document",
      `The compatibility metadata at ${context.metadataUrl} is not a JSON object. novamira auth login will reject this site.`,
      context,
    );
  }

  assertResource(object.resource, site, context);
  assertAuthorizationServer(object.authorization_servers, site, context);
  assertBearerMethods(object.bearer_methods_supported, context);
  assertScopes(object.scopes_supported, context);
  return readCompatibilityBlock(object.novamira, context);
}

function assertResource(
  value: unknown,
  site: NormalizedSite,
  context: CompatibilityContext,
): void {
  const safeValue = typeof value === "string" ? redactText(value) : undefined;
  const reject = (): never => {
    throw unsupported(
      "metadata.resource",
      `The site advertises the OAuth resource ${safeValue ?? "(not a string)"}, which does not belong to ${site.siteUrl}. Novamira HQ used the WordPress "home" URL; if that is not the address visitors use, rerun with --url <the correct URL>.`,
      context,
      safeValue === undefined ? {} : { resource: safeValue },
    );
  };
  if (typeof value !== "string") return reject();
  let resource: URL;
  try {
    resource = new URL(value);
  } catch {
    return reject();
  }
  if (resource.username !== "" || resource.password !== "") return reject();
  if (resource.protocol !== "https:" && resource.protocol !== "http:")
    return reject();
  if (resource.origin !== site.origin) return reject();
}

function assertAuthorizationServer(
  value: unknown,
  site: NormalizedSite,
  context: CompatibilityContext,
): void {
  const reject = (): never => {
    throw unsupported(
      "metadata.authorization_server",
      `The site advertises an OAuth authorization server that is not ${site.siteUrl}. novamira auth login only authorizes a site against itself.`,
      context,
    );
  };
  const servers = stringArray(value);
  if (servers?.length !== 1) return reject();
  const issuer = servers[0];
  if (issuer === undefined) return reject();
  // The issuer is normalized under the same rules as the site itself, so a
  // loopback or opted-in plain-HTTP site can still advertise its own origin.
  const environment: InsecureHttpEnvironment = site.insecure
    ? { NOVAMIRA_HQ_ALLOW_INSECURE_HTTP: "1" }
    : {};
  let normalized: string;
  try {
    normalized = normalizeSiteUrl(issuer, environment, "--url").siteUrl;
  } catch {
    return reject();
  }
  if (normalized !== site.siteUrl) return reject();
}

function assertBearerMethods(
  value: unknown,
  context: CompatibilityContext,
): void {
  const methods = stringArray(value);
  if (methods?.includes("header") === true) return;
  throw unsupported(
    "metadata.bearer_methods",
    "This Novamira build does not advertise bearer-header authentication, which novamira auth login requires. Reinstall with --source novamira-latest --force.",
    context,
  );
}

function assertScopes(value: unknown, context: CompatibilityContext): void {
  const scopes = stringArray(value);
  if (scopes?.includes("mcp") === true) return;
  throw unsupported(
    "metadata.scopes",
    'This Novamira build does not advertise the full-access "mcp" OAuth scope, which novamira auth login always requests. Reinstall with --source novamira-latest --force.',
    context,
  );
}

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

export interface CompatibilityOptions {
  readonly fetch: HttpFetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function reachability(
  message: string,
  context: CompatibilityContext,
  observed?: Readonly<Record<string, unknown>>,
): CliError {
  return unsupported("metadata.reachable", message, context, observed);
}

function requestTimeout(context: CompatibilityContext): CliError {
  return new CliError(
    "timeout",
    `Timed out reading the compatibility metadata at ${context.metadataUrl}.`,
    {
      retryable: true,
      details: {
        check: "metadata.reachable",
        siteUrl: context.siteUrl,
        metadataUrl: context.metadataUrl,
      },
    },
  );
}

/**
 * The failure a transport fault produces, wherever in the read it
 * happened. `fetch` resolves as soon as the response headers arrive, so a
 * stalled body, a mid-stream reset, or the attempt deadline expiring while the
 * body is still streaming all fail during the *body read* rather than at the
 * call itself. Both sites classify through here so the whole request has one
 * error taxonomy.
 */
function transportFailure(
  error: unknown,
  context: CompatibilityContext,
): CliError {
  return new CliError(
    "network_error",
    `Failed to read the compatibility metadata at ${context.metadataUrl}.`,
    {
      retryable: true,
      cause: error,
      details: {
        check: "metadata.reachable",
        siteUrl: context.siteUrl,
        metadataUrl: context.metadataUrl,
      },
    },
  );
}

async function fetchMetadata(
  url: string,
  options: CompatibilityOptions,
  context: CompatibilityContext,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  options.signal?.throwIfAborted();
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
  let response: HttpResponse;
  try {
    response = await options.fetch(url, {
      method: "GET",
      // No Authorization, no Cookie. Ever. See the module comment.
      headers: {
        Accept: "application/json",
        "User-Agent": `novamira-hq/${VERSION}`,
      },
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    throw timeoutSignal.aborted
      ? requestTimeout(context)
      : transportFailure(error, context);
  }

  if (response.status >= 300 && response.status < 400) {
    await discardBody(response);
    throw reachability(
      `Novamira is installed and activated, but ${context.metadataUrl} redirected instead of serving the compatibility metadata. Novamira HQ cannot follow site redirects because setup permits exactly one request to the well-known URL. Rerun with --url <the URL WordPress actually serves>.`,
      context,
      { status: response.status, reason: "redirect" },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    await discardBody(response);
    throw statusFailure(response.status, context);
  }

  let text: string | undefined;
  try {
    text = await readBoundedText(response, METADATA_MAX_BYTES);
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason;
    throw timeoutSignal.aborted
      ? requestTimeout(context)
      : transportFailure(error, context);
  }
  if (text === undefined) {
    throw reachability(
      `The response from ${context.metadataUrl} exceeded ${String(METADATA_MAX_BYTES)} bytes, so it is not the compatibility metadata. Another plugin or an edge rule is intercepting /.well-known/ requests.`,
      context,
      { status: response.status },
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unsupported(
      "metadata.document",
      `${context.metadataUrl} returned a page instead of JSON. Another plugin, a security rule, or the host's edge is intercepting /.well-known/ requests before WordPress sees them.`,
      context,
      { status: response.status },
    );
  }
}

function statusFailure(
  status: number,
  context: CompatibilityContext,
): CliError {
  if (status === 404) {
    return reachability(
      `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP 404. The plugin serves that URL from the "init" hook, so a 404 usually means the plugin is not active, a cache or CDN is still serving a pre-install response, or ${context.siteUrl} is not the URL WordPress serves. Rerun with --url <the site's real URL>, or check the plugin with hosting wp-cli run --env <env> --command "wp plugin status novamira".`,
      context,
      { status },
    );
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new CliError(
      "network_error",
      `${context.metadataUrl} returned HTTP ${String(status)}. novamira auth login will fail until that URL serves the compatibility metadata.`,
      {
        retryable: true,
        details: {
          check: "metadata.reachable",
          siteUrl: context.siteUrl,
          metadataUrl: context.metadataUrl,
          status,
        },
      },
    );
  }
  if (status === 401 || status === 403) {
    return reachability(
      `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP ${String(status)}. This site appears to be password-protected. Novamira's discovery document must be publicly readable; novamira auth login cannot authorize this site until the protection is lifted or /.well-known/ is excepted.`,
      context,
      { status },
    );
  }
  return reachability(
    `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP ${String(status)} instead of the compatibility metadata. novamira auth login will fail until that URL serves the document.`,
    context,
    { status },
  );
}

/**
 * Fetch, validate, assert. The one site-directed request v1 permits, and the
 * only place HQ ever talks to a configured WordPress site.
 */
export async function checkSiteCompatibility(
  site: NormalizedSite,
  options: CompatibilityOptions,
): Promise<ServerCompatibility> {
  const url = metadataUrl(site.siteUrl);
  const context: CompatibilityContext = {
    siteUrl: site.siteUrl,
    metadataUrl: url,
  };
  const document = await fetchMetadata(url, options, context);
  const compatibility = validateProtectedResourceMetadata(document, site);
  assertCompatible(compatibility, context);
  return compatibility;
}

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
 * Redirects are manual, capped at three hops inside one attempt deadline, and
 * every hop must land on the original `URL.origin` (a scheme change counts as
 * cross-origin). That matches `src/hosting/http-client.ts` and the site CLI's
 * own `discovery` redirect policy: a redirect the CLI refuses must not be one
 * HQ silently follows, or HQ would report ready on a site the CLI rejects.
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

import { Buffer } from "node:buffer";

import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import { VERSION } from "../version.js";
import type { HttpFetch, HttpResponse } from "./http.js";
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
export const METADATA_MAX_REDIRECTS = 3;
export const METADATA_ATTEMPTS = 3;
export const METADATA_RETRY_DELAYS_MS = [1_000, 3_000] as const;
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
/* Version comparison — HQ's own copies, error-free by construction           */
/* -------------------------------------------------------------------------- */

const SEMVER_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
    `(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?` +
    `(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
const NUMERIC = /^\d+$/;

/**
 * Components stay as digit strings, exactly as the site CLI keeps them, so a
 * release number beyond `Number.MAX_SAFE_INTEGER` keeps full precision.
 */
export interface Semver {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease?: string;
}

/**
 * The site CLI's `isSemver` + capture, as a parse. It returns `undefined`
 * instead of throwing `InvalidSemverError`, so every caller here decides which
 * check id an unparseable version belongs to.
 */
export function parseSemver(value: string): Semver | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined)
    return undefined;
  return {
    major,
    minor,
    patch,
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

/** Compare two unsigned decimal strings without converting them to numbers. */
function compareNumeric(left: string, right: string): number {
  const leftDigits = left.replace(/^0+(?=\d)/, "");
  const rightDigits = right.replace(/^0+(?=\d)/, "");
  if (leftDigits.length !== rightDigits.length)
    return leftDigits.length < rightDigits.length ? -1 : 1;
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -1 : 1;
}

function comparePrerelease(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === right) return 0;
  const leftParts = left?.split(".") ?? [];
  const rightParts = right?.split(".") ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = NUMERIC.test(leftPart);
    const rightNumeric = NUMERIC.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    // SemVer orders alphanumeric identifiers by ASCII, not by locale.
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer precedence. A prerelease sorts BELOW the matching final release, which
 * is the whole reason this is not a string or numeric comparison: `1.11.1-rc.1`
 * passes a naive check and then fails `novamira auth login`.
 */
export function compareSemver(left: Semver, right: Semver): number {
  const major = compareNumeric(left.major, right.major);
  if (major !== 0) return major;
  const minor = compareNumeric(left.minor, right.minor);
  if (minor !== 0) return minor;
  const patch = compareNumeric(left.patch, right.patch);
  if (patch !== 0) return patch;
  if (left.prerelease === undefined && right.prerelease !== undefined) return 1;
  if (left.prerelease !== undefined && right.prerelease === undefined)
    return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

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
      `This site reports the WordPress version "${compatibility.wordpress_version}", which is not a version number HQ can compare. novamira auth login will reject this site.`,
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
  const reject = (): never => {
    throw unsupported(
      "metadata.resource",
      `The site advertises the OAuth resource ${typeof value === "string" ? value : "(not a string)"}, which does not belong to ${site.siteUrl}. HQ used the WordPress "home" URL; if that is not the address visitors use, rerun with --url <the correct URL>.`,
      context,
      typeof value === "string" ? { resource: value } : {},
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
  /** Injectable for deterministic tests; defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * One attempt's outcome. A `retry` failure carries the error the caller should
 * raise if every attempt fails, so the retry loop never has to re-derive it.
 */
type MetadataAttempt =
  | { readonly kind: "document"; readonly document: unknown }
  | { readonly kind: "retry"; readonly error: CliError }
  | { readonly kind: "fatal"; readonly error: CliError };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function realSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function reachability(
  message: string,
  context: CompatibilityContext,
  observed?: Readonly<Record<string, unknown>>,
): CliError {
  return unsupported("metadata.reachable", message, context, observed);
}

/**
 * Abandon a response body nobody is going to read, so a real `fetch` does not
 * hold the connection open. A test double with no `body` is a no-op.
 */
async function discardBody(response: HttpResponse): Promise<void> {
  const stream = response.body;
  if (stream === undefined || stream === null) return;
  await stream.cancel().catch(() => undefined);
}

/**
 * Read at most `limit` bytes. `undefined` means the body exceeded the ceiling;
 * the stream is abandoned rather than buffered when the seam exposes one, which
 * a real `Response` always does.
 *
 * Every abandon path cancels the body. Leaving one undrained would keep an
 * undici keep-alive socket ref'd, and `src/index.ts` sets `process.exitCode`
 * rather than calling `process.exit`, so the CLI would print its envelope and
 * then idle until the keep-alive timeout.
 */
async function readBoundedText(
  response: HttpResponse,
  limit: number,
): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await discardBody(response);
    return undefined;
  }

  const stream = response.body;
  if (stream === undefined || stream === null) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > limit ? undefined : text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** The timeout error a spent attempt deadline produces. */
function attemptTimeout(context: CompatibilityContext): CliError {
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
 * The retryable failure a transport fault produces, wherever in the read it
 * happened. `fetch` resolves as soon as the response headers arrive, so a
 * stalled body, a mid-stream reset, or the attempt deadline expiring while the
 * body is still streaming all fail during the *body read* rather than at the
 * call itself. Both sites classify through here so the retry band covers the
 * whole request rather than only its first half.
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

async function attemptMetadata(
  url: string,
  options: CompatibilityOptions,
  context: CompatibilityContext,
): Promise<MetadataAttempt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const origin = new URL(url).origin;
  let current = url;

  for (let hops = 0; ; hops += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return { kind: "retry", error: attemptTimeout(context) };

    // One deadline across every hop. A fresh timeout per hop would let a
    // redirect chain run for four times the configured budget.
    const timeoutSignal = AbortSignal.timeout(remaining);
    let response: HttpResponse;
    try {
      response = await options.fetch(current, {
        method: "GET",
        // No Authorization, no Cookie. Ever. See the module comment.
        headers: {
          Accept: "application/json",
          "User-Agent": `novamira-hq/${VERSION}`,
        },
        redirect: "manual",
        signal: timeoutSignal,
      });
    } catch (error) {
      // An abort is the deadline expiring, which the taxonomy calls `timeout`;
      // anything else is a transport failure. Both are retried.
      return {
        kind: "retry",
        error: timeoutSignal.aborted
          ? attemptTimeout(context)
          : transportFailure(error, context),
      };
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      const location = response.headers.get("location");
      let target: URL | undefined;
      if (location !== null) {
        try {
          target = new URL(location, current);
        } catch {
          target = undefined;
        }
      }
      // Three distinct faults get three distinct diagnostics, discriminated in
      // `details.reason`. Telling an operator whose site canonicalises
      // `/.well-known/x` → `/index.php/.well-known/x` → … in four same-origin
      // hops that they have a "cross-origin redirect" is factually wrong and
      // points at a fix — rerun with --url — that cannot work.
      const observed = {
        status: response.status,
        redirects: hops,
        ...(location === null ? {} : { location }),
      };
      if (target === undefined) {
        return {
          kind: "fatal",
          error: reachability(
            `Novamira is installed and activated, but ${context.metadataUrl} answered HTTP ${String(response.status)} without a usable Location header, so the compatibility metadata was never served. novamira auth login will fail until that URL serves the document.`,
            context,
            { ...observed, reason: "unusable_location" },
          ),
        };
      }
      if (target.origin !== origin) {
        return {
          kind: "fatal",
          error: reachability(
            `Novamira is installed and activated, but ${context.metadataUrl} redirected to a different origin. novamira auth login refuses cross-origin discovery redirects. Rerun with --url <the site's canonical URL>.`,
            context,
            { ...observed, reason: "cross_origin" },
          ),
        };
      }
      if (hops >= METADATA_MAX_REDIRECTS) {
        return {
          kind: "fatal",
          error: reachability(
            `Novamira is installed and activated, but ${context.metadataUrl} redirected more than ${String(METADATA_MAX_REDIRECTS)} times without serving the compatibility metadata. Rerun with --url <the URL WordPress actually serves>.`,
            context,
            { ...observed, reason: "hop_limit" },
          ),
        };
      }
      current = target.toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      await discardBody(response);
      return statusFailure(response.status, context);
    }

    // The body read is inside the same classification as the fetch itself: on
    // this Node, `fetch` resolves at the headers, so a body that stalls past the
    // deadline or a connection reset mid-stream rejects HERE. Left unguarded it
    // escapes `checkSiteCompatibility` as a raw `DOMException`/`TypeError`,
    // which `asCliError` folds into `internal_error` (exit 1) with no
    // `details.check` and no retry — for the single most likely transient
    // failure of this request.
    let text: string | undefined;
    try {
      text = await readBoundedText(response, METADATA_MAX_BYTES);
    } catch (error) {
      return {
        kind: "retry",
        error: timeoutSignal.aborted
          ? attemptTimeout(context)
          : transportFailure(error, context),
      };
    }
    if (text === undefined) {
      return {
        kind: "fatal",
        error: reachability(
          `The response from ${context.metadataUrl} exceeded ${String(METADATA_MAX_BYTES)} bytes, so it is not the compatibility metadata. Another plugin or an edge rule is intercepting /.well-known/ requests.`,
          context,
          { status: response.status },
        ),
      };
    }

    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      return {
        kind: "fatal",
        error: unsupported(
          "metadata.document",
          `${context.metadataUrl} returned a page instead of JSON. Another plugin, a security rule, or the host's edge is intercepting /.well-known/ requests before WordPress sees them.`,
          context,
          { status: response.status },
        ),
      };
    }
    return { kind: "document", document };
  }
}

function statusFailure(
  status: number,
  context: CompatibilityContext,
): MetadataAttempt {
  // 404 is retried because an edge cache may still be serving a pre-activation
  // response for this path; it is still `server_unsupported` if it persists.
  if (status === 404) {
    return {
      kind: "retry",
      error: reachability(
        `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP 404. The plugin serves that URL from the "init" hook, so a 404 usually means the plugin is not active, a cache or CDN is still serving a pre-install response, or ${context.siteUrl} is not the URL WordPress serves. Rerun with --url <the site's real URL>, or check the plugin with hosting wp-cli run --env <env> --command "wp plugin status novamira".`,
        context,
        { status },
      ),
    };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return {
      kind: "retry",
      error: new CliError(
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
      ),
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "fatal",
      error: reachability(
        `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP ${String(status)}. This site appears to be password-protected. Novamira's discovery document must be publicly readable; novamira auth login cannot authorize this site until the protection is lifted or /.well-known/ is excepted.`,
        context,
        { status },
      ),
    };
  }
  return {
    kind: "fatal",
    error: reachability(
      `Novamira is installed and activated, but ${context.metadataUrl} returned HTTP ${String(status)} instead of the compatibility metadata. novamira auth login will fail until that URL serves the document.`,
      context,
      { status },
    ),
  };
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
  const sleep = options.sleep ?? realSleep;

  let last: CliError | undefined;
  for (let attempt = 0; attempt < METADATA_ATTEMPTS; attempt += 1) {
    const outcome = await attemptMetadata(url, options, context);
    if (outcome.kind === "document") {
      const compatibility = validateProtectedResourceMetadata(
        outcome.document,
        site,
      );
      assertCompatible(compatibility, context);
      return compatibility;
    }
    if (outcome.kind === "fatal") throw outcome.error;
    last = outcome.error;
    const delay = METADATA_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }
  throw (
    last ??
    reachability(
      `Failed to read the compatibility metadata at ${url}.`,
      context,
    )
  );
}

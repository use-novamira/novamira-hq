// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The parse side of the signal store: `Record<string, unknown>` in, typed
 * shapes out, and the only place in `src/web/` a signal record is narrowed.
 *
 * **What the Go did.** `readDashboardSignals` unmarshalled the request body
 * straight into `dashboardSignals`, so `encoding/json` did the narrowing: a
 * field of the wrong type failed the whole request, and a field the client
 * omitted silently became the Go zero value. Both behaviours were accidents of
 * the library. The first turns a client that sends `{"providerForm":{"force":
 * "yes"}}` into an opaque 500; the second is *correct* for `force` and *wrong*
 * for `setup.enableAiAbilities`, which is why Go had to reach for a `*bool`
 * there and nowhere else.
 *
 * **What HQ does instead.** One exported parser per signal subtree, each total
 * and each **defaulting rather than throwing**. Datastar's `filterSignals`
 * legitimately omits keys — a `@post` scoped to `/^(token|providerForm)(\.|$)/`
 * sends no `sites` subtree at all — so an absent key is the normal case, not an
 * error, and a wrong-typed one is treated the same way rather than turned into a
 * failure envelope on an SSE route. Each parser's defaults are documented where
 * they are not obvious; the one that is genuinely load-bearing is
 * {@link parseSetup}.
 *
 * **This module reads a secret.** `providerForm.credentialValue` carries a
 * provider API key, in the request body, on its way to the credential store.
 * Nothing here may log it, echo it, stringify a whole parsed record, or place
 * any field's *value* in an error message: every error below names the field and
 * stops. The one field that is **not** trimmed is `credentialValue` (Go did the
 * same, `server.go:614`) — a provider secret may legitimately begin or end with
 * whitespace, and silently corrupting it would produce an authentication failure
 * with no visible cause.
 */

import { CliError } from "../errors.js";
import { asRecord } from "../json.js";
import type { DashboardRequest } from "./request.js";
import { siteProfileRenameSignal } from "./signals.js";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** A subtree of the signal record, or an empty object when it is absent. */
function subtree(
  signals: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  return asRecord(signals[key]) ?? {};
}

/** A string field, verbatim. Anything that is not a string is `""`. */
function rawString(source: Record<string, unknown>, key: string): string {
  const value: unknown = source[key];
  return typeof value === "string" ? value : "";
}

/** A string field, trimmed. The default for every field but the credential. */
function trimmedString(source: Record<string, unknown>, key: string): string {
  return rawString(source, key).trim();
}

/**
 * A boolean field.
 *
 * `fallback` exists for exactly one caller. A checkbox that the client never
 * sends is "unchanged", and for `setup.enableAiAbilities` unchanged means
 * *enabled*; for every other flag it means off.
 */
function boolean(
  source: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value: unknown = source[key];
  return typeof value === "boolean" ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* providerForm                                                               */
/* -------------------------------------------------------------------------- */

export interface ProviderFormInput {
  readonly profile: string;
  readonly provider: string;
  readonly credentialEnv: string;
  /**
   * The provider secret, byte for byte as it was typed. Never trimmed, never
   * logged, never rendered back, never placed in a URL — it goes to
   * `src/credentials/` and stops there.
   */
  readonly credentialValue: string;
  readonly companyId: string;
  readonly apiBaseUrl: string;
  readonly force: boolean;
}

export function parseProviderForm(
  signals: Readonly<Record<string, unknown>>,
): ProviderFormInput {
  const form = subtree(signals, "providerForm");
  return {
    profile: trimmedString(form, "profile"),
    provider: trimmedString(form, "provider"),
    credentialEnv: trimmedString(form, "credentialEnv"),
    credentialValue: rawString(form, "credentialValue"),
    companyId: trimmedString(form, "companyId"),
    apiBaseUrl: trimmedString(form, "apiBaseUrl"),
    force: boolean(form, "force"),
  };
}

/* -------------------------------------------------------------------------- */
/* pushForm                                                                 */
/* -------------------------------------------------------------------------- */

/** The eleven persisted `SavedPush` fields; `open` is UI state and is not one. */
export interface PushFormInput {
  readonly name: string;
  readonly hostingProfile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly sourceEnvId: string;
  readonly sourceEnvName: string;
  readonly targetEnvId: string;
  readonly targetEnvName: string;
  readonly pushDb: boolean;
  readonly pushFiles: boolean;
  readonly searchReplace: boolean;
}

export function parsePushForm(
  signals: Readonly<Record<string, unknown>>,
): PushFormInput {
  const form = subtree(signals, "pushForm");
  return {
    name: trimmedString(form, "name"),
    hostingProfile: trimmedString(form, "hostingProfile"),
    siteId: trimmedString(form, "siteId"),
    siteLabel: trimmedString(form, "siteLabel"),
    sourceEnvId: trimmedString(form, "sourceEnvId"),
    sourceEnvName: trimmedString(form, "sourceEnvName"),
    targetEnvId: trimmedString(form, "targetEnvId"),
    targetEnvName: trimmedString(form, "targetEnvName"),
    pushDb: boolean(form, "pushDb"),
    pushFiles: boolean(form, "pushFiles"),
    searchReplace: boolean(form, "searchReplace"),
  };
}

/* -------------------------------------------------------------------------- */
/* sites                                                                      */
/* -------------------------------------------------------------------------- */

export interface SiteBrowserInput {
  readonly profile: string;
  readonly includeEnvs: boolean;
  readonly search: string;
}

export function parseSiteBrowser(
  signals: Readonly<Record<string, unknown>>,
): SiteBrowserInput {
  const browser = subtree(signals, "sites");
  return {
    profile: trimmedString(browser, "profile"),
    includeEnvs: boolean(browser, "includeEnvs"),
    search: trimmedString(browser, "search"),
  };
}

/* -------------------------------------------------------------------------- */
/* cliSites                                                                   */
/* -------------------------------------------------------------------------- */

export interface CliSitesInput {
  /** A site URL typed into the panel's "connect another site" box; `""` for none. */
  readonly url: string;
  /** Optional custom profile name; empty lets the site CLI derive one. */
  readonly name: string;
}

/**
 * The site-profile panel's one posted signal.
 *
 * Trimmed, like every field but the provider credential: a pasted URL routinely
 * carries a leading or trailing space, and it is about to be validated by
 * `normalizeSiteUrl` on its way to an argv array. `loading` is not parsed
 * because it is the indicator Datastar writes, never something a client sends
 * HQ an opinion about.
 */
export function parseCliSites(
  signals: Readonly<Record<string, unknown>>,
): CliSitesInput {
  const sites = subtree(signals, "cliSites");
  return {
    url: trimmedString(sites, "url"),
    name: trimmedString(sites, "name"),
  };
}

/** The trimmed new name from one profile row's dynamic rename signal. */
export function parseSiteProfileRename(
  signals: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const path = siteProfileRenameSignal(name);
  const value: unknown = signals[path];
  return typeof value === "string" ? value.trim() : "";
}

/* -------------------------------------------------------------------------- */
/* diagnostics                                                                */
/* -------------------------------------------------------------------------- */

export interface DiagnosticsInput {
  /** The provider profile the capabilities action was fired for; `""` for none. */
  readonly profile: string;
}

/**
 * The one signal the Diagnostics page binds.
 *
 * Go read it by re-unmarshalling the whole `dashboardSignals` struct when the
 * request carried `?datastar=` (`server.go:510-516`); here it is the same
 * defaulting parse every other subtree gets, so a client that sends no
 * `diagnostics` subtree at all lands on `""` — which the handler reports as
 * "select one provider profile first" rather than guessing a profile.
 */
export function parseDiagnostics(
  signals: Readonly<Record<string, unknown>>,
): DiagnosticsInput {
  return { profile: trimmedString(subtree(signals, "diagnostics"), "profile") };
}

/* -------------------------------------------------------------------------- */
/* setup                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Absent means no explicit request to enable abilities on an existing site.
 * New installations are enabled by the provisioning service, not this parser.
 */
export interface SetupInput {
  readonly enableAiAbilities: boolean;
}

export function parseSetup(
  signals: Readonly<Record<string, unknown>>,
): SetupInput {
  return {
    enableAiAbilities: boolean(
      subtree(signals, "setup"),
      "enableAiAbilities",
      false,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* A GET's signals                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 8 KiB. The whole `sites` subtree is four short fields; this is slack for a
 * long search string and a long profile name, not a budget.
 */
export const MAX_QUERY_SIGNAL_BYTES = 8_192;

/**
 * A `@get`'s signals arrive in `?datastar=<json>`, not in the body.
 *
 * The vendored Datastar client serializes `filterSignals` into the request body
 * for a method that has one and into the query string for a `GET`
 * (`src/web/static/datastar.js`: `ot(t) ? Y.body = F : U.set("datastar", F)`),
 * so `/_dashboard/sites` has to read its signals from here. The discipline is
 * `readSignals`' applied to a different transport: a hard size cap first, then
 * `JSON.parse`, then "must be an object" — because a query string is attacker-
 * reachable in exactly the way a same-origin request body is not, and because
 * `URLSearchParams` will happily hand back a megabyte.
 */
export function readQuerySignals(
  request: DashboardRequest,
): Readonly<Record<string, unknown>> {
  const raw = request.query.get("datastar");
  if (raw === null || raw === "") return {};
  if (Buffer.byteLength(raw, "utf8") > MAX_QUERY_SIGNAL_BYTES) {
    throw new CliError(
      "schema_validation_failed",
      `The dashboard request's signal query exceeds the ${String(MAX_QUERY_SIGNAL_BYTES)} byte limit.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      "schema_validation_failed",
      "The dashboard request's signal query is not valid JSON.",
    );
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    throw new CliError(
      "schema_validation_failed",
      "The dashboard request's signal query must be a JSON object of Datastar signals.",
    );
  }
  return record;
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site CLI's *public* v1 surface, as HQ consumes it: the exact argv of the
 * two commands, the child environment, and the validators for the two payloads.
 *
 * **The boundary this file sits on.** `@novamira/cli` is an optional
 * integration — never imported, never a runtime, package or peer dependency.
 * HQ never reads the site CLI's configuration file, its profile store, its
 * credential store, its keychain records, or `NOVAMIRA_HOME`. The integration's
 * only inputs are the stdout of two child processes HQ spawns itself, and its
 * only coupling is to the CLI's published command grammar and JSON output.
 *
 * **Recorded obligation (spec §0).** The upstream `docs/v1-contract.md` freezes
 * the command *names*, the globals, the envelope and the exit-code table, but
 * it does **not** yet freeze the `data` payloads of `sites list` and
 * `auth status`. HQ therefore pins its expectations to the observed behaviour
 * of `@novamira/cli@1.0.3` (`src/config/profiles.ts` for `SiteProfile`,
 * `src/auth/token-lifecycle.ts` for `AuthStatus`), and the fixtures in
 * `test/integration-site-cli-contract.test.mjs` are the executable copy of that
 * expectation. The documentation change that freezes both payloads is raised
 * against `novamira-cli` separately. Until it lands, an upstream `data` change
 * is a breaking change for HQ that the validators below catch as
 * `malformed_output`, degrading the dashboard to connection state
 * `unavailable` — which is the correct behaviour, not an outage.
 *
 * **The required-field set HQ validates, and the tolerance rule.**
 *
 * - `sites list`: `data` is an array; every element is an object carrying
 *   non-empty strings `name`, `siteUrl` and `origin`. One malformed element
 *   rejects the whole response — a partially parsed list would silently report
 *   "not configured" for the site whose entry failed, which is a *wrong* answer
 *   rather than a degraded one.
 * - `auth status`: `credentialState` is one of the five enum members and
 *   `restReachable` is `boolean` or `null`. `site`, `siteUrl`, `expiresAt` and
 *   `restError` are validated when present and never required: requiring a
 *   field HQ does not need would turn a harmless upstream change into an
 *   outage.
 * - Everywhere: an additional member — top level, inside an element, inside
 *   `meta` — is ignored and never rejected.
 *
 * **Why the envelope parse is reliable even for a usage error.** The CLI's
 * `main` computes `json = resolvedOptions.json || argv.includes("--json")`, so
 * `--json` anywhere in argv guarantees a JSON failure body, and its `writeErr`
 * is a no-op so commander's usage text never reaches stderr. An old CLI that
 * does not know `sites list` therefore still answers with a parseable
 * `{ok: false, error: {code: "usage_error"}}`, which `connection.ts` maps to
 * `cli_incompatible` rather than to a guess.
 */

import { asRecord } from "../json.js";
import { isSiteProfileName } from "../site-profiles.js";
import type { SiteOperation } from "./operations.js";

/** Fixed public CLI grammar; operation input travels only on stdin. */
export function siteOperationArgs(operation: SiteOperation): readonly string[] {
  const base = [
    "--json",
    "--quiet",
    "--timeout",
    "30000",
    "--max-output",
    "1048576",
  ];
  if (operation.kind === "list") return [...base, "sites", "list"];
  base.push("--site", operation.site);
  switch (operation.kind) {
    case "doctor":
      return [...base, "doctor"];
    case "discover":
      return [...base, "discover"];
    case "describe":
      return [...base, "describe", operation.ability];
    case "skill":
      return [...base, "skill", "get", operation.slug];
    case "run":
      return [
        ...base,
        ...(operation.approveDestructive ? ["--yes"] : []),
        "run",
        operation.ability,
        "--fresh",
        "--input",
        "-",
      ];
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* argv and the child environment                                             */
/* -------------------------------------------------------------------------- */

/**
 * `novamira --json --quiet --timeout <ms> sites list`.
 *
 * Globals first — the form the CLI's own grammar specifies and its tests use.
 * No `--site`: the list is of every configured profile.
 */
export function sitesListArgs(timeoutMs: number): readonly string[] {
  return ["--json", "--quiet", "--timeout", String(timeoutMs), "sites", "list"];
}

/**
 * `novamira --json --quiet --timeout <ms> --site <name> auth status`.
 *
 * `--site` is always passed explicitly, which is what makes an operator's
 * `NOVAMIRA_SITE` unable to redirect HQ's probe.
 */
export function authStatusArgs(
  timeoutMs: number,
  site: string,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "--timeout",
    String(timeoutMs),
    "--site",
    site,
    "auth",
    "status",
  ];
}

/**
 * `novamira --json --quiet --timeout <ms> --site <name> auth logout`.
 *
 * The site CLI removes its own local credential and, when it can, revokes the
 * refresh token with the site's authorization server. Both happen in the child,
 * under the child's credential; HQ passes a profile name and reads the
 * envelope's `ok`. The payload — `remoteRevoked`, an optional warning — is
 * deliberately not read: it is the CLI's account of its own credential store.
 */
export function authLogoutArgs(
  timeoutMs: number,
  site: string,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "--timeout",
    String(timeoutMs),
    "--site",
    site,
    "auth",
    "logout",
  ];
}

/**
 * `novamira --json --quiet --timeout <ms> sites remove <name>`.
 *
 * No `--site`: the name is the command's positional argument, and passing it
 * twice would let the two disagree. No `--yes` either — the site CLI gates only
 * *Ability execution* behind confirmation, and `sites remove` is
 * non-interactive, so there is no prompt for HQ to answer and nothing to
 * approve on the operator's behalf. The confirmation an operator sees is the
 * dashboard's own `confirm()`.
 */
export function sitesRemoveArgs(
  timeoutMs: number,
  name: string,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "--timeout",
    String(timeoutMs),
    "sites",
    "remove",
    name,
  ];
}

/**
 * `novamira --json --quiet --timeout <ms> sites rename <name> <new-name>`.
 *
 * Both names are positional arguments. The caller validates both against the
 * site CLI's profile-name grammar before either can reach this array.
 */
export function sitesRenameArgs(
  timeoutMs: number,
  name: string,
  newName: string,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "--timeout",
    String(timeoutMs),
    "sites",
    "rename",
    name,
    newName,
  ];
}

/**
 * The environment every site-CLI child runs with.
 *
 * `NOVAMIRA_UPDATE_CHECK=0` is required, not cosmetic: after a successful
 * command the CLI performs an anonymous npm-registry dist-tag request at most
 * once per 24 h with a 3 s budget, holding a lock across it. Left on, it adds
 * up to 3 s per dashboard refresh and makes the dashboard cause outbound
 * network traffic the operator never asked for. `--quiet` suppresses it too;
 * both are set.
 *
 * `NO_COLOR=1` keeps ANSI escapes out of a stream HQ parses as JSON.
 *
 * `NOVAMIRA_SITE` is deliberately *not* injected, and `NOVAMIRA_HOME` is passed
 * through untouched — the child must resolve the operator's own home, and HQ
 * neither reads nor interprets that variable.
 */
export function siteCliChildEnv(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...environment, NOVAMIRA_UPDATE_CHECK: "0", NO_COLOR: "1" };
}

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The site CLI's v1 envelope, reduced to what HQ acts on: the payload of a
 * success, the code of a failure, and "this is not an envelope at all".
 */
export type ParsedEnvelope =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string }
  | { readonly ok: "malformed" };

const MALFORMED: ParsedEnvelope = Object.freeze({ ok: "malformed" as const });

/**
 * Parse one line of child stdout as the v1 envelope.
 *
 * The whole (trimmed) string must be exactly one JSON object. Two concatenated
 * objects, a JSON array, a bare value, a log line before the JSON, and the
 * empty string are all `"malformed"` — `JSON.parse` rejects the first three for
 * us, which is precisely why "exactly one object" is stated as a rule rather
 * than implemented as a scanner.
 */
export function parseEnvelope(stdout: string): ParsedEnvelope {
  const trimmed = stdout.trim();
  if (trimmed === "") return MALFORMED;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return MALFORMED;
  }

  const record = asRecord(value);
  if (record === undefined) return MALFORMED;

  const ok: unknown = record.ok;
  if (ok === true) return { ok: true, data: record.data };
  if (ok !== false) return MALFORMED;

  const code: unknown = asRecord(record.error)?.code;
  if (typeof code !== "string" || code === "") return MALFORMED;
  return { ok: false, code };
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/** The three members of the CLI's `SiteProfile` that HQ requires and reads. */
export interface SiteCliProfile {
  readonly name: string;
  readonly siteUrl: string;
  readonly origin: string;
}

export const CREDENTIAL_STATES = [
  "absent",
  "invalid",
  "fresh",
  "near_expiry",
  "expired",
] as const;

export type CredentialState = (typeof CREDENTIAL_STATES)[number];

export interface SiteCliAuthStatus {
  readonly credentialState: CredentialState;
  readonly restReachable: boolean | null;
  readonly site?: string;
  readonly siteUrl?: string;
  readonly expiresAt?: string;
  /**
   * The site CLI's own error code, treated by HQ as an opaque string. It is
   * what separates "reconnect required" from "the site could not be reached".
   */
  readonly restError?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isCredentialState(value: unknown): value is CredentialState {
  return (
    typeof value === "string" &&
    (CREDENTIAL_STATES as readonly string[]).includes(value)
  );
}

/**
 * Validate the `sites list` payload.
 *
 * `undefined` means "not the shape HQ knows", which the caller reports as
 * `malformed_output`. Additional members on an element — `clientId`,
 * `compatibility`, anything added upstream later — are ignored.
 */
export function parseSitesList(
  data: unknown,
): readonly SiteCliProfile[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const profiles: SiteCliProfile[] = [];
  for (const element of data as readonly unknown[]) {
    const record = asRecord(element);
    if (record === undefined) return undefined;
    const name = nonEmptyString(record.name);
    const siteUrl = nonEmptyString(record.siteUrl);
    const origin = nonEmptyString(record.origin);
    // One bad element rejects the whole list; see the header comment.
    if (
      name === undefined ||
      siteUrl === undefined ||
      origin === undefined ||
      // A name is later reused as an argv element (`--site <name>`), so it must
      // satisfy the same grammar the actions enforce. Otherwise a malformed or
      // incompatible listing could smuggle a leading `-`-name into an argv that
      // runs a different command than the one HQ meant.
      !isSiteProfileName(name)
    ) {
      return undefined;
    }
    profiles.push({ name, siteUrl, origin });
  }
  return profiles;
}

/** One optional string member: absent is fine, present-but-not-a-string is not. */
function optionalString(
  record: Record<string, unknown>,
  key: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false } {
  const value: unknown = record[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

/**
 * Validate the `auth status` payload.
 *
 * `credentialState` and `restReachable` are required; the four descriptive
 * members are validated only when present. `undefined` means the caller reports
 * `malformed_output` for that one profile — never for the whole refresh.
 */
export function parseAuthStatus(data: unknown): SiteCliAuthStatus | undefined {
  const record = asRecord(data);
  if (record === undefined) return undefined;

  const credentialState: unknown = record.credentialState;
  if (!isCredentialState(credentialState)) return undefined;

  const restReachable: unknown = record.restReachable;
  if (typeof restReachable !== "boolean" && restReachable !== null) {
    return undefined;
  }

  const site = optionalString(record, "site");
  const siteUrl = optionalString(record, "siteUrl");
  const expiresAt = optionalString(record, "expiresAt");
  const restError = optionalString(record, "restError");
  if (!site.ok || !siteUrl.ok || !expiresAt.ok || !restError.ok) {
    return undefined;
  }

  // `exactOptionalPropertyTypes`: an absent member must be absent, not
  // `undefined`, so each one is spread in only when it was present.
  return {
    credentialState,
    restReachable,
    ...(site.value === undefined ? {} : { site: site.value }),
    ...(siteUrl.value === undefined ? {} : { siteUrl: siteUrl.value }),
    ...(expiresAt.value === undefined ? {} : { expiresAt: expiresAt.value }),
    ...(restError.value === undefined ? {} : { restError: restError.value }),
  };
}

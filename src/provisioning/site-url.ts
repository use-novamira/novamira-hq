// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one site-URL normalizer, ported from Go's `normalizeSiteURL` and
 * `normalizedSiteHost` in `internal/cli/hosting_novamira.go` — and made
 * considerably stricter on the way over.
 *
 * A URL leaves this module in three roles at once: it is the address HQ prints
 * in the `novamira auth login <url>` handoff, the base the compatibility
 * document is fetched from, and (through its bare host) the value written to
 * the site's `novamira_ai_abilities_domain` option. Getting it wrong therefore
 * does not produce a warning; it produces a command the operator pastes that
 * fails, or a domain lock that silently does not match.
 *
 * Go's normalizer accepted a query string, accepted userinfo, and never
 * compared the scheme against the loopback exception — all three of which
 * `novamira auth login` rejects. HQ would then have advertised a URL the site
 * CLI refuses, which is precisely the class of defect this phase exists to fix.
 * So the algorithm keeps Go's one genuine convenience (a bare `example.com` is
 * read as `https://example.com`) and adopts the site CLI's strictness for
 * everything else.
 *
 * Every rejection is `usage_error`, whatever the source. That is not a
 * classification accident: each one is fixed by the operator passing `--url`
 * (or setting the opt-in), which is exactly what the v1 contract means by
 * `usage_error`. No rejection ever echoes the raw value: a rejected URL may
 * carry userinfo, and `details.url` is printed on stdout in `--json` mode.
 *
 * `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP` is HQ's own variable. HQ never reads the
 * site CLI's `NOVAMIRA_ALLOW_INSECURE_HTTP`, and this module never touches
 * `process.env`: the environment record is injected, so a contract test can
 * exercise the opt-in without mutating the process it runs in.
 */

import { CliError } from "../errors.js";

export interface NormalizedSite {
  /** `https://example.com` or `https://example.com/blog`. No trailing slash. */
  readonly siteUrl: string;
  /** `https://example.com`. */
  readonly origin: string;
  /** Bare hostname: port-stripped, IPv6 brackets removed. */
  readonly host: string;
  /** True when plain HTTP was accepted through the opt-in (not loopback). */
  readonly insecure: boolean;
}

/** The one environment variable this module reads, injected rather than read. */
export interface InsecureHttpEnvironment {
  readonly NOVAMIRA_HQ_ALLOW_INSECURE_HTTP?: string | undefined;
}

/** Where the raw value came from; only used for the diagnostic. */
export type SiteUrlSource = "--url" | "wp option get home";

const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

/** `scheme://` followed by anything up to the `@` that ends the userinfo. */
const USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/;

/**
 * The form of a URL a diagnostic may print. `https://admin:hunter2@example.com`
 * is a credential, and this module's own rejection of it would otherwise echo
 * it into `error.message` and into `details.url` — neither of which
 * `src/output/redact.ts` scrubs, because `url` is not a secret-looking key and
 * a bare `user:pass@host` has no query string for the query-parameter rule to
 * catch. So userinfo is replaced before the value ever reaches a `CliError`,
 * and no caller of {@link invalid} is given the raw string to pass.
 */
function safeUrl(value: string): string {
  return value.replace(USERINFO, "$1[REDACTED]@");
}

/** `[::1]` and `[::ffff:127.0.0.1]` arrive bracketed from `URL.hostname`. */
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopback(hostname: string): boolean {
  const host = bareHostname(hostname).toLowerCase();
  return host === "localhost" || host === "::1" || IPV4_LOOPBACK.test(host);
}

/** `url` is the {@link safeUrl} form, never the operator's raw string. */
function invalid(
  message: string,
  url: string,
  source: SiteUrlSource,
): CliError {
  return new CliError("usage_error", message, {
    details: { flag: "--url", source, url },
  });
}

/**
 * Normalize a site URL to the exact form the site CLI accepts, and to the bare
 * host written to `novamira_ai_abilities_domain`.
 */
export function normalizeSiteUrl(
  raw: string,
  environment: InsecureHttpEnvironment,
  source: SiteUrlSource,
): NormalizedSite {
  const trimmed = raw.trim();
  if (trimmed === "")
    throw invalid("The WordPress site URL is empty.", "", source);

  // Go's convenience, kept: `--url example.com` still means HTTPS.
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  // Everything below reports `printable`, never `raw` or `trimmed`: the
  // scheme-prefixed form is what HQ actually tried to parse, and it is the form
  // whose userinfo has been removed.
  const printable = safeUrl(candidate);

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalid(
      `The WordPress site URL ${printable} is not a valid URL.`,
      printable,
      source,
    );
  }

  const allowInsecure = environment.NOVAMIRA_HQ_ALLOW_INSECURE_HTTP === "1";
  let insecure = false;
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:") {
      throw invalid(
        `The WordPress site URL ${printable} must use https.`,
        printable,
        source,
      );
    }
    if (!isLoopback(url.hostname)) {
      if (!allowInsecure) {
        throw invalid(
          `The WordPress site URL ${printable} uses plain HTTP. Use https, or set NOVAMIRA_HQ_ALLOW_INSECURE_HTTP=1 to accept it.`,
          printable,
          source,
        );
      }
      insecure = true;
    }
  }

  if (url.hostname === "")
    throw invalid(
      `The WordPress site URL ${printable} has no host.`,
      printable,
      source,
    );

  // Userinfo in a handoff URL is a credential in an argv the operator pastes,
  // so neither the message nor `details.url` may repeat it back.
  if (url.username !== "" || url.password !== "")
    throw invalid(
      "The WordPress site URL must not contain a username or password.",
      printable,
      source,
    );

  if (url.search !== "" || url.hash !== "")
    throw invalid(
      "The WordPress site URL must not contain a query string or a fragment.",
      printable,
      source,
    );

  const pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const path = pathname === "" ? "/" : pathname;

  return {
    siteUrl: path === "/" ? url.origin : `${url.origin}${path}`,
    origin: url.origin,
    host: bareHostname(url.hostname),
    insecure,
  };
}

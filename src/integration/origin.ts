// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Total origin normalization, the one thing both sides of the connection match
 * on.
 *
 * **What the Go did.** `normalizeHost` (views.go:1128-1141) lower-cased a
 * hostname, dropped the scheme entirely, glued the port onto the host and
 * stripped a leading `www.`. Two of those are wrong for this purpose:
 * `http://x` and `https://x` are different origins to an OAuth authorization
 * server, and so are `example.com` and `www.example.com`. Go's matcher would
 * report a site "connected" through a profile whose credential is scoped to a
 * different origin — a false positive, which is strictly worse than a false
 * "not configured" the operator can fix by clicking Connect.
 *
 * **What HQ does instead.** Both sides go through {@link originOf} and are
 * compared for exact equality: scheme included, non-default port included,
 * default port dropped, host lower-cased and IDNA/Punycode-normalized. All of
 * that is `URL`'s work, not ours — running both sides through the same parser
 * is what makes an IDN hostname and a `:443` suffix agree for free. Never
 * hand-roll host normalization.
 *
 * **Why a bare hostname is accepted.** `HostingEnvironment.primaryDomain` is
 * heterogeneous across the eight providers: a bare hostname on Hostinger,
 * Kinsta and WP Engine, a full URL on Rocket.net, Cloudways and Pressable. A
 * value with no `://` is therefore read as `https://<value>`, which is the same
 * convenience `src/provisioning/site-url.ts` grants `--url`.
 *
 * **Why this is not `normalizeSiteUrl`.** That function throws `CliError` on
 * anything it dislikes and consults `NOVAMIRA_HQ_ALLOW_INSECURE_HTTP`. A
 * matcher must be *total*: an odd `primaryDomain` is "no comparable origin",
 * never an error, and must not change meaning because an opt-in variable is
 * set. This module reads no environment at all and never throws.
 */

/** A URL-ish value that carries userinfo, e.g. `https://user:pw@example.com`. */
const USERINFO = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/;

/**
 * The comparable origin of a hostname or URL, or `undefined` when there is
 * none. Total: never throws, for any input.
 */
export function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  // A provider that reports a bare hostname means the site, and the site is
  // served over HTTPS. A value that already carries a scheme keeps it.
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  if (USERINFO.test(candidate)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }

  // `URL` accepts userinfo silently; a credential in a matcher input is a sign
  // the value is not what we think it is, so it is "no comparable origin".
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  // A fully qualified `example.com.` and `example.com` are the same host. One
  // trailing dot is stripped on both sides before comparing; `hostname` keeps
  // IPv6 brackets, so an address literal survives intact.
  const hostname = parsed.hostname.endsWith(".")
    ? parsed.hostname.slice(0, -1)
    : parsed.hostname;
  if (hostname === "") return undefined;

  // `URL` has already dropped a default port and lower-cased and Punycoded the
  // host, so the origin is just the two parts joined.
  const host = parsed.port === "" ? hostname : `${hostname}:${parsed.port}`;
  return `${parsed.protocol}//${host}`;
}

/**
 * Normalize a list of candidate values, dropping the incomparable ones and any
 * duplicate. Order is preserved so a caller's first candidate stays first.
 */
export function normalizeOrigins(
  values: readonly (string | undefined)[],
): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const origin = originOf(value);
    if (origin !== undefined) seen.add(origin);
  }
  return [...seen];
}

/** Exact origin equality, both sides normalized. No `www.` fuzz, by design. */
export function originsMatch(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const a = originOf(left);
  if (a === undefined) return false;
  return a === originOf(right);
}

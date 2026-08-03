// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

const REDACTED = "[REDACTED]";

// Substrings that mark a property (or query parameter) as carrying a hosting
// provider secret. Matched case-insensitively anywhere in the name, so
// `kinstaApiKey`, `X-Api-Token` and `client_secret` are all covered.
const SECRET_KEY_SOURCE = [
  "authorization",
  "authentication",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "signature",
  "verifier",
  "cookie",
  "session[-_ ]?id",
  "bearer",
  "api[-_ ]?key",
  "apikey",
  "access[-_ ]?key",
  "private[-_ ]?key",
  "ssh[-_ ]?key",
  "app[-_ ]?password",
].join("|");

const SECRET_KEY_PATTERN = new RegExp(`(${SECRET_KEY_SOURCE})`, "i");

// Names that are secret only when they are the whole property name, so that
// `statusCode`, `errorCode` and `publicKey` survive redaction. A bare `code`
// property is NOT redacted here: it is the error taxonomy code across HQ and
// masking it would gut every diagnostic. Authorization codes only ever reach
// diagnostics inside a URL, where `QUERY_SECRET_PATTERN` catches them.
const EXACT_SECRET_KEYS: ReadonlySet<string> = new Set([
  "auth",
  "key",
  "pass",
  "pw",
  "pwd",
]);

/** True when a property or query-parameter name must never be printed. */
export function isSecretKey(name: string): boolean {
  return (
    EXACT_SECRET_KEYS.has(name.trim().toLowerCase()) ||
    SECRET_KEY_PATTERN.test(name)
  );
}

// `Authorization: Bearer <token>` and friends, wherever they appear in text.
// `bearer`/`basic` never occur before an English word, so they redact eagerly;
// `token`/`apikey` do, so they require something credential-length after them
// ("token expired" must stay readable).
const SCHEME_PATTERN = /\b(bearer|basic)\s+([A-Za-z0-9\-._~+/=]{4,})/gi;
const LOOSE_SCHEME_PATTERN =
  /\b(token|apikey|api[-_ ]key)\s+([A-Za-z0-9\-._~+/=]{12,})/gi;

// `?api_key=<secret>` / `&code=<secret>` in URLs embedded in text.
const QUERY_SECRET_PATTERN = new RegExp(
  `([?&][^=&\\s"']*(?:${SECRET_KEY_SOURCE}|code|key|auth)[^=&\\s"']*=)([^&\\s"'\\\\]+)`,
  "gi",
);

/**
 * Redacts secrets from a free-form string: any caller-known secret literal,
 * `Bearer`-style credentials, and secret-valued URL query parameters.
 */
export function redactText(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  const withoutKnown = knownSecrets.reduce(
    (safe, secret) =>
      secret === "" ? safe : safe.replaceAll(secret, REDACTED),
    value,
  );
  return withoutKnown
    .replace(
      SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      LOOSE_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      QUERY_SECRET_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    );
}

/**
 * Deep-copies `value`, replacing secret-named properties with `[REDACTED]` and
 * scrubbing secrets out of every remaining string. Everything written to a
 * diagnostic stream must pass through here first.
 */
export function redact(
  value: unknown,
  knownSecrets: readonly string[] = [],
): unknown {
  return redactValue(value, knownSecrets, new Set<object>());
}

function redactValue(
  value: unknown,
  knownSecrets: readonly string[],
  seen: Set<object>,
): unknown {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value))
      return value.map((item) => redactValue(item, knownSecrets, seen));
    if (value instanceof Error) return redactError(value, knownSecrets, seen);
    return redactEntries(Object.entries(value), knownSecrets, seen);
  } finally {
    seen.delete(value);
  }
}

function redactError(
  error: Error,
  knownSecrets: readonly string[],
  seen: Set<object>,
): Record<string, unknown> {
  const entries: (readonly [string, unknown])[] = [
    ["name", error.name],
    ["message", error.message],
    ...Object.entries(error),
  ];
  if (error.cause !== undefined) entries.push(["cause", error.cause]);
  return redactEntries(entries, knownSecrets, seen);
}

function redactEntries(
  entries: readonly (readonly [string, unknown])[],
  knownSecrets: readonly string[],
  seen: Set<object>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : redactValue(item, knownSecrets, seen),
    ]),
  );
}

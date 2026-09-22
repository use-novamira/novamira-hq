// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

const REDACTED = "[REDACTED]";

// Substrings that mark a property (or query parameter) as carrying a hosting
// provider secret. Matched case-insensitively anywhere in the name, so
// `kinstaApiKey`, `X-Api-Token` and `client_secret` are all covered.
const SECRET_KEY_SOURCE = [
  "authorization",
  "authentication",
  "jwt",
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
  "ssl[-_ ]?key",
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
  "sig",
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

const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s"'<>]+@/gi;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const REGISTERED_SECRETS = new WeakMap<object, readonly string[]>();

/**
 * Redacts secrets from a free-form string: any caller-known secret literal,
 * `Bearer`-style credentials, and secret-valued URL query parameters.
 */
export function redactText(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  const withoutKnown = [...new Set(knownSecrets)]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (safe, secret) =>
        secret === "" ? safe : safe.replaceAll(secret, REDACTED),
      value,
    );
  return withoutKnown
    .replace(
      URL_USERINFO_PATTERN,
      (_match, scheme: string) => `${scheme}${REDACTED}@`,
    )
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
    )
    .replace(URL_PATTERN, redactEncodedQuerySecrets);
}

/** Finds literal secrets carried by secret-named fields or credentialed URLs. */
export function collectSensitiveValues(value: unknown): readonly string[] {
  const secrets = new Set<string>();
  collectSensitiveValue(value, false, secrets, new Set<object>());
  return [...secrets].sort((left, right) => right.length - left.length);
}

/** Associates secret literals with an in-memory result without serializing them. */
export function registerSensitiveValues(
  value: unknown,
  secrets: readonly string[],
): void {
  if (value === null || typeof value !== "object" || secrets.length === 0)
    return;
  const current = REGISTERED_SECRETS.get(value) ?? [];
  REGISTERED_SECRETS.set(value, [...new Set([...current, ...secrets])]);
}

/** Returns secret literals previously associated with an in-memory result. */
export function registeredSensitiveValues(value: unknown): readonly string[] {
  return value !== null && typeof value === "object"
    ? (REGISTERED_SECRETS.get(value) ?? [])
    : [];
}

/** Redacts text using literals associated with an in-memory provider result. */
export function redactAssociatedText(value: string, source: unknown): string {
  return redactText(value, registeredSensitiveValues(source));
}

/**
 * Deep-copies `value`, replacing secret-named properties with `[REDACTED]` and
 * scrubbing secrets out of every remaining string. Everything written to a
 * diagnostic or failure stream must pass through here first.
 */
export function redact(
  value: unknown,
  knownSecrets: readonly string[] = [],
): unknown {
  const secrets = [...knownSecrets, ...registeredSensitiveValues(value)];
  const safe = redactValue(value, secrets, new Set<object>());
  registerSensitiveValues(safe, secrets);
  return safe;
}

function collectSensitiveValue(
  value: unknown,
  sensitive: boolean,
  secrets: Set<string>,
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    if (sensitive && value !== "") secrets.add(value);
    collectUrlSecrets(value, secrets);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        value.length === 2 &&
        typeof value[0] === "string" &&
        isSecretKey(value[0])
      ) {
        collectSensitiveValue(value[1], true, secrets, seen);
        return;
      }
      for (const item of value)
        collectSensitiveValue(item, sensitive, secrets, seen);
      return;
    }
    for (const [key, item] of Object.entries(value))
      collectSensitiveValue(item, sensitive || isSecretKey(key), secrets, seen);
  } finally {
    seen.delete(value);
  }
}

function collectUrlSecrets(value: string, secrets: Set<string>): void {
  for (const match of value.matchAll(URL_PATTERN)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (url.username !== "") secrets.add(url.username);
    if (url.password !== "") secrets.add(url.password);
    for (const [key, item] of url.searchParams)
      if (isSecretKey(key) || /^(?:auth|code|key)$/i.test(key)) {
        if (item !== "") secrets.add(item);
      }
  }
}

function redactEncodedQuerySecrets(value: string): string {
  const queryStart = value.indexOf("?");
  if (queryStart < 0) return value;
  const fragmentStart = value.indexOf("#", queryStart);
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const query = value.slice(queryStart + 1, queryEnd);
  const safeQuery = query
    .split("&")
    .map((parameter) => {
      const equals = parameter.indexOf("=");
      if (equals < 0) return parameter;
      const rawName = parameter.slice(0, equals);
      let name: string;
      try {
        name = decodeURIComponent(rawName.replaceAll("+", " "));
      } catch {
        return parameter;
      }
      return isSecretKey(name) || /^(?:auth|code|key)$/i.test(name)
        ? `${rawName}=${REDACTED}`
        : parameter;
    })
    .join("&");
  return `${value.slice(0, queryStart + 1)}${safeQuery}${value.slice(queryEnd)}`;
}

function redactValue(
  value: unknown,
  knownSecrets: readonly string[],
  seen: Set<object>,
): unknown {
  const localSecrets = [...knownSecrets, ...registeredSensitiveValues(value)];
  if (typeof value === "string") return redactText(value, localSecrets);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value))
      return value.map((item) => redactValue(item, localSecrets, seen));
    if (value instanceof Error) return redactError(value, localSecrets, seen);
    return redactEntries(Object.entries(value), localSecrets, seen);
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

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 6901 lookups and JSON-object narrowing, with no dependency on anything
 * else in the tree.
 *
 * Go kept `jsonPointerLookupString` and `decodeJSONPointerToken` in
 * `internal/cli/helpers.go`, next to the flag parsing, because the only callers
 * were command handlers. HQ started the same way — they lived in
 * `src/cli/inputs.ts`, and `asRecord` was a private copy inside
 * `src/cli/hosting/wp.ts`. Phase 5 needs both from `src/provisioning/`, which
 * must never import `src/cli/` (the web dashboard calls the provisioning
 * service directly, with no commander anywhere in the graph), so they move down
 * here. `src/cli/inputs.ts` re-exports `jsonPointerLookupString` so no existing
 * import or contract test has to change.
 *
 * Nothing in this module throws: a malformed pointer, a wrong-typed node and a
 * missing key are all `undefined`, exactly as Go's `(string, bool)` reported
 * them.
 */

/**
 * A JSON object, or `undefined` for anything else — including arrays and
 * `null`, both of which are `typeof "object"` and neither of which may be
 * indexed by name.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

/** RFC 6901 token decoding. Returns `undefined` for an invalid escape. */
function decodeJsonPointerToken(token: string): string | undefined {
  if (!token.includes("~")) return token;
  // Iterating UTF-16 units is safe here: both escapes are ASCII and every unit
  // is re-emitted in order, so surrogate pairs survive intact.
  let decoded = "";
  for (let index = 0; index < token.length; index++) {
    const character = token.charAt(index);
    if (character !== "~") {
      decoded += character;
      continue;
    }
    index++;
    // `charAt` past the end is "", which is Go's "invalid trailing escape".
    const escaped = token.charAt(index);
    if (escaped === "0") decoded += "~";
    else if (escaped === "1") decoded += "/";
    else return undefined;
  }
  return decoded;
}

/**
 * Go's `jsonPointerLookupString`, which returned `(string, bool)`. TypeScript
 * has a better answer for "a string or nothing", so this returns
 * `string | undefined` and callers use `??` or an explicit check.
 */
export function jsonPointerLookupString(
  value: unknown,
  pointer: string,
): string | undefined {
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = value;
  for (const part of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(part);
    if (token === undefined) return undefined;
    const record = asRecord(current);
    if (record === undefined) return undefined;
    if (!Object.hasOwn(record, token)) return undefined;
    current = record[token];
  }
  return typeof current === "string" ? current : undefined;
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SemVer parsing and precedence, as one leaf module with no imports.
 *
 * **What the Go did.** `internal/update/update.go:522-578` carried
 * `normalizeVersion`, `parseVersion` and `compareVersions`: a three-field
 * `strconv.Atoi` comparison that stripped a leading `v`, ignored prerelease
 * identifiers entirely, and therefore ranked `1.2.0-rc.1` **equal** to `1.2.0`.
 * A prerelease published to a dist-tag would have been reported "up to date".
 * That code is deleted, not ported.
 *
 * **Why this file exists at all.** Phase 5 already wrote a correct comparison —
 * including the rule that a prerelease sorts *below* the matching final release
 * — inside `src/provisioning/compatibility.ts`, because the compatibility
 * preflight needs it. Phase 7-2's `src/update/` needs the same thing, and
 * `src/update/` importing `src/provisioning/` would be a layering smell: the
 * update checker has nothing to do with provisioning a WordPress site. So the
 * comparison moved down here, to a leaf both layers may import, and
 * `compatibility.ts` re-exports it so every existing caller — including
 * `test/provisioning-contract.test.mjs`, which imports `parseSemver` and
 * `compareSemver` from `dist/provisioning/compatibility.js` — keeps resolving
 * unchanged.
 *
 * **Two comparison entry points, deliberately.** {@link compareSemver} takes two
 * already-parsed {@link Semver} records, which is what the compatibility
 * preflight wants: it parses once, decides which check id an unparseable
 * version belongs to, and then compares. {@link compareSemverStrings} takes two
 * strings and throws {@link InvalidSemverError} on either, which is what
 * `src/update/` wants: a registry that advertises a non-SemVer `latest` is a
 * `network_error` raised by the caller, and a parse that silently returned
 * `undefined` would let it become a silent "no update available".
 *
 * **Components stay as digit strings.** `1.0.99999999999999999999` is a legal
 * version and `Number` would round it; every comparison here is length-then-
 * lexicographic over leading-zero-stripped digits, so precision is never lost.
 *
 * **This module is a leaf and must stay one.** It imports nothing — not even
 * `../errors.js`, which is why {@link InvalidSemverError} is a plain `Error`
 * subclass rather than a `CliError`. A caller that needs a taxonomy code wraps
 * it; `src/update/registry.ts` does exactly that.
 */

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

export class InvalidSemverError extends Error {
  constructor(value: string) {
    super(`Version ${value} is not a valid semantic version.`);
    this.name = "InvalidSemverError";
  }
}

/**
 * A narrowing predicate over an unknown value, for JSON that claims to carry a
 * version. The registry's `latest` arrives as `unknown` and must be proved a
 * SemVer string before it is compared, cached, or interpolated into an install
 * specifier — `@novamira/hq@$(rm -rf /)` is not a package the installer should
 * ever be asked to fetch, and this is the check that makes that unreachable.
 */
export function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

/**
 * The site CLI's `isSemver` + capture, as a parse. It returns `undefined`
 * instead of throwing, so every caller decides which error an unparseable
 * version belongs to.
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
export function compareNumeric(left: string, right: string): number {
  const leftDigits = left.replace(/^0+(?=\d)/, "");
  const rightDigits = right.replace(/^0+(?=\d)/, "");
  if (leftDigits.length !== rightDigits.length)
    return leftDigits.length < rightDigits.length ? -1 : 1;
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -1 : 1;
}

export function comparePrerelease(
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

/**
 * {@link compareSemver} over two strings, refusing either that is not a SemVer.
 *
 * The site CLI's `compareSemver` has this signature, and `src/update/` is a
 * mirror of the site CLI's update modules, so keeping the spelling means the
 * two products' update code can be diffed line for line.
 */
export function compareSemverStrings(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  if (parsedLeft === undefined) throw new InvalidSemverError(left);
  const parsedRight = parseSemver(right);
  if (parsedRight === undefined) throw new InvalidSemverError(right);
  return compareSemver(parsedLeft, parsedRight);
}

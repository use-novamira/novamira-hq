// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The catalog of SSE patch targets: which element ids the server may replace
 * over a Datastar stream, and in which mode.
 *
 * **What the Go did.** `server.go` called
 * `datastar.WithSelectorID("main")`/`("toast")`/`("sites-result")` at roughly
 * thirty sites, and `gomponents_conventions_test.go` (rules 0-4) then *regexed
 * the Go source* for `WithSelectorID(` and failed the build on any argument
 * outside a hand-maintained whitelist, on any computed expression, and on a
 * fragment whose rendered markup did not carry a root element with the matching
 * id. The catalog existed, but it existed in a test file, in a regular
 * expression, over source text.
 *
 * **What HQ does instead.** The catalog is a type. {@link SseStream.patchElements}
 * takes a {@link PatchSelectorId}, so an uncatalogued literal is a compile error
 * and a computed selector is only expressible through {@link connCellId}, which
 * hex-encodes the caller's string and is therefore selector-safe for any profile
 * name — including one with a `.`, a `:` or a `/` in it, all of which Go's
 * `"conn-" + profile` would have emitted straight into a CSS selector. The
 * residual runtime properties (a non-empty catalog, ids that are legal selector
 * targets, an outer-mode fragment whose root carries its own id) survive as
 * conventions rules 27-30.
 *
 * **6a ships exactly the three fragments 6a renders.** `provider-flash`,
 * `sites-status`, `sites-result` and `setup-work` arrive with 6b's page views;
 * `diagnostics-output` and `updates-card` wait for Phase 7's `src/doctor/` and
 * `src/update/`. Adding a row here without a renderer breaks conventions rule
 * 28, which is the point: the catalog and the DOM cannot drift apart.
 *
 * `connSignal`/`rowSignal` (Go's `"checking" + alnum(profile)`) are deliberately
 * absent. They belong to the provider table, and they need a dynamic-signal
 * escape hatch on `SignalPath` that 6b must add alongside the cell renderer.
 * Record Go's collision hazard when it does: stripping non-alphanumerics maps
 * the profiles `a-b` and `ab` onto the same signal.
 */

import { CliError } from "../errors.js";

/** The two Datastar element patch modes the dashboard uses. */
export type PatchMode = "outer" | "inner";

export interface PatchFragment {
  readonly selectorId: string;
  readonly mode: PatchMode;
}

/** The three ids 6a's app shell renders, and the only ones it may patch. */
export type StaticPatchSelectorId = "main" | "nav" | "toast";

/**
 * The catalog. Conventions rule 27 asserts it is non-empty and that every
 * `selectorId` matches `/^[a-z][a-z0-9-]*$/`; rule 28 asserts every entry is
 * actually rendered by a 6a view.
 */
export const SSE_PATCH_FRAGMENTS: readonly PatchFragment[] = Object.freeze([
  { selectorId: "main", mode: "outer" },
  { selectorId: "nav", mode: "outer" },
  { selectorId: "toast", mode: "outer" },
] as const satisfies readonly PatchFragment[]);

declare const ConnCellBrand: unique symbol;

/**
 * The id of one provider row's connection cell. Branded so that the only way to
 * produce one is {@link connCellId}, which guarantees the value is a legal CSS
 * selector target whatever the profile was named.
 */
export type ConnCellId = string & { readonly [ConnCellBrand]: "conn-cell" };

export type PatchSelectorId = StaticPatchSelectorId | ConnCellId;

/**
 * `"conn-" + hex(utf8(profile))`.
 *
 * Hex rather than the profile name because a hosting profile name may legally
 * contain `.`, `-` and `_` (`src/config/schema.ts`'s `NAME_PATTERN`), and a `.`
 * in an id turns `#conn-prod.us` into "the element `conn-prod` with class `us`".
 * Hex is injective, so two distinct profiles can never collide, and it is
 * ASCII-only, so a non-ASCII profile name still yields a selector-safe id.
 */
export function connCellId(profile: string): ConnCellId {
  if (profile === "") {
    throw new CliError(
      "internal_error",
      "A connection cell id needs a profile name; the empty string is not one.",
    );
  }
  return `conn-${Buffer.from(profile, "utf8").toString("hex")}` as ConnCellId;
}

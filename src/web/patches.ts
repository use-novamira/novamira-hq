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
 * **A row lands with its renderer, never before it.** 6a shipped the three
 * fragments the app shell renders. 6b-1 added `provider-flash` with
 * `views/providers.ts`; 6b-2 added `sites-status` (inner) and `sites-result`
 * (outer) with `views/sites.ts`; 6b-3 closed the catalog with `setup-work` in
 * **both** modes — Go's did the same, because the page-level handler replaces
 * the element and the stream handler replaces only its body — plus
 * `diagnostics-output`, whose element `views/diagnostics.ts` renders and whose
 * two handlers landed in batch 7-1 with `src/doctor/`. Batch 7-2 added the last
 * row, `updates-card`, together with `src/update/`, the Settings page's card and
 * its two routes — in one diff, because adding a row here without a renderer
 * breaks conventions rule 28, which is the point: the catalog and the DOM cannot
 * drift. **The catalog is now closed**: every id it names is rendered and
 * patched by shipped code, and there is no phase left holding a row back.
 *
 * **`connCellId` is the *provider table's* cell**, and it is easy to confuse
 * with the other thing called "connection". This id names the cell that shows
 * whether a hosting profile's **API credential** works (`ProviderClient.validate`,
 * patched by `/_dashboard/providers/validate`). The sites page's per-environment
 * cell answers a completely different question — whether a **WordPress site** is
 * connected to Novamira, from `src/connection-state.ts`'s four-state union — and
 * has no fragment id at all, because the whole `#sites-result` is replaced.
 *
 * **Per-row signals live in `signals.ts`, not here.** Go's `connSignal`/
 * `rowSignal` built `"checking" + alnum(profile)`, which is not injective: the
 * profiles `a-b` and `ab` collapse onto the same signal, so one row's spinner
 * spun for two rows. `dynamicSignalPath` hex-encodes instead, for the same
 * reason {@link connCellId} does.
 */

import { CliError } from "../errors.js";

/** The two Datastar element patch modes the dashboard uses. */
export type PatchMode = "outer" | "inner";

export interface PatchFragment {
  readonly selectorId: string;
  readonly mode: PatchMode;
}

/** Every fixed element id the dashboard may patch. */
export type StaticPatchSelectorId =
  | "main"
  | "nav"
  | "toast"
  | "provider-flash"
  | "sites-status"
  | "sites-result"
  | "setup-work"
  | "diagnostics-output"
  | "updates-card";

/**
 * The catalog. Conventions rule 27 asserts it is non-empty and that every
 * `selectorId` matches `/^[a-z][a-z0-9-]*$/`; rule 28 asserts every entry is
 * actually rendered by a shipped view.
 */
export const SSE_PATCH_FRAGMENTS: readonly PatchFragment[] = Object.freeze([
  { selectorId: "main", mode: "outer" },
  { selectorId: "nav", mode: "outer" },
  { selectorId: "toast", mode: "outer" },
  { selectorId: "provider-flash", mode: "outer" },
  // `sites-status` is the only **inner** fragment 6b-2 ships, and the mode is
  // load-bearing: `sites-filter.js` observes `#sites-result` for mutations, so
  // an outer patch of the result element is what re-triggers filtering after a
  // load, while the status line — which changes on every spinner — must not.
  { selectorId: "sites-status", mode: "inner" },
  { selectorId: "sites-result", mode: "outer" },
  // The one id that appears twice, because two handlers replace two different
  // things about the same element. `/_dashboard/setup/jobs/<id>` replaces the
  // element **outer**, wrapper included, because the wrapper carries the
  // `data-init` that opens the progress stream; `…/stream` then replaces only
  // the body **inner**, once per second and only when the markup changed,
  // because re-sending the wrapper would restart the stream that sent it. Go's
  // catalog carried both rows for the same reason.
  { selectorId: "setup-work", mode: "outer" },
  { selectorId: "setup-work", mode: "inner" },
  // Rendered by `views/diagnostics.ts` since 6b-1, and patched by
  // `handlers/diagnostics.ts`'s two routes since 7-1. It is the only fragment
  // outside `#toast` that both diagnostics routes touch, and neither of them
  // patches `#main`: repainting would reset the provider `<select>`.
  { selectorId: "diagnostics-output", mode: "outer" },
  // The last row, and the one that closes the catalog. `views/settings.ts`
  // renders the element and `handlers/updates.ts`'s two routes replace it whole
  // — outer, because the card's `data-init` self-check attribute lives on the
  // root and an inner patch would leave the pre-check version of it in place,
  // re-firing the silent check on every repaint.
  { selectorId: "updates-card", mode: "outer" },
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

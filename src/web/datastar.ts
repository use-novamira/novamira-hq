// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Datastar attribute helpers: one function per attribute, and the only way
 * a `data-*` attribute reaches the DOM.
 *
 * **What the Go did.** `views.go` imported
 * `data "maragu.dev/gomponents-datastar"` and used `data.Signals`, `data.Bind`,
 * `data.Class`, `data.Attr`, `data.Text`, `data.Indicator`, `data.Init` and
 * `data.On` — but not always. Nine `strings.Builder` renderers wrote attributes
 * by hand and had to call `renderAttrNode(data.Class(...))` to splice the
 * helper's output back into raw markup (views.go:392, 437, 441, 447), and
 * `bindSignal` (views.go:53) existed only to strip a `$` that a caller might
 * have written. `gomponents_conventions_test.go` then regexed the rendered
 * output for the mistakes the API allowed: a `data-bind` starting with `$`
 * (rule 6), a `data-indicator` starting with `$` (rule 8), a `data-on:submit`
 * without `__prevent` (rule 7), a hyphenated `data-on-click` (rule 9).
 *
 * **What HQ does instead.** Import this module as a namespace —
 * `import * as ds from "./datastar.js"` — so call sites read like the Go's
 * `data.` alias. Every helper returns an `Attr`, which is the only thing the
 * `html` template accepts inside a tag, so a hand-written `data-…` string is not
 * merely a review failure but unrepresentable: a bare string in an attribute
 * position throws.
 *
 * Three of Go's four conventions rules become types rather than tests.
 * `bind` and `indicator` take a `SignalPath`, which is a bare dotted path by
 * construction, so a leading `$` is a compile error (and `assertSignalPath`
 * catches an `as SignalPath` cast at runtime). `DatastarEvent` deliberately
 * omits `"submit"`, so a bare `data-on:submit` cannot be written; `onSubmit`
 * always emits `data-on:submit__prevent`. The colon separator lives here, in one
 * place, so `data-on-click` cannot be typed at all.
 *
 * **Not Datastar, but still one helper per attribute.** `data-checked-at`,
 * `data-nm-state`, `data-sf-status` and `data-sf-count` are read by HQ's own
 * shipped JS (`relative-time.js`, `sites-filter.js`), not by Datastar. 6b added
 * them in the banner-separated section at the bottom of this file rather than
 * letting a view reach for `attr("data-nm-state", …)`, because each one's value
 * set is a contract with a frozen asset: every value is a closed union, never a
 * `string`, so a typo is a compile error instead of a row that silently stops
 * being filterable.
 */

import { CliError } from "../errors.js";
import {
  jsJson,
  objectExpr,
  renderExpr,
  type Expr,
  type JsonValue,
} from "./expr.js";
import { attr, type Attr } from "./html.js";
import { assertSignalPath, type SignalPath } from "./signals.js";

/**
 * The events the dashboard binds. `"submit"` is absent by design: use
 * `onSubmit`, which cannot forget `__prevent`.
 */
export type DatastarEvent = "click" | "change" | "input" | "keydown";

/** gomponents-datastar's `ModifierPrevent` and `ModifierOutside`. */
export type DatastarModifier = "prevent" | "outside";

const EVENTS: readonly DatastarEvent[] = [
  "click",
  "change",
  "input",
  "keydown",
];
const MODIFIERS: readonly DatastarModifier[] = ["prevent", "outside"];

function internalError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CliError {
  return new CliError(
    "internal_error",
    message,
    details === undefined ? {} : { details },
  );
}

/**
 * `data-signals` — the root signal object, or a scoped subtree.
 *
 * The value is JSON hardened exactly as a `jsJson` literal is, then
 * HTML-escaped by `attr`, so `</div><script>` inside a signal value survives
 * `JSON.parse` unchanged and never reaches the HTML tokenizer as markup.
 */
export function signals(value: Readonly<Record<string, JsonValue>>): Attr {
  return expressionAttr("data-signals", jsJson(value));
}

/** `data-bind` — a bare dotted path, never `$path`. */
export function bind(path: SignalPath): Attr {
  assertSignalPath(path);
  return attr("data-bind", path);
}

/** `data-class` — `{className: <expr>}`. */
export function classes(entries: Readonly<Record<string, Expr>>): Attr {
  return expressionAttr("data-class", objectExpr(entries));
}

/** `data-attr` — `{attributeName: <expr>}`. */
export function attrs(entries: Readonly<Record<string, Expr>>): Attr {
  return expressionAttr("data-attr", objectExpr(entries));
}

/** A single ARIA attribute, whose hyphenated name is not an object identifier. */
export function aria(name: "expanded", value: Expr): Attr {
  return expressionAttr(`data-attr:aria-${name}`, value);
}

/** `data-text`. */
export function text(expression: Expr): Attr {
  return expressionAttr("data-text", expression);
}

/** `data-indicator` — a bare dotted path, never `$path`. */
export function indicator(name: SignalPath): Attr {
  assertSignalPath(name);
  return attr("data-indicator", name);
}

/** `data-init`. */
export function init(expression: Expr): Attr {
  return expressionAttr("data-init", expression);
}

/**
 * `data-on:<event>[__prevent][__outside]`.
 *
 * Modifiers are suffixes on the attribute *name*, matching
 * gomponents-datastar's `ModifierPrevent`/`ModifierOutside`, and are emitted in
 * the order given.
 */
export function on(
  event: DatastarEvent,
  expression: Expr,
  ...modifiers: readonly DatastarModifier[]
): Attr {
  if (!EVENTS.includes(event)) {
    throw internalError(
      `"${event}" is not a bindable Datastar event here. Use onSubmit for form submission, which always prevents the default.`,
      { event },
    );
  }
  let name = `data-on:${event}`;
  for (const modifier of modifiers) {
    if (!MODIFIERS.includes(modifier)) {
      throw internalError(`"${modifier}" is not a known Datastar modifier.`, {
        modifier,
      });
    }
    name += `__${modifier}`;
  }
  return expressionAttr(name, expression);
}

/**
 * `data-on:submit__prevent`, always.
 *
 * Go asserted this over rendered output (rule 7,
 * `TestDashboardDatastarSubmitHandlersPreventDefault`) because `data.On` would
 * happily emit a bare `data-on:submit` and a full-page form post would silently
 * replace the dashboard.
 */
export function onSubmit(expression: Expr): Attr {
  return expressionAttr("data-on:submit__prevent", expression);
}

/**
 * Every helper funnels through here, so the escaping story for a `data-*`
 * attribute is one sentence: the expression's source, HTML-escaped and
 * double-quoted by `attr`.
 */
function expressionAttr(name: string, expression: Expr): Attr {
  return attr(name, renderExpr(expression));
}

/* ========================================================================== */
/* NOT DATASTAR — the attributes HQ's own shipped scripts read                */
/* ========================================================================== */

/*
 * Everything below this banner is read by `src/web/static/relative-time.js` and
 * `src/web/static/sites-filter.js`, which are copied verbatim from the Go
 * program and must not be edited (`CLAUDE.md`, `static.ts:6-26`). The markup
 * follows the asset, never the other way round, so each helper's value type is
 * exactly the set of literals the script compares against.
 */

/**
 * `data-checked-at` — unix **milliseconds**.
 *
 * `relative-time.js` does `parseInt(el.dataset.checkedAt)` and skips the element
 * when the result is falsy, then overwrites the element's `textContent`. Two
 * consequences are encoded here and must not be undone: a non-integer or
 * non-finite value is refused outright rather than emitted (a silently skipped
 * stamp is harder to notice than a thrown error), and any *label* text has to
 * live in a different element from the one carrying this attribute.
 */
export function checkedAt(millis: number): Attr {
  if (!Number.isSafeInteger(millis)) {
    throw internalError(
      "data-checked-at takes unix milliseconds as a safe integer; relative-time.js parses it with parseInt and skips anything falsy.",
    );
  }
  return attr("data-checked-at", String(millis));
}

/** Absolute timestamps: elapsed time survives navigation and process restarts. */
export function jobStartedAt(millis: number): Attr {
  return attr("data-job-started-at", String(millis));
}
export function jobFinishedAt(millis: number | null): Attr {
  return attr("data-job-finished-at", millis === null ? "" : String(millis));
}

/**
 * `data-nm-state` — whether a site row already has Novamira installed.
 *
 * `sites-filter.js:28-33` compares the value against the literals `"installed"`
 * and (implicitly) anything-else, and drives the segmented control's two
 * counters from it. Go derived the value from a `site_profiles` lookup
 * (`novamiraRowState`, views.go:1090-1100); HQ derives it from the site CLI's
 * `ConnectionResult` per environment — see 6b-2's `views/sites.ts`.
 */
export type NovamiraRowState = "installed" | "install";

export function novamiraState(state: NovamiraRowState): Attr {
  return attr("data-nm-state", state);
}

/** Factual connection categories; multiple environments may match different filters. */
export function connectionFilter(
  states: readonly ("saved" | "missing" | "attention" | "unknown")[],
): Attr {
  return attr("data-connection-filter", [...new Set(states)].join(" "));
}

/** `data-sf-status` — the segmented control's three buttons. */
export type SitesFilterStatus = "all" | "with" | "without";

export function sitesFilterStatus(status: SitesFilterStatus): Attr {
  return attr("data-sf-status", status);
}

/** `data-sf-count` — the two live counters `sites-filter.js` writes into. */
export type SitesFilterCount = "with" | "without";

export function sitesFilterCount(bucket: SitesFilterCount): Attr {
  return attr("data-sf-count", bucket);
}

/** Stable non-secret identity for browser-local visibility preferences. */
export function hostingSiteKey(profile: string, siteId: string): Attr {
  return attr("data-hosting-site-key", JSON.stringify([profile, siteId]));
}

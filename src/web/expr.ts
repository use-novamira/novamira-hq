// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Datastar expressions as a constructed type, never as a concatenated string.
 *
 * **What the Go did.** Every `data-on:*`, `data-class`, `data-attr`,
 * `data-text` and `data-init` value in `internal/dashboard/views.go` was built
 * by `+`. `editProviderExpression` (views.go:522) concatenated eight
 * `jsStringLiteral(...)` calls into one assignment sequence;
 * `providerPostButton` (views.go:513) glued `confirm(...)` in front of an
 * `@post(...)`; `connectButton` (views.go:503) wrote the token header and the
 * `filterSignals` scope out by hand at each of its eleven call sites. The
 * discipline — "always pass user data through `jsStringLiteral` before
 * concatenating" — was correct and entirely unenforced.
 *
 * **Why escaping is not the answer here.** These attribute values are
 * JavaScript that the browser evaluates. HTML-escaping them is *correct* (the
 * parser un-escapes before Datastar reads the attribute) but it is not
 * *safety*: a payload like `; @post('/_dashboard/providers/remove?…') ;` needs
 * no HTML metacharacter at all. The only sound rule is that attacker-influenced
 * data may enter an expression solely as a literal.
 *
 * **What HQ does instead.** `Expr` is a branded type with no raw constructor. A
 * `string` is not assignable to it and cannot be made into one except through
 * `jsString`/`jsJson`, which emit literals. There is deliberately no `rawExpr`.
 * Composition happens through `seq`, `objectExpr`, `confirmThen`, `set` and
 * `toggle`, so Go's "careful code" becomes checked code.
 *
 * `post` and `get` take no header or scope parameters: they always emit the
 * `X-Novamira-Dashboard-Token` header and always emit a `filterSignals` include
 * scope. Go's rule-7 convention test asserted that property over rendered
 * output; here it is an invariant of the constructor, so a credential typed into
 * the provider form cannot be broadcast on an unrelated request — there is no
 * way to build a request without a scope.
 *
 * **`@post` and `@get` do not scope alike, and that is deliberate.** The
 * Datastar client serializes `filterSignals` into the request *body* for a
 * method that has one and into the `?datastar=` **query string** for a `GET` or
 * `DELETE` (`src/web/static/datastar.js`: `ot(t) ? Y.body = F : U.set("datastar",
 * F)`). So every signal a `@get` includes lands in a URL. Two consequences are
 * encoded below:
 *
 * - `token` is prepended to a `@post`'s include scope and **never** to a
 *   `@get`'s. The mutation token travels in the `X-Novamira-Dashboard-Token`
 *   header on both — the `headers` option is emitted for every method — so the
 *   query-string copy would be pure leakage of the one value that stands between
 *   a local page and every `/_dashboard/*` route, against the contract's "never
 *   placed in a URL, a query string, an SSE frame, an error or a diagnostic".
 * - {@link get} refuses an include naming the provider form, the one signal
 *   subtree that holds a secret (`providerForm.credentialValue`). A credential
 *   belongs in a request body and nowhere else; a `@get` cannot put it there.
 */

import { CliError } from "../errors.js";
import { renderUrl, type Url } from "./html.js";
import { assertSignalPath, type SignalPath } from "./signals.js";

export declare const ExprBrand: unique symbol;

/** A Datastar expression: JavaScript the browser will evaluate. */
export interface Expr {
  readonly [ExprBrand]: "expr";
  readonly source: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The request header the dashboard's mutation token travels in. Exported so the
 * server's verification and these constructors cannot drift apart.
 */
export const DASHBOARD_TOKEN_HEADER = "X-Novamira-Dashboard-Token";

const EXPR_FORM = Symbol("novamira.web.expr");

interface ExprNode {
  readonly [EXPR_FORM]: "expr";
  readonly source: string;
}

function makeExpr(source: string): Expr {
  const node: ExprNode = { [EXPR_FORM]: "expr", source };
  return node as unknown as Expr;
}

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

function isExpr(value: unknown): value is ExprNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const form: unknown = (value as Partial<Record<typeof EXPR_FORM, unknown>>)[
    EXPR_FORM
  ];
  return form === "expr";
}

/** The rendered source. Exported for the attribute helpers and the test. */
export function renderExpr(expression: Expr): string {
  if (!isExpr(expression)) {
    throw internalError(
      "renderExpr received a value that this module did not mint. Build expressions with the constructors in src/web/expr.ts.",
    );
  }
  return expression.source;
}

const JS_LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * Harden a JSON literal for both of the places it lands: an HTML attribute
 * (where `<`, `>` and `&` would otherwise be re-interpreted after the parser
 * un-escapes) and a JavaScript source position (where U+2028 and U+2029 are line
 * terminators). `\uXXXX` survives `JSON.parse` and `eval` identically, so the
 * value the browser sees is byte-for-byte the value we serialized.
 */
function hardenLiteral(source: string): string {
  return source.replace(
    /[<>&\u2028\u2029]/g,
    (character) => JS_LITERAL_ESCAPES[character] ?? character,
  );
}

function stringifyJson(value: JsonValue): string {
  try {
    return hardenLiteral(JSON.stringify(value));
  } catch (error) {
    throw new CliError(
      "internal_error",
      "A dashboard expression could not serialize a value to JSON.",
      { cause: error },
    );
  }
}

/** A JavaScript string literal. The only way caller data enters an expression. */
export function jsString(value: string): Expr {
  return makeExpr(stringifyJson(value));
}

/** A decimal numeric literal; non-finite values are a programming error. */
export function jsNumber(value: number): Expr {
  if (!Number.isFinite(value)) {
    throw internalError(
      "A non-finite number cannot appear in a Datastar expression.",
    );
  }
  return makeExpr(String(value));
}

export function jsBoolean(value: boolean): Expr {
  return makeExpr(value ? "true" : "false");
}

/** A JavaScript object or array literal, hardened exactly as `jsString` is. */
export function jsJson(value: JsonValue): Expr {
  return makeExpr(stringifyJson(value));
}

/** `$path` — a signal read. */
export function signal(path: SignalPath): Expr {
  assertSignalPath(path);
  return makeExpr(`$${path}`);
}

/** `$path = <value>` — a signal write. */
export function set(path: SignalPath, value: Expr): Expr {
  assertSignalPath(path);
  return makeExpr(`$${path} = ${renderExpr(value)}`);
}

/** `!<value>`. */
export function not(value: Expr): Expr {
  return makeExpr(`!${renderExpr(value)}`);
}

/** `$path = !$path` — Go's `"$" + dsig + " = !$" + dsig`, without the seam. */
export function toggle(path: SignalPath): Expr {
  assertSignalPath(path);
  return makeExpr(`$${path} = !$${path}`);
}

const OBJECT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `{a: <expr>, b: <expr>}` — the shape `data-class` and `data-attr` take. */
export function objectExpr(entries: Readonly<Record<string, Expr>>): Expr {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!OBJECT_KEY.test(key)) {
      throw internalError(
        `"${key}" is not a legal identifier for a Datastar expression object key.`,
        { key },
      );
    }
    parts.push(`${key}: ${renderExpr(value)}`);
  }
  return makeExpr(`{${parts.join(", ")}}`);
}

/** `<a>; <b>; <c>` — Go's `expression + "; " + post`, made associative. */
export function seq(...steps: readonly Expr[]): Expr {
  return makeExpr(steps.map((step) => renderExpr(step)).join("; "));
}

/** `confirm("…") && (<action>)` — Go's `providerPostButton` confirm branch. */
export function confirmThen(message: string, action: Expr): Expr {
  return makeExpr(
    `confirm(${renderExpr(jsString(message))}) && (${renderExpr(action)})`,
  );
}

export interface PostOptions {
  /**
   * Signal subtrees the request may carry. `"token"` is added to a `@post`'s
   * scope and never to a `@get`'s — see this module's header comment.
   */
  readonly include: readonly SignalPath[];
}

/**
 * A pattern that matches no signal path at all.
 *
 * `@get(url, { include: [] })` still has to emit a `filterSignals` scope — every
 * request carries one, by construction — and an empty alternation would read as
 * a mistake. `(?!)` is the standard "never matches" assertion, so the Datastar
 * client serializes an empty object and the query string stays empty.
 */
const MATCHES_NOTHING = "/(?!)/";

/** The one signal subtree that can hold a secret, and its dotted children. */
const SECRET_SCOPE = "providerForm";

function includeScope(paths: readonly SignalPath[]): string {
  const unique: string[] = [];
  for (const path of paths) {
    assertSignalPath(path);
    if (!unique.includes(path)) {
      unique.push(path);
    }
  }
  if (unique.length === 0) {
    return MATCHES_NOTHING;
  }
  // Paths are already restricted to [A-Za-z0-9_.], so `.` is the only character
  // in them that means something to a regular expression.
  const alternation = unique
    .map((path) => path.replaceAll(".", "\\."))
    .join("|");
  return `/^(${alternation})(\\.|$)/`;
}

function requestExpr(
  action: "@post" | "@get",
  target: Url,
  options: PostOptions,
): Expr {
  // `@post` carries the token in its scope as well as its header, because the
  // body is not a URL. `@get` carries it in the header only: the client would
  // otherwise copy every included signal into `?datastar=…`.
  const paths =
    action === "@post"
      ? ["token" as SignalPath, ...options.include]
      : options.include;
  const address = renderExpr(jsString(renderUrl(target)));
  return makeExpr(
    `${action}(${address}, {headers: {"${DASHBOARD_TOKEN_HEADER}": $token}, filterSignals: {include: ${includeScope(paths)}}})`,
  );
}

/** `@post("/…", {headers: {…token…}, filterSignals: {include: /…/}})`. */
export function post(target: Url, options: PostOptions): Expr {
  return requestExpr("@post", target, options);
}

/**
 * As {@link post}, with `@get`. The token still travels — `requireToken` runs on
 * every `/_dashboard/*` route regardless of method — but in the header only, and
 * an include scope that could carry a credential is refused outright, because a
 * `@get`'s signals are serialized into the query string.
 */
export function get(target: Url, options: PostOptions): Expr {
  for (const path of options.include) {
    if (path === SECRET_SCOPE || path.startsWith(`${SECRET_SCOPE}.`)) {
      throw internalError(
        `A @get may not include "${path}": a GET's signals travel in the query string, and that subtree can hold a credential. Use post().`,
        { include: path },
      );
    }
    if (path === "token") {
      throw internalError(
        'A @get may not include "token": the mutation token travels in the X-Novamira-Dashboard-Token header, never in a URL.',
      );
    }
  }
  return requestExpr("@get", target, options);
}

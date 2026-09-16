// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard's markup primitive: a branded `html` tagged template, the
 * `Attr` and `Url` constructors, and one escaper.
 *
 * **What the Go did.** `internal/dashboard/views.go` mixed three mechanisms.
 * Some markup came from gomponents (`Div(Class("shell"), ...)`), which escapes;
 * some came from a `strings.Builder` writing angle brackets by hand
 * (`renderProviderTable`, views.go:385-400); and the two were welded together
 * with `Raw(...)` and `renderNode(...)` — roughly twenty `Raw` call sites whose
 * argument was "a string some other function already rendered". Composition was
 * therefore *trust*: any function that returned a `string` could be spliced
 * into any document position, and the compiler could not tell an escaped
 * fragment from an unescaped one, nor a text position from an attribute
 * position.
 *
 * **What HQ does instead.** Markup is a nominal type. `Html` and `Attr` carry a
 * module-local `unique symbol` brand, so no other module can produce one by
 * structural assignment, and a bare `string` is never markup: `renderHtml("<b>")`
 * does not compile. The only ways to mint an `Html` are the `html` template
 * (which escapes every interpolation) and `unsafeRawHtml` (which has zero call
 * sites outside this file — conventions rule 6 asserts it by reading the source
 * tree). The only ways to mint an `Attr` are the constructors below and the
 * `ds.*` helpers, all of which double-quote and escape their value, so the
 * attribute-injection class is unrepresentable rather than merely avoided.
 *
 * **Context awareness without an HTML parser.** The template does not parse
 * markup. It scans the *static* chunks — developer-authored, never
 * attacker-influenced — with a three-field state machine and classifies each
 * interpolation slot as text, attribute, or forbidden. Interpolating inside a
 * quoted attribute value or immediately after `=` is always an error: there is
 * no legal way to build an attribute value except through a constructor. The
 * scan is memoized in a `WeakMap` keyed on the `TemplateStringsArray`, which
 * JavaScript interns per call site, so each call site is scanned once per
 * process.
 *
 * **Nothing here ever puts an interpolated value into an error message.** A
 * dashboard form field can hold a provider API token; a thrown `CliError`
 * reaches the diagnostics sink and the failure envelope. Errors name the value's
 * *kind* and the fix, never its content.
 *
 * `Url` exists so that `href` cannot carry a scheme. `url()` is the only
 * constructor, it requires a leading `/`, and it rejects protocol-relative and
 * backslash-prefixed paths, so `javascript:` and `data:` URLs are not
 * expressible. A future external link (Phase 7's release URL) needs a separate
 * `externalUrl()` with an `http:`/`https:` allowlist; do not widen this one.
 */

import { CliError } from "../errors.js";

/**
 * Brand keys. They are ambient declarations with no runtime value, so exporting
 * them grants no capability — it only satisfies declaration emit, which refuses
 * to name a private symbol in an exported interface.
 */
export declare const HtmlBrand: unique symbol;
export declare const AttrBrand: unique symbol;
export declare const UrlBrand: unique symbol;

/** Markup that is already escaped, or is trusted verbatim. */
export interface Html {
  readonly [HtmlBrand]: "html";
  readonly markup: string;
}

/** One attribute, INCLUDING its leading space: ` class="x"`. */
export interface Attr {
  readonly [AttrBrand]: "attr";
  readonly markup: string;
}

/** A site-relative URL that provably cannot carry a scheme. */
export interface Url {
  readonly [UrlBrand]: "url";
  readonly value: string;
}

/**
 * Anything legal in a text position.
 *
 * `true` is deliberately absent. That single omission is what makes the idiom
 * `condition && html`…`` (whose type is `false | Html`) safe while a bare
 * boolean is rejected at compile time.
 */
export type HtmlValue =
  | Html
  | string
  | number
  | bigint
  | false
  | null
  | undefined
  | readonly HtmlValue[];

/** Anything legal in an attribute position. */
export type AttrValue = Attr | false | null | undefined | readonly AttrValue[];

/**
 * The runtime discriminator. It is keyed by a module-private symbol, so a forged
 * `{ markup: "<script>" }` object carries no form and is rejected by every
 * function here — the brand's compile-time guarantee has a runtime twin.
 */
const NODE_FORM = Symbol("novamira.web.node.form");

type NodeForm = "html" | "attr" | "url";

interface MarkupNode {
  readonly [NODE_FORM]: NodeForm;
  readonly markup: string;
}

interface UrlNode {
  readonly [NODE_FORM]: NodeForm;
  readonly value: string;
}

function makeHtml(markup: string): Html {
  const node: MarkupNode = { [NODE_FORM]: "html", markup };
  return node as unknown as Html;
}

function makeAttr(markup: string): Attr {
  const node: MarkupNode = { [NODE_FORM]: "attr", markup };
  return node as unknown as Attr;
}

function makeUrl(value: string): Url {
  const node: UrlNode = { [NODE_FORM]: "url", value };
  return node as unknown as Url;
}

function nodeFormOf(value: unknown): NodeForm | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const form: unknown = (value as Partial<Record<typeof NODE_FORM, unknown>>)[
    NODE_FORM
  ];
  return form === "html" || form === "attr" || form === "url"
    ? form
    : undefined;
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

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML text escaping. One escaper serves both text and attribute values, so a
 * value that migrates from one position to the other cannot become unsafe.
 *
 * Go's `template.HTMLEscapeString` spelled the quotes `&#34;`/`&#39;`; HQ uses
 * `&quot;` for readability. Both un-escape identically, and the conventions test
 * un-escapes before comparing, exactly as Go's `datastarAttrValues` did.
 *
 * Exported for the conventions test; production code reaches it through the
 * template and the `Attr` constructors.
 */
export function escapeHtml(value: string): string {
  // A NUL byte terminates an attribute name in some tokenizers, so it is
  // replaced rather than escaped — exactly what a conforming HTML tokenizer
  // does with it. It is handled outside the regex only to keep a control
  // character out of a character class.
  return value
    .replaceAll("\u0000", "\uFFFD")
    .replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

type SlotContext = "text" | "attribute" | "forbidden";

const TEMPLATE_SCANS = new WeakMap<
  TemplateStringsArray,
  readonly SlotContext[]
>();

type QuoteState = "none" | "double" | "single";

/**
 * Classify every interpolation slot by scanning the static chunks.
 *
 * The machine tracks three facts: whether a `<` has been seen without its `>`,
 * the quote state inside that tag, and whether the previous non-space character
 * inside the tag was `=`. That is enough to separate the three cases the render
 * rules distinguish, and it is sound because the chunks it reads are literal
 * source text — no interpolated value ever reaches it.
 */
function scanTemplate(strings: TemplateStringsArray): readonly SlotContext[] {
  const cached = TEMPLATE_SCANS.get(strings);
  if (cached !== undefined) {
    return cached;
  }
  const contexts: SlotContext[] = [];
  let inTag = false;
  let quote: QuoteState = "none";
  let afterEquals = false;
  for (let index = 0; index < strings.length; index += 1) {
    for (const character of strings[index] ?? "") {
      if (!inTag) {
        if (character === "<") {
          inTag = true;
          quote = "none";
          afterEquals = false;
        }
        continue;
      }
      if (quote === "double" || quote === "single") {
        if (
          (quote === "double" && character === '"') ||
          (quote === "single" && character === "'")
        ) {
          quote = "none";
          afterEquals = false;
        }
        continue;
      }
      switch (character) {
        case ">":
          inTag = false;
          afterEquals = false;
          break;
        case "=":
          afterEquals = true;
          break;
        case '"':
          quote = "double";
          afterEquals = false;
          break;
        case "'":
          quote = "single";
          afterEquals = false;
          break;
        case " ":
        case "\t":
        case "\n":
        case "\r":
        case "\f":
          // Whitespace does not clear `afterEquals`: `<div class= ${x}>` is
          // still an attribute-value position, and still forbidden.
          break;
        default:
          afterEquals = false;
          break;
      }
    }
    if (index < strings.length - 1) {
      contexts.push(classifySlot(inTag, quote, afterEquals));
    }
  }
  TEMPLATE_SCANS.set(strings, contexts);
  return contexts;
}

function classifySlot(
  inTag: boolean,
  quote: QuoteState,
  afterEquals: boolean,
): SlotContext {
  if (!inTag) {
    return "text";
  }
  if (quote !== "none" || afterEquals) {
    return "forbidden";
  }
  return "attribute";
}

function describeValue(value: unknown): string {
  const form = nodeFormOf(value);
  if (form !== undefined) {
    return form;
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function renderTextValue(value: unknown): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  const form = nodeFormOf(value);
  if (form === "html") {
    return (value as MarkupNode).markup;
  }
  if (form === "attr") {
    throw internalError(
      "The html template interpolated an attribute in a text position. Move the ds.* or attr() call inside the element's opening tag.",
    );
  }
  if (form === "url") {
    throw internalError(
      "The html template interpolated a Url in a text position. Use hrefAttr(url) inside the tag, or renderUrl(url) for display text.",
    );
  }
  if (typeof value === "string") {
    return escapeHtml(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw internalError(
        "The html template interpolated a non-finite number. Format it as a string before interpolating.",
      );
    }
    return escapeHtml(String(value));
  }
  if (typeof value === "bigint") {
    return escapeHtml(value.toString());
  }
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    let markup = "";
    for (const item of items) {
      markup += renderTextValue(item);
    }
    return markup;
  }
  throw internalError(
    `The html template interpolated an unsupported value of kind "${describeValue(value)}" in a text position. Use a string, a number, an Html fragment, an array of those, or false/null/undefined for "render nothing".`,
  );
}

function renderAttributeValue(value: unknown): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  const form = nodeFormOf(value);
  if (form === "attr") {
    return (value as MarkupNode).markup;
  }
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    let markup = "";
    for (const item of items) {
      markup += renderAttributeValue(item);
    }
    return markup;
  }
  throw internalError(
    `The html template interpolated a value of kind "${describeValue(value)}" inside a tag, where only attributes are legal. Use attr(), classAttr(), idAttr(), hrefAttr(), or a ds.* helper.`,
  );
}

/**
 * The tagged template. Every interpolation is escaped or refused; nothing is
 * ever spliced verbatim except an `Html` or an `Attr`, both of which this module
 * minted itself.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: readonly (HtmlValue | AttrValue)[]
): Html {
  const contexts = scanTemplate(strings);
  let markup = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    const context = contexts[index] ?? "forbidden";
    const value: unknown = values[index];
    switch (context) {
      case "text":
        markup += renderTextValue(value);
        break;
      case "attribute":
        markup += renderAttributeValue(value);
        break;
      case "forbidden":
        throw internalError(
          "The html template interpolated a value inside an attribute value. There is no legal interpolation there: build the whole attribute with attr(), classAttr(), idAttr(), hrefAttr(), or a ds.* helper and interpolate that instead.",
        );
      default:
        throw assertNeverContext(context);
    }
    markup += strings[index + 1] ?? "";
  }
  return makeHtml(markup);
}

function assertNeverContext(context: never): CliError {
  return internalError(
    `The html template reached an unreachable slot context: ${JSON.stringify(context)}.`,
  );
}

/**
 * The one escape hatch, greppable by design.
 *
 * It exists so the concept has exactly one name. In 6a it has zero call sites
 * outside this file, and the conventions test asserts that by reading
 * `src/web/`. Anything reaching for it should be a new `Attr` constructor, a new
 * `ds.*` helper, or a nested `html` fragment instead.
 */
export function unsafeRawHtml(markup: string): Html {
  return makeHtml(markup);
}

/**
 * The rendered string, and the only way markup leaves the type. `server.ts`, the
 * SSE wrapper, and the conventions test are its only callers.
 */
export function renderHtml(node: Html): string {
  if (nodeFormOf(node) !== "html") {
    throw internalError(
      "renderHtml received a value that this module did not mint. Build markup with the html template or unsafeRawHtml.",
    );
  }
  return (node as unknown as MarkupNode).markup;
}

const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9:._-]*$/;
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function requireAttributeName(name: string): void {
  if (!ATTRIBUTE_NAME.test(name)) {
    throw internalError(
      `"${name}" is not a legal attribute name. Names must match ${ATTRIBUTE_NAME.source}.`,
      { attribute: name },
    );
  }
}

function numberText(value: number | bigint): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (!Number.isFinite(value)) {
    throw internalError(
      "A non-finite number cannot be an attribute value. Format it as a string first.",
    );
  }
  return String(value);
}

/** ` name="value"`, value HTML-escaped, always double-quoted. */
export function attr(name: string, value: string | number | bigint): Attr {
  requireAttributeName(name);
  const text = typeof value === "string" ? value : numberText(value);
  return makeAttr(` ${name}="${escapeHtml(text)}"`);
}

/** A valueless attribute: ` defer`. */
export function flagAttr(name: string): Attr {
  requireAttributeName(name);
  return makeAttr(` ${name}`);
}

/**
 * ` class="a b c"`, skipping false/null/undefined tokens so
 * `classAttr("panel", open && "open")` reads naturally.
 *
 * Empty and whitespace-only strings are skipped too, so a falsy token never
 * leaves a stray separator. When every token is skipped the result is the empty
 * attribute rather than ` class=""`.
 */
export function classAttr(
  ...tokens: readonly (string | false | null | undefined)[]
): Attr {
  const kept: string[] = [];
  for (const token of tokens) {
    if (typeof token === "string" && token.trim() !== "") {
      kept.push(token);
    }
  }
  if (kept.length === 0) {
    return makeAttr("");
  }
  return attr("class", kept.join(" "));
}

/** ` id="value"`, value validated so it is always a legal CSS selector target. */
export function idAttr(id: string): Attr {
  if (!ID_VALUE.test(id)) {
    throw internalError(
      `"${id}" is not a legal element id. Ids must match ${ID_VALUE.source}; hash a caller-supplied name (see connCellId) rather than passing it through.`,
      { id },
    );
  }
  return attr("id", id);
}

/** ` href="/path?query"`. Only a `Url` may be an href. */
export function hrefAttr(target: Url): Attr {
  return attr("href", renderUrl(target));
}

/** Fixed external documentation links; never usable for Datastar requests. */
export function documentationHref(client: "claude" | "chatgpt"): Attr {
  return attr(
    "href",
    client === "claude"
      ? "https://modelcontextprotocol.io/docs/develop/connect-local-servers"
      : "https://learn.chatgpt.com/docs/extend/mcp",
  );
}

const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

/** Fixed product links; no caller-supplied external URLs. */
export function aboutHref(link: "website" | "source" | "license"): Attr {
  return attr(
    "href",
    {
      website: "https://novamira.ai",
      source: "https://github.com/use-novamira/novamira-hq",
      license: "https://www.gnu.org/licenses/agpl-3.0.html",
    }[link],
  );
}

/**
 * The only `Url` constructor.
 *
 * `path` must begin with `/`, so no scheme is expressible; `//` and `/\` are
 * rejected because both are protocol-relative to a browser; `?` and `#` are
 * rejected because the query is built here, from `query`, through
 * `URLSearchParams`. Go built dashboard links by string concatenation with
 * `url.QueryEscape` on the values (views.go:514) — correct every time it was
 * written, and unchecked.
 */
export function url(
  path: string,
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): Url {
  if (!path.startsWith("/")) {
    throw internalError(
      "A dashboard URL must be site-relative and begin with '/'. External links need a separate, allowlisted constructor.",
      { path },
    );
  }
  if (path.startsWith("//") || path.startsWith("/\\")) {
    throw internalError("A dashboard URL must not be protocol-relative.", {
      path,
    });
  }
  if (path.includes("?") || path.includes("#")) {
    throw internalError(
      "A dashboard URL path must not carry a query or a fragment; pass the query as the second argument.",
      { path },
    );
  }
  if (!SAFE_PATH.test(path)) {
    throw internalError(
      "A dashboard URL path contains a character that is not legal in a path.",
      { path },
    );
  }
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    parameters.set(name, typeof value === "string" ? value : String(value));
  }
  const search = parameters.toString();
  return makeUrl(search === "" ? path : `${path}?${search}`);
}

export function renderUrl(target: Url): string {
  if (nodeFormOf(target) !== "url") {
    throw internalError(
      "renderUrl received a value that this module did not mint. Build URLs with url().",
    );
  }
  return (target as unknown as UrlNode).value;
}

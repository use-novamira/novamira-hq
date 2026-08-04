// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard's rendering conventions: the `html` template, the `Attr` and
 * `Url` constructors, the `Expr` constructors, the Datastar attribute helpers,
 * the patch catalog and the root signal object.
 *
 * This is the restatement of `internal/dashboard/gomponents_conventions_test.go`
 * (378 lines, nine rules) against HQ's TypeScript API, plus the XSS cases the Go
 * file never had. Three of Go's rules became types rather than tests — a
 * `data-bind` cannot begin with `$`, `ds.on` cannot take `"submit"`, and an
 * uncatalogued patch selector is a compile error — so the assertions below are
 * the *residual* runtime properties: that the guards survive an untyped call
 * site (which is exactly what this `.mjs` file is), and that what the browser
 * receives is what the constructors promised.
 *
 * Fully offline and socket-free. Pages are rendered through `server.dispatch`,
 * which takes a plain request object and returns a plain response; SSE frames
 * are produced with a `ServerResponse`-shaped stub. Each case that needs a
 * config file isolates itself under `NOVAMIRA_HQ_HOME` in a temporary directory.
 *
 * The numbering in the section banners is the spec's numbered rule list, so a
 * rule and its test can be found from either side.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultFileSecurity } from "../dist/config/file-security.js";
import { ProfileLockManager } from "../dist/config/lock.js";
import { platformPaths } from "../dist/config/paths.js";
import { ConfigStore } from "../dist/config/profiles.js";
import { CliError } from "../dist/errors.js";
import * as ds from "../dist/web/datastar.js";
import {
  confirmThen,
  get,
  jsBoolean,
  jsJson,
  jsNumber,
  jsString,
  not,
  objectExpr,
  post,
  renderExpr,
  seq,
  set,
  signal,
  toggle,
  DASHBOARD_TOKEN_HEADER,
} from "../dist/web/expr.js";
import {
  attr,
  classAttr,
  escapeHtml,
  flagAttr,
  hrefAttr,
  html,
  idAttr,
  renderHtml,
  renderUrl,
  unsafeRawHtml,
  url,
} from "../dist/web/html.js";
import { connCellId, SSE_PATCH_FRAGMENTS } from "../dist/web/patches.js";
import { createRouteTable, DEFERRED_ROUTES } from "../dist/web/routes.js";
import {
  defaultDashboardSignals,
  ALL_PROFILES_SENTINEL,
} from "../dist/web/signals.js";
import { streamSse } from "../dist/web/sse.js";
import { createDashboardServer } from "../dist/web/server.js";
import {
  renderMain,
  renderNav,
  renderToast,
} from "../dist/web/views/layout.js";

const TOKEN = "c".repeat(64);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  version: 1,
  hostingProfiles: {
    dev: {
      provider: "kinsta",
      credential: { type: "env", name: "KINSTA_API_KEY" },
      companyId: "company-1",
    },
  },
  deployPaths: {},
};

const temporaryRoots = [];
const openServers = [];

after(async () => {
  for (const server of openServers) await server.close();
  for (const root of temporaryRoots)
    await rm(root, { recursive: true, force: true });
});

/**
 * A dashboard server whose token is fixed, driven only through `dispatch`. It
 * never binds a socket; `after` closes it anyway, so a future case that does
 * bind cannot leave a listener behind.
 */
async function dashboard() {
  const home = await mkdtemp(join(tmpdir(), "novamira-hq-html-"));
  temporaryRoots.push(home);
  const environment = { NOVAMIRA_HQ_HOME: home };
  const paths = platformPaths(environment, process.platform, home);
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(CONFIG));
  const security = defaultFileSecurity();
  const store = new ConfigStore(
    paths.configFile,
    new ProfileLockManager(paths.stateDir, security),
    security,
  );
  const server = createDashboardServer({
    version: "0.1.0-test",
    paths,
    store,
    hosting: {},
    credentials: async () => {
      throw new Error("the conventions test must not build a credential store");
    },
    environment,
    fetch: async () => {
      throw new Error("the conventions test must not make a request");
    },
    now: () => 1_700_000_000_000,
    randomToken: () => TOKEN,
    integration: {
      connectionStates: async () => {
        throw new Error("the conventions test must not detect connections");
      },
    },
  });
  openServers.push(server);
  return server;
}

/** Render one routed path and return its markup. */
async function page(server, path) {
  const target = new URL(path, "http://127.0.0.1:8787");
  const response = await server.dispatch({
    method: "GET",
    path: decodeURIComponent(target.pathname),
    query: target.searchParams,
    headers: { host: "127.0.0.1:8787" },
    body: async () => "",
  });
  assert.equal(response.kind, "html", path);
  assert.equal(response.status, 200, path);
  return response.body.markup;
}

/** Every 6a page, including the two query-string variants Go's rule 5 used. */
const CORPUS_PATHS = [
  "/",
  "/providers",
  "/providers?new=host",
  "/sites",
  "/sites?new=site",
  "/deploy-paths",
  "/deploy-paths/new",
  "/novamira-setup?profile=dev&env=env-1",
  "/diagnostics",
  "/settings",
];

let corpusCache;

/** The concatenated markup of every 6a page: Go's `combined`. */
async function corpus() {
  if (corpusCache !== undefined) return corpusCache;
  const server = await dashboard();
  const pages = [];
  for (const path of CORPUS_PATHS) pages.push(await page(server, path));
  corpusCache = pages.join("\n");
  return corpusCache;
}

/** Go's `datastarAttrValues`: every value of one attribute, HTML-unescaped. */
function attrValues(body, name) {
  const pattern = new RegExp(
    `${name.replaceAll(/[.*+?^${}()|[\]\\:]/g, "\\$&")}="([^"]*)"`,
    "g",
  );
  return [...body.matchAll(pattern)].map((match) => unescapeHtml(match[1]));
}

function unescapeHtml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The markup of a single `Attr`, as it appears inside a tag. */
function renderAttr(node) {
  const markup = renderHtml(html`<div${node}></div>`);
  return markup.slice("<div".length, -"></div>".length);
}

/**
 * Every `.ts` file under `src/web/`, with its comment lines dropped.
 *
 * A rule that forbade a *word* would forbid documenting it: `index.ts` names
 * `unsafeRawHtml` in its header comment precisely to say it is not re-exported.
 * So the source rules below read code, not prose.
 */
async function webSources() {
  const root = fileURLToPath(new URL("../src/web/", import.meta.url));
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "static") await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const code = (await readFile(full, "utf8"))
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !(
            trimmed.startsWith("//") ||
            trimmed.startsWith("/*") ||
            trimmed.startsWith("*")
          );
        })
        .join("\n");
      files.push({ path: full, code });
    }
  };
  await walk(root);
  return { root, files };
}

function isInternalError(error) {
  assert.ok(error instanceof CliError, `not a CliError: ${String(error)}`);
  assert.equal(error.code, "internal_error");
  return true;
}

/* -------------------------------------------------------------------------- */
/* A. The template primitive (rules 1-7; Go rule 9)                           */
/* -------------------------------------------------------------------------- */

test("1: the synthetic Datastar component renders Go's exact attributes", () => {
  // The direct port of Go's `TestGomponentsDatastarImportConvention`. The path
  // is untyped here because this file is `.mjs`; in TypeScript `toggle` takes a
  // `SignalPath`, and `assertSignalPath` is what still guards this call site.
  const markup = renderHtml(
    html`<div${ds.signals({ ready: true })}><button type="button"${ds.on(
      "click",
      toggle("ready"),
    )}>Toggle</button></div>`,
  );
  for (const want of [
    "data-signals=",
    'data-on:click="$ready = !$ready"',
    ">Toggle</button>",
  ])
    assert.ok(markup.includes(want), `${want} missing from ${markup}`);
  // The colon separator lives in one place, so gomponents' `data-on-click`
  // spelling (Go rule 9) cannot be typed at all.
  assert.ok(!markup.includes("data-on-click"));

  // The same helper over a real, compiler-derived signal path.
  assert.equal(
    renderAttr(ds.on("click", toggle("sites.loading"))),
    ' data-on:click="$sites.loading = !$sites.loading"',
  );
});

test("2: a text interpolation renders exactly, with no wrapper or stray space", () => {
  assert.equal(renderHtml(html`<p>${"plain"}</p>`), "<p>plain</p>");
  assert.equal(renderHtml(html`${""}`), "");
  assert.equal(renderHtml(html`<p>${7}</p>`), "<p>7</p>");
  assert.equal(
    renderHtml(html`<p>${9007199254740993n}</p>`),
    "<p>9007199254740993</p>",
  );
});

test("3: a nested Html fragment splices verbatim, never double-escaped", () => {
  assert.equal(
    renderHtml(html`<div>${html`<b>x</b>`}</div>`),
    "<div><b>x</b></div>",
  );
  assert.equal(
    renderHtml(html`<div>${html`<b>${"a&b"}</b>`}</div>`),
    "<div><b>a&amp;b</b></div>",
  );
});

test("4: arrays interpolate element by element, flatten, and may be empty", () => {
  assert.equal(
    renderHtml(html`<ul>${[html`<li>a</li>`, html`<li>b</li>`]}</ul>`),
    "<ul><li>a</li><li>b</li></ul>",
  );
  assert.equal(
    renderHtml(html`<p>${["a", ["b", ["c"]]]}</p>`),
    "<p>abc</p>",
    "nested arrays flatten with no separator",
  );
  assert.equal(renderHtml(html`<p>${[]}</p>`), "<p></p>");
  assert.equal(
    renderHtml(html`<p>${["a", false, null, "b"]}</p>`),
    "<p>ab</p>",
  );
});

test("5: false, null and undefined render nothing; true is refused", () => {
  for (const value of [false, null, undefined])
    assert.equal(renderHtml(html`<p>${value}</p>`), "<p></p>", String(value));
  // `true` is not a member of `HtmlValue`, so in TypeScript this call site does
  // not compile — that is what makes `condition && html`…`` safe while a bare
  // boolean is rejected. The runtime factory refuses it too, which is the
  // assertion an untyped caller can make.
  assert.throws(() => html`<p>${true}</p>`, isInternalError);
});

test("6: unsafeRawHtml has no call site outside src/web/html.ts", async () => {
  const { root, files } = await webSources();
  const offenders = files
    .filter((file) => file.code.includes("unsafeRawHtml"))
    .map((file) => file.path);
  assert.deepEqual(offenders, [join(root, "html.ts")]);
  // It still exists, so the concept has exactly one name.
  assert.equal(renderHtml(unsafeRawHtml("<b>trusted</b>")), "<b>trusted</b>");
});

test("7: Html cannot be forged structurally, and renderHtml is the only exit", () => {
  // At the type level `renderHtml({ markup: "<b>" })` does not compile: `Html`'s
  // brand is a module-local `unique symbol`. The runtime discriminator is the
  // twin of that guarantee, and is what an untyped caller hits.
  assert.throws(
    () => renderHtml({ markup: "<script>alert(1)</script>" }),
    isInternalError,
  );
  assert.throws(() => renderHtml("<b>"), isInternalError);
  assert.throws(
    () => renderUrl({ value: "javascript:alert(1)" }),
    isInternalError,
  );
  assert.throws(() => renderExpr({ source: "alert(1)" }), isInternalError);
  // And an `Attr` is not an `Html`, however similar the runtime shape.
  assert.throws(() => renderHtml(attr("title", "x")), isInternalError);
});

/* -------------------------------------------------------------------------- */
/* B. XSS in each context (rules 8-16; new — Go had none)                     */
/* -------------------------------------------------------------------------- */

const TEXT_PAYLOAD = '"><script>alert(1)</script>';

test("8: a script payload in a text position is inert", () => {
  const markup = renderHtml(html`<td>${TEXT_PAYLOAD}</td>`);
  const inner = markup.slice("<td>".length, -"</td>".length);
  assert.ok(!markup.includes("<script"));
  assert.ok(!inner.includes("<"));
  assert.ok(!inner.includes(">"));
  assert.ok(markup.includes("&quot;&gt;&lt;script&gt;"));
  assert.equal(unescapeHtml(inner), TEXT_PAYLOAD, "round-trips un-escaped");
  assert.equal(
    escapeHtml("a\u0000b"),
    "a\uFFFDb",
    "a NUL becomes the replacement character, as a conforming tokenizer does",
  );
  assert.equal(escapeHtml("&<>\"'"), "&amp;&lt;&gt;&quot;&#39;");
});

test("9: a quote in an attribute value cannot close the attribute", () => {
  const payload = 'a" onclick="alert(1)';
  assert.equal(
    renderAttr(attr("title", payload)),
    ' title="a&quot; onclick=&quot;alert(1)"',
  );
  const markup = renderHtml(html`<a${attr("title", payload)}>x</a>`);
  const matches = [...markup.matchAll(/title="([^"]*)"/g)];
  assert.equal(matches.length, 1, "exactly one attribute, one quote pair");
  assert.equal(unescapeHtml(matches[0][1]), payload);
  assert.ok(!markup.includes('onclick="'), "no second attribute was created");
});

test("10: an angle bracket in a class token cannot close the tag", () => {
  assert.equal(renderAttr(classAttr("a", "<b>")), ' class="a &lt;b&gt;"');
  const markup = renderHtml(html`<div${classAttr("a", "<b>")}></div>`);
  assert.equal(markup, '<div class="a &lt;b&gt;"></div>');
  // The same escaper serves `id`, and an illegal id is refused outright rather
  // than escaped, because an id is a selector target.
  assert.throws(() => idAttr("a b"), isInternalError);
  assert.throws(() => idAttr('x"><script>'), isInternalError);
  assert.throws(() => attr("on<click", "x"), isInternalError);
  assert.throws(() => flagAttr("a b"), isInternalError);
});

test("11: a backslash and a quote in a JS literal round-trip through JSON.parse", () => {
  const payload = 'a\\"; alert(1); //';
  const source = renderExpr(jsString(payload));
  assert.equal(JSON.parse(source), payload);
  assert.equal(source.at(0), '"');
  assert.equal(source.at(-1), '"');
  const inner = source.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === "\\") {
      index += 1;
      continue;
    }
    assert.notEqual(inner[index], '"', `unescaped quote at ${String(index)}`);
  }
  assert.ok(!source.includes("</"));
});

test("12: a script terminator in a JS literal is escaped, not emitted", () => {
  const source = renderExpr(jsString("</script>"));
  assert.ok(source.includes("\\u003c"));
  assert.ok(!source.includes("</script"));
  assert.ok(!source.includes("<"));
  assert.ok(!source.includes(">"));
  assert.equal(JSON.parse(source), "</script>");
  // `&` too, so an already-escaped attribute value cannot be re-interpreted
  // after the HTML parser un-escapes it.
  assert.equal(renderExpr(jsString("a&b")), '"a\\u0026b"');
});

test("13: U+2028 and U+2029 are escaped, not emitted as line terminators", () => {
  const payload = "a\u2028b\u2029c";
  const source = renderExpr(jsString(payload));
  assert.ok(source.includes("\\u2028"));
  assert.ok(source.includes("\\u2029"));
  assert.ok(!source.includes("\u2028"), "not a raw line terminator");
  assert.ok(!source.includes("\u2029"), "not a raw paragraph separator");
  assert.equal(JSON.parse(source), payload);
});

test("14: a signal value carrying markup survives JSON.parse and never reaches the tokenizer", () => {
  const value = { x: "</div><script>", nested: { y: ["a&b", "<c>"] } };
  const markup = renderHtml(html`<div${ds.signals(value)}></div>`);
  const [rendered] = attrValues(markup, "data-signals");
  assert.deepEqual(JSON.parse(rendered), value);
  const raw = /data-signals="([^"]*)"/.exec(markup)[1];
  assert.ok(!raw.includes("<"));
  assert.ok(!raw.includes(">"));
  assert.ok(!raw.includes('"'), "the attribute's own quoting is intact");
  assert.deepEqual(JSON.parse(renderExpr(jsJson(value))), value);
});

test("15: url() encodes its query and cannot express a scheme", () => {
  const target = url("/sites", { profile: 'a b&c="' });
  const rendered = renderUrl(target);
  assert.ok(rendered.startsWith("/sites?"));
  assert.equal(
    new URLSearchParams(rendered.slice(rendered.indexOf("?") + 1)).get(
      "profile",
    ),
    'a b&c="',
  );
  assert.ok(!rendered.includes('"'));
  assert.equal(
    renderAttr(hrefAttr(target)),
    ` href="${rendered.replaceAll("&", "&amp;")}"`,
  );
  for (const bad of [
    "javascript:alert(1)",
    "//evil.example",
    "https://x/",
    "data:text/html,<script>alert(1)</script>",
    "/\\evil.example",
    "sites",
    "/sites?x=1",
    "/sites#frag",
    "/sites<script>",
  ])
    assert.throws(() => url(bad), isInternalError, bad);
  // Undefined query values are dropped rather than rendered as "undefined".
  assert.equal(
    renderUrl(url("/x", { a: undefined, b: 1, c: true })),
    "/x?b=1&c=true",
  );
});

test("15b: hrefAttr is the only way a URL attribute is written", async () => {
  // `url()` being the only `Url` constructor is what makes `javascript:` and
  // `data:` unrepresentable — but only while every URL-bearing attribute goes
  // through `hrefAttr`. `attr("href", …)` takes a plain string and would let a
  // scheme back in, so, in the spirit of rule 6, no call site may write one.
  // Phase 7's external release link needs an `externalUrl()` with an
  // `http:`/`https:` allowlist, not a hand-written attribute.
  const { root, files } = await webSources();
  const offenders = [];
  for (const file of files) {
    for (const name of ["href", "src", "action", "formaction", "xlink:href"]) {
      if (file.code.includes(`attr("${name}"`))
        offenders.push(`${file.path} ${name}`);
    }
  }
  assert.deepEqual(offenders, [`${join(root, "html.ts")} href`]);
  assert.equal(renderAttr(hrefAttr(url("/providers"))), ' href="/providers"');
});

test("16: the template refuses every illegal interpolation context", () => {
  // An attribute in a text position.
  assert.throws(() => html`<div>${attr("title", "x")}</div>`, isInternalError);
  assert.throws(() => html`<div>${url("/x")}</div>`, isInternalError);
  // A string, a number or an Html fragment inside a tag.
  assert.throws(() => html`<div ${'class="x"'}></div>`, isInternalError);
  assert.throws(() => html`<div ${7}></div>`, isInternalError);
  assert.throws(() => html`<div ${html`<b>x</b>`}></div>`, isInternalError);
  // Anything at all inside a quoted attribute value, or straight after `=`.
  assert.throws(() => html`<a href="${"/x"}">y</a>`, isInternalError);
  assert.throws(() => html`<a href='${"/x"}'>y</a>`, isInternalError);
  assert.throws(() => html`<a href=${"/x"}>y</a>`, isInternalError);
  assert.throws(() => html`<a href= ${"/x"}>y</a>`, isInternalError);
  assert.throws(() => html`<a href="${attr("x", "y")}">z</a>`, isInternalError);
  // The message never carries the interpolated value: a dashboard form field
  // can hold a provider API token, and a CliError reaches the failure envelope.
  const secret = "sk-live-do-not-log";
  try {
    html`<a href="${secret}">x</a>`;
    assert.fail("the forbidden context must throw");
  } catch (error) {
    assert.ok(
      !JSON.stringify({
        message: error.message,
        details: error.details,
      }).includes(secret),
    );
  }
  // The scanner errs towards refusal, and 6b should know where. A bare `<` in a
  // text chunk opens a tag as far as the state machine is concerned, so the
  // next slot is an attribute position — write `&lt;` in the static markup. An
  // HTML comment behaves the same way. Both refuse rather than mis-escape,
  // which is the direction a scanner that does not parse HTML must lean.
  assert.throws(() => html`<p>5 < 6 ${"x"}</p>`, isInternalError);
  assert.throws(() => html`<!-- ${"x"} -->`, isInternalError);
  assert.equal(renderHtml(html`<p>5 &lt; 6 ${"x"}</p>`), "<p>5 &lt; 6 x</p>");
  // A `>` inside a quoted attribute value in the static markup does not end the
  // tag, so the following attribute slot is still classified correctly.
  assert.equal(
    renderHtml(html`<div title="a>b"${attr("id", "x")}></div>`),
    '<div title="a>b" id="x"></div>',
  );
  // And the legal shapes still work, across a multi-line tag.
  assert.equal(
    renderHtml(html`<div
      ${classAttr("a")}
      ${attr("title", "t")}
    >x</div>`).replaceAll(/\s+/g, " "),
    '<div class="a" title="t" >x</div>',
  );
});

/* -------------------------------------------------------------------------- */
/* C. Bare signal paths (rules 17-20; Go rules 6 and 8)                       */
/* -------------------------------------------------------------------------- */

test("17: no data-bind in any rendered page begins with $", async () => {
  const body = await corpus();
  for (const value of attrValues(body, "data-bind"))
    assert.ok(!value.startsWith("$"), `data-bind=${value}`);
  // 6a's shell binds nothing, so the scan above would pass on a broken
  // extractor. This proves the extractor finds what it is meant to find.
  const probe = renderHtml(html`<input${ds.bind("sites.search")}>`);
  assert.deepEqual(attrValues(probe, "data-bind"), ["sites.search"]);
});

test("18: no data-indicator in any rendered page begins with $", async () => {
  const body = await corpus();
  for (const value of attrValues(body, "data-indicator"))
    assert.ok(!value.startsWith("$"), `data-indicator=${value}`);
  const probe = renderHtml(
    html`<button${ds.indicator("sites.loading")}></button>`,
  );
  assert.deepEqual(attrValues(probe, "data-indicator"), ["sites.loading"]);
});

test("19: bind and indicator refuse a path an `as SignalPath` cast could smuggle", () => {
  for (const bad of [
    "$sites.search",
    ".sites",
    "sites.",
    "sites..search",
    "sites search",
    "sites-search",
    "sites/search",
    "",
    "$",
  ]) {
    assert.throws(() => ds.bind(bad), isInternalError, `bind ${bad}`);
    assert.throws(() => ds.indicator(bad), isInternalError, `indicator ${bad}`);
    assert.throws(() => signal(bad), isInternalError, `signal ${bad}`);
    assert.throws(() => toggle(bad), isInternalError, `toggle ${bad}`);
  }
  assert.equal(
    renderAttr(ds.bind("sites.search")),
    ' data-bind="sites.search"',
  );
  assert.equal(
    renderAttr(ds.indicator("sites.loading")),
    ' data-indicator="sites.loading"',
  );
});

test("20: sites.search is producible and is what sites-filter.js selects on", async () => {
  const markup = renderHtml(
    html`<input type="search"${ds.bind("sites.search")}>`,
  );
  assert.ok(markup.includes('data-bind="sites.search"'));
  const script = await readFile(
    new URL("../src/web/static/sites-filter.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    script.includes('input[data-bind="sites.search"]'),
    "the shipped filter selects on the spelling the helper emits",
  );

  // The bindings 6b's page tests must extend this list with. Each must name a
  // field the root signal object actually has, which is what catches Go's
  // `companyID` spelling and proves `siteForm.*` is permanently absent.
  const signals = defaultDashboardSignals(TOKEN);
  const resolve = (path) =>
    path
      .split(".")
      .reduce(
        (node, key) =>
          node !== undefined && Object.hasOwn(node, key)
            ? node[key]
            : undefined,
        signals,
      );
  for (const path of [
    "providerForm.profile",
    "providerForm.provider",
    "providerForm.credentialValue",
    "providerForm.companyId",
    "sites.search",
    "sites.profile",
    "diagnostics.profile",
    "deployForm.name",
    "deployForm.sourceEnvId",
    "deployForm.targetEnvId",
    "deployForm.pushDb",
    "deployForm.pushFiles",
    "deployForm.searchReplace",
  ]) {
    assert.notEqual(resolve(path), undefined, path);
    assert.doesNotThrow(() => ds.bind(path), path);
  }
  assert.equal(
    resolve("providerForm.companyID"),
    undefined,
    "Go's spelling is gone",
  );
  assert.equal(
    resolve("siteForm"),
    undefined,
    "siteForm is permanently absent",
  );
});

/* -------------------------------------------------------------------------- */
/* D. Submit handlers and post scoping (rules 21-26; Go rule 7)               */
/* -------------------------------------------------------------------------- */

test("21: no rendered output carries a bare data-on:submit", async () => {
  const body = await corpus();
  assert.ok(!body.includes('data-on:submit="'));
});

test("22: onSubmit always emits data-on:submit__prevent", () => {
  const markup = renderHtml(
    html`<form${ds.onSubmit(post(url("/_dashboard/providers/save"), { include: ["providerForm"] }))}></form>`,
  );
  assert.ok(markup.includes('data-on:submit__prevent="'));
  assert.ok(!markup.includes('data-on:submit="'));
  const [value] = attrValues(markup, "data-on:submit__prevent");
  assert.ok(value.startsWith("@post("));
});

test("23: ds.on cannot bind submit, and refuses an unknown event or modifier", () => {
  assert.throws(() => ds.on("submit", jsBoolean(true)), isInternalError);
  assert.throws(() => ds.on("mouseover", jsBoolean(true)), isInternalError);
  assert.throws(
    () => ds.on("click", jsBoolean(true), "debounce"),
    isInternalError,
  );
  assert.equal(
    renderAttr(ds.on("click", jsBoolean(true), "prevent", "outside")),
    ' data-on:click__prevent__outside="true"',
  );
});

test("24: every @post and @get carries the token header and a filterSignals scope", async () => {
  const built = [
    post(url("/_dashboard/providers/save"), { include: ["providerForm"] }),
    post(url("/_dashboard/connect"), { include: [] }),
    get(url("/_dashboard/sites", { include_envs: true }), {
      include: ["sites"],
    }),
    seq(
      set("sites.loading", jsBoolean(true)),
      post(url("/_dashboard/providers/remove"), { include: ["providerForm"] }),
    ),
    confirmThen(
      "Remove it?",
      post(url("/_dashboard/providers/remove"), { include: ["providerForm"] }),
    ),
  ];
  const rendered = built.map((expression) =>
    renderAttr(ds.on("click", expression)),
  );
  const body = [await corpus(), ...rendered].join("\n");
  const values = [
    ...attrValues(body, "data-on:click"),
    ...attrValues(body, "data-on:submit__prevent"),
    ...attrValues(body, "data-on:change"),
    ...attrValues(body, "data-init"),
  ];
  let requests = 0;
  for (const value of values) {
    if (!value.includes("@post(") && !value.includes("@get(")) continue;
    requests += 1;
    assert.ok(value.includes(DASHBOARD_TOKEN_HEADER), value);
    assert.ok(value.includes("filterSignals"), value);
  }
  assert.equal(
    requests,
    rendered.length,
    "the scan found every constructed request",
  );
  // The corpus itself must contain no request at all: 6a ships no action.
  assert.ok(!(await corpus()).includes("@post("));
  assert.ok(!(await corpus()).includes("@get("));
});

test("25: a @post's include scope names token, exactly once, regex-escaped", () => {
  assert.equal(
    renderExpr(post(url("/x"), { include: ["providerForm"] })),
    '@post("/x", {headers: {"X-Novamira-Dashboard-Token": $token}, filterSignals: {include: /^(token|providerForm)(\\.|$)/}})',
  );
  assert.equal(
    renderExpr(post(url("/x"), { include: ["token", "sites", "token"] })),
    '@post("/x", {headers: {"X-Novamira-Dashboard-Token": $token}, filterSignals: {include: /^(token|sites)(\\.|$)/}})',
  );
  assert.ok(
    renderExpr(
      post(url("/x"), { include: ["providerForm.credentialValue"] }),
    ).includes("/^(token|providerForm\\.credentialValue)(\\.|$)/"),
    "a dot in an include path is escaped for the regular expression",
  );
  assert.ok(
    renderExpr(post(url("/x"), { include: [] })).includes("/^(token)(\\.|$)/"),
  );
  assert.throws(
    () => post(url("/x"), { include: ["$providerForm"] }),
    isInternalError,
  );
});

test("25b: a @get's include scope never names token, and never a secret", async () => {
  // The vendored client serializes `filterSignals` into `?datastar=…` for a GET
  // (`ot(t) ? Y.body = F : U.set("datastar", F)` in static/datastar.js), so
  // anything in a @get's scope lands in a URL. The token travels in the header
  // on both verbs, so it must not be in the scope of the one that leaks it.
  assert.equal(
    renderExpr(get(url("/_dashboard/sites"), { include: ["sites"] })),
    '@get("/_dashboard/sites", {headers: {"X-Novamira-Dashboard-Token": $token}, filterSignals: {include: /^(sites)(\\.|$)/}})',
  );
  // Empty include: still a scope, and one that matches no signal at all.
  assert.equal(
    renderExpr(get(url("/x"), { include: [] })),
    '@get("/x", {headers: {"X-Novamira-Dashboard-Token": $token}, filterSignals: {include: /(?!)/}})',
  );
  for (const include of [
    ["token"],
    ["providerForm"],
    ["providerForm.credentialValue"],
  ])
    assert.throws(
      () => get(url("/x"), { include }),
      isInternalError,
      include.join(),
    );

  const client = await readFile(
    new URL("../src/web/static/datastar.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    client.includes('U.set("datastar"'),
    "the vendored client still puts a GET's filtered signals in the query string",
  );
});

test("25c: no rendered @get anywhere puts the token in its include scope", async () => {
  const body = [
    await corpus(),
    renderAttr(ds.on("click", get(url("/_dashboard/sites"), { include: [] }))),
    renderAttr(
      ds.on("click", get(url("/_dashboard/sites"), { include: ["sites"] })),
    ),
  ].join("\n");
  for (const value of [
    ...attrValues(body, "data-on:click"),
    ...attrValues(body, "data-on:change"),
    ...attrValues(body, "data-init"),
  ]) {
    const scope = /@get\([^)]*include: (\/[^/]*\/)/.exec(value)?.[1];
    if (scope === undefined) continue;
    assert.ok(!scope.includes("token"), value);
  }
});

test("26: the deleted site-profile routes appear nowhere", async () => {
  const body = await corpus();
  for (const path of ["/_dashboard/sites/save", "/_dashboard/sites/remove"]) {
    assert.ok(!body.includes(path), `${path} in rendered output`);
    assert.ok(
      !DEFERRED_ROUTES.some((entry) => entry.path === path),
      `${path} in DEFERRED_ROUTES`,
    );
  }
  const table = createRouteTable({ loadConfigView: async () => ({}) }, TOKEN);
  for (const route of table) {
    assert.ok(!route.path.startsWith("/_dashboard/sites/"), route.path);
  }
  // Nor may the word "application password" or a site token reach the markup.
  assert.ok(!/application[-_ ]?password/i.test(body));
  assert.ok(!body.includes("siteForm"));
});

/* -------------------------------------------------------------------------- */
/* E. The patch catalog (rules 27-32; Go rules 0-4)                           */
/* -------------------------------------------------------------------------- */

/** The 6a renderer for each catalogued fragment. 6b adds rows, not code. */
const FRAGMENT_RENDERERS = {
  main: () => renderMain("providers", html`<section class="page"></section>`),
  nav: () => renderNav("providers"),
  toast: () => renderToast({ level: "ok", message: "done" }),
};

test("27: the catalog is non-empty and every selector id is a legal target", () => {
  assert.ok(SSE_PATCH_FRAGMENTS.length > 0, "Go's `found == 0` guard");
  for (const fragment of SSE_PATCH_FRAGMENTS) {
    assert.match(fragment.selectorId, /^[a-z][a-z0-9-]*$/);
    assert.ok(["outer", "inner"].includes(fragment.mode), fragment.mode);
  }
  // Phase 7's fragments must not have crept in ahead of `src/doctor/`.
  assert.deepEqual(
    SSE_PATCH_FRAGMENTS.map(
      (fragment) => `${fragment.selectorId}/${fragment.mode}`,
    ),
    ["main/outer", "nav/outer", "toast/outer"],
  );
});

test("28: every catalogued fragment is rendered by a 6a view", async () => {
  const shell = await page(await dashboard(), "/providers");
  for (const fragment of SSE_PATCH_FRAGMENTS) {
    assert.ok(
      shell.includes(`id="${fragment.selectorId}"`),
      `${fragment.selectorId} has no element in the shell`,
    );
    assert.ok(
      FRAGMENT_RENDERERS[fragment.selectorId] !== undefined,
      `${fragment.selectorId} has no 6a renderer`,
    );
  }
});

test("29: every routed page carries main, nav and toast", async () => {
  const server = await dashboard();
  // Go's rule-1 table. 6b adds `provider-flash`, `sites-status`, `sites-result`
  // and `setup-work` rows; Phase 7 adds `diagnostics-output` and
  // `updates-card`. Extend the `ids` column, never the assertion.
  const pages = [
    { path: "/", ids: ["main", "nav", "toast"] },
    { path: "/providers", ids: ["main", "nav", "toast"] },
    { path: "/sites", ids: ["main", "nav", "toast"] },
    { path: "/deploy-paths", ids: ["main", "nav", "toast"] },
    { path: "/deploy-paths/new", ids: ["main", "nav", "toast"] },
    {
      path: "/novamira-setup?profile=dev&env=env-1",
      ids: ["main", "nav", "toast"],
    },
    { path: "/diagnostics", ids: ["main", "nav", "toast"] },
    { path: "/settings", ids: ["main", "nav", "toast"] },
  ];
  for (const entry of pages) {
    const markup = await page(server, entry.path);
    for (const id of entry.ids)
      assert.ok(markup.includes(`id="${id}"`), `${entry.path} ${id}`);
    // `#toast` is a sibling of `.shell`, outside it, and `data-signals` sits on
    // `.shell` — an outer patch of `#main` or `#nav` must not destroy either.
    assert.match(markup, /<div class="shell" data-signals="[^"]*">/);
    assert.ok(markup.indexOf('id="toast"') > markup.indexOf("</div>"));
    assert.ok(markup.indexOf('id="nav"') < markup.indexOf('id="main"'));
  }
});

/** Drive `streamSse` with a `ServerResponse`-shaped stub; Go's `sseBody`. */
async function sseBody(handler) {
  const message = new EventEmitter();
  let written = "";
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    getHeader: () => undefined,
    writeHead: () => response,
    flushHeaders: () => undefined,
    write: (chunk) => {
      written += chunk;
      return true;
    },
    end: () => undefined,
  };
  await streamSse(message, response, handler);
  return written;
}

/** Go's `ssePatchBlock`, verbatim in behaviour. */
function ssePatchBlock(body, selectorId, mode) {
  for (const block of body.split("\n\n")) {
    if (
      !block.includes("event: datastar-patch-elements\n") ||
      !block.includes(`data: selector #${selectorId}\n`)
    )
      continue;
    const hasInner = block.includes("data: mode inner\n");
    if (mode === "inner" && hasInner) return block;
    if (mode === "outer" && !hasInner) return block;
  }
  return "";
}

test("30: an outer fragment's root carries its own id; an inner one has no wrapper", async () => {
  const body = await sseBody((stream) => {
    for (const fragment of SSE_PATCH_FRAGMENTS)
      stream.patchElements(FRAGMENT_RENDERERS[fragment.selectorId](), {
        selectorId: fragment.selectorId,
        mode: fragment.mode,
      });
    // 6a catalogs no inner fragment, so the inner branch is exercised with the
    // shape 6b's `sites-status` will have: a body with no wrapper of its own.
    stream.patchElements(html`<li>row</li>`, {
      selectorId: "main",
      mode: "inner",
    });
  });
  for (const fragment of SSE_PATCH_FRAGMENTS) {
    const block = ssePatchBlock(body, fragment.selectorId, fragment.mode);
    assert.notEqual(block, "", `${fragment.selectorId}/${fragment.mode}`);
    if (fragment.mode === "outer")
      assert.ok(
        block.includes(`id="${fragment.selectorId}"`),
        `outer patch for ${fragment.selectorId} has no matching root id`,
      );
    else
      assert.ok(
        !block.includes(`id="${fragment.selectorId}"`),
        `inner patch for ${fragment.selectorId} must not carry a wrapper`,
      );
  }
  const inner = ssePatchBlock(body, "main", "inner");
  assert.notEqual(inner, "");
  assert.ok(!inner.includes('id="main"'));
  assert.ok(inner.includes("data: elements <li>row</li>"));
});

test("31: connCellId is hex, selector-safe and injective", () => {
  const id = connCellId("prod.us:blue/slash");
  assert.match(id, /^conn-[0-9a-f]+$/);
  for (const character of [".", ":", "/"])
    assert.ok(!id.includes(character), character);
  assert.match(connCellId("prôd-ü"), /^conn-[0-9a-f]+$/);
  const seen = new Set();
  for (const profile of ["a-b", "ab", "prod", "prod2", "a.b", "a_b", "é"]) {
    const value = connCellId(profile);
    assert.equal(seen.has(value), false, `${profile} collided`);
    seen.add(value);
  }
  assert.throws(() => connCellId(""), isInternalError);
});

test("32: patchElements prepends the # itself, so one id serves all three", async () => {
  const body = await sseBody((stream) => {
    stream.patchElements(renderMain("providers", html`<p>x</p>`), {
      selectorId: "main",
      mode: "outer",
    });
  });
  assert.ok(body.includes("data: selector #main\n"));
  assert.ok(!body.includes("##main"));
  assert.ok(!body.includes("data: mode"));
  const block = ssePatchBlock(body, "main", "outer");
  assert.ok(block.includes('id="main"'));
  const catalogued = SSE_PATCH_FRAGMENTS.find(
    (fragment) => fragment.selectorId === "main",
  );
  assert.equal(catalogued.mode, "outer");
});

/* -------------------------------------------------------------------------- */
/* F. The root signal object (rules 33-39; Go rule 5)                         */
/* -------------------------------------------------------------------------- */

/** Go's `datastarSignals`: the first `data-signals` value, parsed. */
function rootSignals(markup) {
  const values = attrValues(markup, "data-signals");
  assert.ok(
    values.length > 0,
    "rendered dashboard has no data-signals attribute",
  );
  return JSON.parse(values[0]);
}

test("33: the root signal object carries exactly the seven keys, and no siteForm", async () => {
  const signals = rootSignals(await page(await dashboard(), "/sites?new=site"));
  assert.deepEqual(Object.keys(signals).sort(), [
    "deployForm",
    "diagnostics",
    "providerForm",
    "setup",
    "sites",
    "token",
    "updates",
  ]);
  assert.ok(!("siteForm" in signals));
});

test("34: signals.token is the server's token", async () => {
  const server = await dashboard();
  const signals = rootSignals(await page(server, "/providers"));
  assert.equal(signals.token, server.token);
  assert.equal(signals.token, TOKEN);
});

test("35: ?new=host opens the provider form; ?new=site opens nothing", async () => {
  const server = await dashboard();
  assert.equal(
    rootSignals(await page(server, "/providers?new=host")).providerForm.open,
    true,
  );
  assert.equal(
    rootSignals(await page(server, "/providers")).providerForm.open,
    false,
  );
  const siteVariant = rootSignals(await page(server, "/sites?new=site"));
  assert.equal(siteVariant.providerForm.open, false);
  assert.equal("siteForm" in siteVariant, false);
  // An unknown value is ignored in silence rather than turned into an error.
  assert.equal(
    rootSignals(await page(server, "/providers?new=whatever")).providerForm
      .open,
    false,
  );
});

test("36: the site browser defaults to every provider, environments included", async () => {
  const signals = rootSignals(await page(await dashboard(), "/sites"));
  assert.equal(signals.sites.profile, ALL_PROFILES_SENTINEL);
  assert.equal(signals.sites.profile, "__all__");
  assert.equal(signals.sites.includeEnvs, true);
  assert.equal(signals.sites.loading, false);
  assert.equal(signals.sites.search, "");
});

test("37: diagnostics.profile is empty — no implicit provider selection", async () => {
  const signals = rootSignals(await page(await dashboard(), "/diagnostics"));
  assert.equal(signals.diagnostics.profile, "");
});

test("38: setup.enableAiAbilities defaults to true", async () => {
  const signals = rootSignals(await page(await dashboard(), "/novamira-setup"));
  assert.equal(signals.setup.enableAiAbilities, true);
});

test("39: the rendered data-signals round-trips to defaultDashboardSignals", async () => {
  const server = await dashboard();
  assert.deepEqual(
    rootSignals(await page(server, "/settings")),
    defaultDashboardSignals(server.token),
  );
  assert.deepEqual(
    rootSignals(await page(server, "/providers?new=host")),
    defaultDashboardSignals(server.token, { openProviderForm: true }),
  );
  // Every member is written out explicitly: Go relied on struct zero values,
  // and a missing key here would let a `data-bind` create a signal at runtime.
  const raw = JSON.stringify(defaultDashboardSignals("t"));
  for (const key of [
    "pushDb",
    "searchReplace",
    "credentialEnv",
    "apiBaseUrl",
    "force",
    "installing",
  ])
    assert.ok(raw.includes(`"${key}"`), key);
});

/* -------------------------------------------------------------------------- */
/* The remaining expression constructors                                      */
/* -------------------------------------------------------------------------- */

test("the expression constructors emit exactly the documented source", () => {
  assert.equal(renderExpr(jsNumber(7)), "7");
  assert.throws(() => jsNumber(Number.NaN), isInternalError);
  assert.throws(() => jsNumber(Number.POSITIVE_INFINITY), isInternalError);
  assert.equal(renderExpr(jsBoolean(false)), "false");
  assert.equal(renderExpr(signal("sites.loading")), "$sites.loading");
  assert.equal(
    renderExpr(set("sites.search", jsString("x"))),
    '$sites.search = "x"',
  );
  assert.equal(renderExpr(not(signal("sites.loading"))), "!$sites.loading");
  assert.equal(
    renderExpr(toggle("providerForm.open")),
    "$providerForm.open = !$providerForm.open",
  );
  assert.equal(
    renderExpr(
      objectExpr({
        active: jsBoolean(true),
        open: signal("providerForm.open"),
      }),
    ),
    "{active: true, open: $providerForm.open}",
  );
  assert.throws(
    () => objectExpr({ "a-b": jsBoolean(true) }),
    isInternalError,
    "an object key must be a legal identifier",
  );
  assert.equal(renderExpr(seq(jsBoolean(true), jsNumber(1))), "true; 1");
  assert.equal(
    renderExpr(confirmThen('Remove "dev"?', jsBoolean(true))),
    'confirm("Remove \\"dev\\"?") && (true)',
  );
  assert.equal(
    renderAttr(ds.classes({ active: signal("providerForm.open") })),
    ' data-class="{active: $providerForm.open}"',
  );
  assert.equal(
    renderAttr(ds.attrs({ disabled: signal("sites.loading") })),
    ' data-attr="{disabled: $sites.loading}"',
  );
  assert.equal(
    renderAttr(ds.text(jsString("hi"))),
    ' data-text="&quot;hi&quot;"',
  );
  assert.equal(
    renderAttr(ds.init(set("sites.loading", jsBoolean(false)))),
    ' data-init="$sites.loading = false"',
  );
});

test("no secret-shaped value can reach the markup, a URL or an SSE frame", async () => {
  const secret = "sk-live-51H-provider-token";
  const body = await corpus();
  assert.ok(!body.includes(secret));
  // The only signal that ever holds a secret starts empty and is never rendered
  // back: the value travels in a request body, straight to the credential store.
  const signals = rootSignals(await page(await dashboard(), "/providers"));
  assert.equal(signals.providerForm.credentialValue, "");
  // A URL cannot carry one either: `url()` is the only constructor, and the
  // conventions above make a query value impossible to smuggle past encoding.
  const target = url("/providers", { profile: secret });
  assert.ok(renderUrl(target).includes(encodeURIComponent(secret)));
  const frame = await sseBody((stream) => {
    stream.patchElements(renderToast({ level: "ok", message: "saved" }), {
      selectorId: "toast",
      mode: "outer",
    });
  });
  assert.ok(!frame.includes(secret));
  assert.ok(
    !frame.includes(TOKEN),
    "the mutation token never travels on the wire",
  );
});

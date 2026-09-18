// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { copyReport, renderExpr } from "../dist/web/expr.js";
import { fragmentUrl, url, renderUrl, renderHtml } from "../dist/web/html.js";
import { renderNav, renderSidebar } from "../dist/web/views/layout.js";
import { renderProviderForm } from "../dist/web/views/providers.js";
import { renderAiLogo } from "../dist/web/views/ai-logos.js";
import { renderSitesPage } from "../dist/web/views/sites.js";

test("Sites header opens manual site entry directly without another menu", () => {
  const markup = renderHtml(renderSitesPage({ profiles: [], pushes: [] }));
  const header = markup.match(
    /<header class="page-head">(.*?)<\/header>/s,
  )?.[0];
  assert.ok(
    header.includes(
      'class="button primary" href="/sites?new=cli">Add site manually</a>',
    ),
  );
  assert.ok(!header.includes("<details"));
  assert.ok(!header.includes("data-on"));
  const sidebar = renderHtml(renderSidebar({}, "sites"));
  assert.ok(sidebar.includes(">Add site</button>"));
  assert.ok(
    sidebar.indexOf(">Manually<") < sidebar.indexOf(">From a hosting account<"),
  );
});

test("all AI client logos inherit the monochrome text color", () => {
  for (const client of ["vscode", "cursor", "opencode", "openai", "claude"]) {
    const markup = renderHtml(renderAiLogo(client));
    assert.match(markup, /fill="currentColor"/);
    assert.doesNotMatch(markup, /fill="#|linearGradient|<filter|<mask/);
  }
});

test("failed dashboard requests produce an inline notice without exposing response data", () => {
  const listeners = {};
  const target = {};
  runInNewContext(
    readFileSync(
      new URL("../src/web/static/ui-feedback.js", import.meta.url),
      "utf8",
    ),
    {
      window: {},
      document: {
        getElementById: () => target,
        addEventListener: (name, callback) => {
          listeners[name] = callback;
        },
      },
    },
  );
  listeners["datastar-fetch"]({
    detail: { type: "error", argsRaw: { status: "403", body: "secret" } },
  });
  assert.match(target.textContent, /Reload the page/);
  assert.doesNotMatch(target.textContent, /secret/);
  assert.equal(target.className, "toast show warn");
  listeners["datastar-fetch"]({ detail: { type: "retries-failed" } });
  assert.match(target.textContent, /Do not repeat/);
});

test("the hosting connection progress label uses the hidden-by-default loading style", () => {
  const markup = renderHtml(renderProviderForm(true));
  assert.match(markup, /class="loading-inline ds-toggle"[^>]*>Connecting…/);
});

test("responsive navigation stays visible and Push follows Hosting accounts", () => {
  const nav = renderHtml(renderNav("pushes"));
  assert.ok(nav.indexOf("Hosting accounts") < nav.indexOf(">Push<"));
  assert.doesNotMatch(
    renderHtml(renderSidebar({}, "sites")),
    /mobile-menu-button|menuOpen/,
  );
  const css = readFileSync(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.toast \{\s*display: none;\s*position: static;/);
  assert.match(css, /\.sidebar-navigation \.sidebar-foot \{ display: none;/);
  assert.match(
    css,
    /\.main-providers \.table-panel td\.actions \{ display: flex; flex-wrap: wrap;/,
  );
});

test("history anchors encode IDs separately from the page path", () => {
  assert.equal(
    renderUrl(fragmentUrl(url("/hosting-activity"), "request-a#b")),
    "/hosting-activity#request-a%23b",
  );
});

test("report copy gives inline feedback for success and clipboard failures", async () => {
  for (const outcome of ["success", "rejected", "unavailable"]) {
    const feedback = { textContent: "" };
    let copied;
    const context = {
      document: {
        getElementById: (id) =>
          id === "report"
            ? { textContent: "Readable report\nstatus: warn" }
            : feedback,
      },
      navigator:
        outcome === "unavailable"
          ? {}
          : {
              clipboard: {
                writeText: async (text) => {
                  if (outcome === "rejected") throw new Error("denied");
                  copied = text;
                },
              },
            },
    };
    runInNewContext(renderExpr(copyReport("report", "feedback")), context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(
      feedback.textContent,
      outcome === "success" ? /Report copied/ : /Could not copy/,
    );
    if (outcome === "success")
      assert.equal(copied, "Readable report\nstatus: warn");
  }
});

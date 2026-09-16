// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderSiteConnectSuccess } from "../dist/web/views/site-profiles.js";
import { renderMcpPage } from "../dist/web/views/mcp.js";
import { renderNav } from "../dist/web/views/layout.js";

test("client selection uses full page width and instructions use narrow content", () => {
  const view = { profiles: [], pushes: [] };
  assert.ok(renderHtml(renderMcpPage(view)).includes('class="page mcp-page"'));
  assert.ok(
    renderHtml(renderMcpPage(view, undefined, "claude")).includes(
      'class="page flow-page mcp-page"',
    ),
  );
});

test("primary navigation no longer includes the generic how-to page", () => {
  const markup = renderHtml(renderNav("sites"));
  assert.ok(!markup.includes("How to use it"));
  assert.ok(!markup.includes('href="/how-to-use"'));
  assert.ok(markup.includes("Connect your AI"));
});

test("all page types share an outer container and left-aligned narrow content", () => {
  const css = readFileSync(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.page \{[^}]*max-width: 1360px;[^}]*--flow-width: 760px;/,
  );
  assert.match(
    css,
    /\.form-panel \{[^}]*width: 100%;[^}]*max-width: var\(--flow-width, 760px\);[^}]*justify-self: start;/,
  );
  assert.match(css, /\.flow-page > :not\(\.page-head\)/);
  assert.ok(!css.includes("max-width: 620px"));
  assert.ok(!css.includes(".connect-success-page { max-width:"));
});

test("connection success uses the shared page header above its result panel", () => {
  const markup = renderHtml(
    renderSiteConnectSuccess({
      siteUrl: "https://example.test",
      profileName: "Example",
    }),
  );
  assert.ok(markup.includes('<header class="page-head">'));
  assert.ok(
    markup.indexOf("</header>") <
      markup.indexOf('class="how-to-card connect-success"'),
  );
  assert.equal(markup.split("<h1").length - 1, 1);
});

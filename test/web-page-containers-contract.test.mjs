// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderSiteConnectSuccess } from "../dist/web/views/site-profiles.js";
import { renderMcpPage, MCP_PAGE_CLIENTS } from "../dist/web/views/mcp.js";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import { renderNav } from "../dist/web/views/layout.js";

test("AI client selection and every instruction page share the same full-width container", () => {
  const view = { profiles: [], pushes: [] };
  const configuration = createMcpConnectionService(
    { command: "novamira-hq", args: ["mcp"] },
    {},
  ).configuration();
  for (const client of [undefined, ...MCP_PAGE_CLIENTS]) {
    for (const config of [undefined, configuration]) {
      const markup = renderHtml(renderMcpPage(view, config, client));
      assert.ok(markup.includes('class="page mcp-page"'));
      assert.ok(!markup.includes("flow-page"));
      if (config || client === undefined) {
        assert.equal(
          markup.split("<svg ").length - 1,
          client === undefined ? 7 : 1,
        );
        assert.ok(markup.includes('aria-hidden="true"'));
        assert.ok(!markup.includes('class="mcp-choice-mark">O</span>'));
        assert.ok(!markup.includes('class="mcp-choice-mark">A</span>'));
      }
    }
  }
  const css = readFileSync(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.ok(
    css.includes(".mcp-page { grid-template-columns: minmax(0, 1fr); }"),
  );
  assert.match(css, /\.mcp-config\s*\{[^}]*overflow-x: auto;/);
});

test("primary navigation no longer includes the generic how-to page", () => {
  const markup = renderHtml(renderNav("sites"));
  assert.ok(!markup.includes("How to use it"));
  assert.ok(!markup.includes('href="/how-to-use"'));
  assert.ok(markup.includes("Configure your AI"));
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
  assert.match(
    css,
    /input::placeholder,\s*textarea::placeholder\s*\{[^}]*color: #757575;[^}]*font-weight: 400;[^}]*opacity: 1;/,
  );
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

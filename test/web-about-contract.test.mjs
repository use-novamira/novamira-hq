// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderAboutPage } from "../dist/web/views/about.js";
import { renderSidebar } from "../dist/web/views/layout.js";

test("About text links inherit text color and stay underlined", () => {
  const css = readFileSync(
    new URL("../dist/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.about-page \.text-link\s*\{[^}]*color: inherit;[^}]*text-decoration: underline;/,
  );
});

test("About displays the running version, attribution, license and fixed links", () => {
  const markup = renderHtml(renderAboutPage({ version: "9.8.7-test" }));
  for (const text of [
    "About Novamira HQ",
    "9.8.7-test",
    "<dt>Developed by</dt><dd>Dynamic.ooo</dd>",
    "Ovation S.r.l.",
    "© 2026",
    "AGPL-3.0-or-later",
    "GNU LGPL-2.1-or-later",
    "Copyright (C) 2001-2022 Free Software Foundation, Inc.",
    "LGPL license, third-party notices and source offer",
    "at least three years after our last distribution",
    "Legal notices",
    'class="page flow-page about-page"',
    'class="details-list about-details"',
    '<footer class="button-row about-actions">',
    'href="/assets/third-party-notices.txt"',
    'href="/updates"',
    'href="https://novamira.ai"',
    'href="https://github.com/use-novamira/novamira-hq"',
  ])
    assert.ok(markup.includes(text), text);
  assert.ok(
    renderHtml(renderAboutPage({ version: "<unsafe>" })).includes(
      "&lt;unsafe&gt;",
    ),
  );
});

test("sidebar footer contains App updates, About and the actual app version", () => {
  const markup = renderHtml(renderSidebar({ version: "9.8.7-test" }, "about"));
  assert.ok(
    markup.includes('class="sidebar-about" href="/about" aria-current="page"'),
  );
  assert.ok(
    markup.includes('<small class="sidebar-version">v9.8.7-test</small>'),
  );
  const footer = markup.match(/<div class="sidebar-foot">(.*?)<\/div>/s)?.[0];
  assert.ok(footer.includes('href="/updates"'));
  assert.ok(!markup.includes("AGPL-3.0-or-later"));
  assert.ok(!markup.includes("© 2026"));
});

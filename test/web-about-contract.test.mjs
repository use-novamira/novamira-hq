// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderAboutPage } from "../dist/web/views/about.js";
import { renderSidebar } from "../dist/web/views/layout.js";

test("About displays the running version, attribution, license and fixed links", () => {
  const markup = renderHtml(renderAboutPage({ version: "9.8.7-test" }));
  for (const text of [
    "About Novamira HQ",
    "9.8.7-test",
    "Ovation S.r.l.",
    "© 2026",
    "AGPL-3.0-or-later",
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

test("sidebar footer contains App updates and About instead of version and legal text", () => {
  const markup = renderHtml(renderSidebar({ version: "9.8.7-test" }, "about"));
  assert.ok(
    markup.includes('class="sidebar-about" href="/about" aria-current="page"'),
  );
  assert.ok(!markup.includes("9.8.7-test"));
  const footer = markup.match(/<div class="sidebar-foot">(.*?)<\/div>/s)?.[0];
  assert.ok(footer.includes('href="/updates"'));
  assert.ok(!markup.includes("AGPL-3.0-or-later"));
  assert.ok(!markup.includes("© 2026"));
});

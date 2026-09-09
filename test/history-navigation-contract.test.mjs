// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderNav } from "../dist/web/views/layout.js";
import { renderDiagnosticsPage } from "../dist/web/views/diagnostics.js";
import { renderHistoryPage } from "../dist/web/views/history.js";

test("hosting history belongs to Diagnostics rather than the main navigation", () => {
  const nav = renderHtml(renderNav("history"));
  assert.doesNotMatch(nav, /href="\/history"/);
  assert.equal(nav, renderHtml(renderNav("diagnostics")));
  const diagnostics = renderHtml(renderDiagnosticsPage({ profiles: [] }));
  assert.match(diagnostics, /href="\/history"/);
  assert.match(diagnostics, /Hosting history/);
  assert.match(diagnostics, /Does not include WordPress operations/);
  const history = renderHtml(renderHistoryPage([]));
  assert.match(history, /Hosting history/);
  assert.match(history, /Back to Diagnostics/);
});

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderNav } from "../dist/web/views/layout.js";
import { renderDiagnosticsPage } from "../dist/web/views/diagnostics.js";
import { renderHistoryPage } from "../dist/web/views/history.js";

test("account activity filters requests, attention and the copyable report", () => {
  const entries = ["first", "second"].map((profile) => ({
    id: profile,
    profile,
    provider: "kinsta",
    action: "run-wp-cli",
    channel: "dashboard",
    status: "needs_verification",
    startedAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
  }));
  const markup = renderHtml(renderHistoryPage(entries, "first", ["empty"]));
  assert.match(markup, /Needs attention \(1\)/);
  assert.equal((markup.match(/class="history-request"/g) ?? []).length, 1);
  assert.match(markup, /id="request-first"/);
  assert.doesNotMatch(markup, /id="request-second"|"profile": "second"/);
  assert.match(markup, /href="\/hosting-activity\?profile=first"/);
  assert.doesNotMatch(markup, /history-attention/);
  assert.match(markup, /All accounts/);
  assert.match(markup, /value="empty"/);
  assert.match(
    renderHtml(renderHistoryPage(entries, "empty")),
    /No hosting actions yet/,
  );
  assert.equal(
    (
      renderHtml(renderHistoryPage(entries)).match(
        /class="history-request"/g,
      ) ?? []
    ).length,
    2,
  );
});

test("hosting history belongs to Hosting accounts rather than the main navigation", () => {
  const nav = renderHtml(renderNav("history"));
  assert.doesNotMatch(nav, /href="\/history"/);
  assert.equal(nav, renderHtml(renderNav("providers")));
  const diagnostics = renderHtml(renderDiagnosticsPage({ profiles: [] }));
  assert.doesNotMatch(diagnostics, /href="\/history"/);
  const history = renderHtml(renderHistoryPage([]));
  assert.match(history, /Hosting history/);
  assert.match(history, /href="\/hosting-accounts">Hosting accounts/);
});

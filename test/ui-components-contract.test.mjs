// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { html, renderHtml, url } from "../dist/web/html.js";
import { getStream } from "../dist/web/expr.js";
import {
  pageHeader,
  panel,
  actionButton,
  field,
  technicalDetails,
  endpoint,
} from "../dist/web/views/components.js";
import { renderRestore } from "../dist/web/views/restore.js";
import { renderBackupCreate } from "../dist/web/views/backup-create.js";

test("shared components escape content and own consistent page/panel structure", () => {
  const result = renderHtml(
    html`${pageHeader("<script>bad</script>")}${panel(field("License", html`<input type="password">`), { title: "Title" })}${technicalDetails(html`<p>Details</p>`)}${endpoint("Source", "https://example.com")}`,
  );
  assert.ok(!result.includes("<script>"));
  assert.match(result, /class="page-head"/);
  assert.match(result, /class="ui-panel-body"/);
  assert.match(result, /class="ui-field"/);
  assert.match(result, /Technical details/);
  assert.match(result, /<strong>example.com<\/strong>/);
});
test("shared action always disables and displays progress while running", () => {
  const result = renderHtml(
    actionButton({
      label: "Check result",
      busy: "pushForm.submitting",
      action: getStream(
        url("/_dashboard/pushes/status", { job: "test", refresh: "1" }),
        { include: [] },
      ),
      pending: "Checking previous push…",
    }),
  );
  assert.match(result, /data-attr/);
  assert.match(result, /disabled/);
  assert.match(result, /data-indicator/);
  assert.match(result, /Checking previous push/);
  assert.match(result, /role="status"/);
});
test("backup pages auto-load read-only preparation, never auto-apply or retry errors", () => {
  const target = { profile: "host", site: "site", env: "env" };
  for (const render of [renderBackupCreate, renderRestore]) {
    const initial = renderHtml(render({ target }));
    assert.match(initial, /data-init/);
    assert.ok(!initial.includes("/_dashboard/backups/apply"));
    const failed = renderHtml(render({ target, error: "Unavailable" }));
    assert.ok(!failed.includes("data-init"));
    assert.match(failed, /Try again/);
    assert.ok(!failed.includes("Loading available backups"));
    assert.ok(!failed.includes("Loading site details"));
    assert.match(failed, /ui-panel-body/);
  }
});

test("backup and restore outcomes use shared panels without misleading refresh actions", () => {
  const target = { profile: "host", site: "site", env: "env" };
  for (const operation of ["create", "restore"]) {
    const review = {
      ...target,
      id: "confirmation",
      operation,
      provider: "instawp",
      targetUrl: "https://example.com",
      backupId: "backup-123",
      expiresAt: Date.now() + 60000,
    };
    for (const status of ["running", "completed", "needs_verification"]) {
      const markup = renderHtml(
        renderRestore({ target, job: { review, status } }),
      );
      assert.match(markup, /ui-panel-body/);
      assert.match(markup, /<strong>example.com<\/strong>/);
      assert.match(markup, /Technical details/);
      assert.ok(!markup.includes("Refresh status"));
      assert.equal(markup.includes("data-init"), status === "running");
      assert.ok(!markup.includes("/_dashboard/backups/apply"));
      if (status === "needs_verification")
        assert.match(markup, /could not confirm whether/);
    }
    const confirmation = renderHtml(renderRestore({ target, review }));
    assert.ok(!confirmation.includes("data-init"));
    assert.match(confirmation, /data-indicator/);
    assert.match(confirmation, /\/_dashboard\/backups\/apply/);
    if (operation === "restore")
      assert.match(confirmation, /All files and the database.*overwritten/);
  }
});

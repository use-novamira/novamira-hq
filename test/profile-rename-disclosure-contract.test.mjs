// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import {
  renderSiteProfileRow,
  renderSiteProfileActions,
} from "../dist/web/views/site-profiles.js";

test("manual site labels omit the scheme without changing connection URLs", () => {
  for (const scheme of ["https", "http"]) {
    const siteUrl = `${scheme}://test.local:8890/wordpress`;
    const row = { name: "local", siteUrl, state: "reconnect_required" };
    for (const context of [undefined, { profile: "", includeEnvs: true }]) {
      const markup = renderHtml(renderSiteProfileRow(row, context));
      assert.match(
        markup,
        /<small(?: class="cli-site-url")?>test\.local:8890\/wordpress<\/small>/,
      );
      assert.ok(markup.includes(encodeURIComponent(siteUrl)));
      assert.equal(row.siteUrl, siteUrl);
    }
  }
});

test("profile rename and destructive actions are hidden in one closed menu", () => {
  const row = {
    name: "example",
    siteUrl: "https://example.com",
    state: "connected",
  };
  const context = { profile: "hosting", includeEnvs: true };
  for (const view of [
    renderSiteProfileRow(row),
    renderSiteProfileRow(row, context),
    renderSiteProfileActions(row, context),
  ]) {
    const markup = renderHtml(view);
    assert.match(markup, /<details class="profile-menu">/);
    assert.match(markup, /More actions for example/);
    assert.match(markup, /<div class="profile-menu-popover">/);
    assert.match(
      markup,
      /<details class="profile-rename"><summary[^>]*>Rename<\/summary><form/,
    );
    assert.match(markup, /Save name/);
    assert.match(markup, />Disconnect<\/button>/);
    assert.doesNotMatch(markup, /<details[^>]*\sopen(?:\s|=|>)/);
    assert.match(markup, /site-profiles\/rename/);
    const menuStart = markup.indexOf('<details class="profile-menu">');
    const menuEnd = markup.lastIndexOf("</details>");
    assert.ok(menuStart >= 0 && menuEnd > menuStart);
    const menu = markup.slice(menuStart, menuEnd);
    assert.match(menu, />Disconnect<\/button>/);
  }
  assert.match(
    renderHtml(renderSiteProfileRow(row)),
    />Remove from list<\/button>/,
  );
  assert.match(
    renderHtml(renderSiteProfileRow(row)),
    /To add it again, use Connect/,
  );
  assert.doesNotMatch(
    renderHtml(renderSiteProfileActions(row, context)),
    /site-profiles\/remove/,
  );
});

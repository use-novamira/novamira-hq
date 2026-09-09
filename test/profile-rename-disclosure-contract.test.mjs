// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import {
  renderSiteProfileRow,
  renderSiteProfileActions,
} from "../dist/web/views/site-profiles.js";

test("profile rename is hidden behind closed actions and Rename disclosures", () => {
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
    assert.match(markup, /<summary[^>]*>Rename<\/summary><form/);
    assert.match(markup, /Save name/);
    assert.doesNotMatch(markup, /<details[^>]*\sopen(?:\s|=|>)/);
    assert.match(markup, /site-profiles\/rename/);
  }
});

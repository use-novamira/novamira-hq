// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderConnectForm } from "../dist/web/views/site-profiles.js";

test("manual connection tracks the form request and shows progress until it finishes", () => {
  const markup = renderHtml(renderConnectForm(true, true, true));
  assert.match(markup, /<form[^>]*data-indicator="cliSites.loading"/);
  assert.match(
    markup,
    /<button[^>]*data-attr="\{disabled: \$cliSites.loading\}"/,
  );
  assert.match(markup, /Connecting…/);
  assert.match(
    markup,
    /<p[^>]*data-class="\{open: \$cliSites.loading\}"[^>]*role="status">Waiting for authorization/,
  );
});

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderSidebar } from "../dist/web/views/layout.js";
import { renderHtml } from "../dist/web/html.js";
import { ariaBoolean, signal, renderExpr } from "../dist/web/expr.js";

test("ARIA state expressions return strings rather than HTML boolean attributes", () => {
  const expression = renderExpr(ariaBoolean(signal("sites.newMenuOpen")));
  assert.equal(
    runInNewContext(expression, { $sites: { newMenuOpen: true } }),
    "true",
  );
  assert.equal(
    runInNewContext(expression, { $sites: { newMenuOpen: false } }),
    "false",
  );
});

test("Add site is a disclosure with an announced state, not an incomplete ARIA menu", () => {
  const markup = renderHtml(renderSidebar({}, "sites"));
  assert.match(
    markup,
    /aria-expanded="false" aria-controls="add-site-options"/,
  );
  assert.match(markup, /id="add-site-options"/);
  assert.doesNotMatch(markup, /role="menu"|aria-haspopup="menu"/);
});

test("browser title follows streamed heading changes", async () => {
  const source = await readFile(
    new URL("../src/web/static/ui-feedback.js", import.meta.url),
    "utf8",
  );
  let observe;
  const heading = { textContent: "Push" };
  const document = {
    title: "",
    querySelector: (selector) => (selector === "#main h1" ? heading : {}),
    addEventListener() {},
  };
  runInNewContext(source, {
    document,
    window: {},
    MutationObserver: class {
      constructor(callback) {
        observe = callback;
      }
      observe() {}
    },
  });
  assert.equal(document.title, "Push — Novamira HQ");
  heading.textContent = "Push history";
  observe();
  assert.equal(document.title, "Push history — Novamira HQ");
});

test("shared styles provide contrasting focus and reduced motion", async () => {
  const css = await readFile(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /#main :is\([^\n]+:focus-visible[^\n]+var\(--gold-ink\)/);
  assert.match(
    css,
    /prefers-reduced-motion: reduce[^}]+animation: none !important; transition: none !important/s,
  );
  assert.match(css, /\.skip-link:focus[^}]+transform: none/);
});

test("Escape closes Add site and restores focus to its trigger", async () => {
  const source = await readFile(
    new URL("../src/web/static/ui-feedback.js", import.meta.url),
    "utf8",
  );
  const listeners = {};
  let closed = false;
  let focused = false;
  let prevented = false;
  const trigger = {
    click() {
      closed = true;
    },
    focus() {
      focused = true;
    },
  };
  const document = {
    querySelector: (selector) =>
      selector.startsWith(".new-button") ? trigger : null,
    querySelectorAll: () => [],
    addEventListener: (name, callback) => {
      listeners[name] = callback;
    },
  };
  runInNewContext(source, { document, window: {} });
  listeners.keydown({
    key: "Escape",
    preventDefault() {
      prevented = true;
    },
  });
  assert.ok(closed && focused && prevented);
});

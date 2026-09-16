// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../src/web/static/sites-filter.js", import.meta.url),
  "utf8",
);

test("inventory rows share column geometry and reserve pills for passive states", () => {
  const css = readFileSync(
    new URL("../src/web/static/app.css", import.meta.url),
    "utf8",
  );
  assert.ok(css.includes("--site-columns: 240px minmax(0, 1fr) auto"));
  assert.ok(css.includes(".provider-sites .site-row:not(.site-row-multi),"));
  assert.ok(
    css.includes(
      ".provider-sites .env-subrow { display: grid; grid-template-columns: var(--site-columns)",
    ),
  );
  assert.ok(!css.includes("grid-template-columns: subgrid"));
  assert.ok(!css.includes(".status-action"));
});

function browser(storage, blocked = false) {
  const classes = () => {
    const values = new Set();
    return {
      toggle: (name, on) => (on ? values.add(name) : values.delete(name)),
      contains: (name) => values.has(name),
      remove: (name) => values.delete(name),
    };
  };
  const events = {};
  const toggle = {
    checked: false,
    matches: (selector) => selector === ".show-hidden-sites",
  };
  const alerts = [];
  const counters = { with: {}, without: {} };
  const rows = ["hosting", "url"].map((kind) => {
    const row = {
      textContent: kind,
      classList: classes(),
      getAttribute: (name) =>
        name === "data-hosting-site-key"
          ? kind === "hosting"
            ? '["account","site"]'
            : null
          : "installed",
    };
    const button = { textContent: "", setAttribute() {}, closest: () => row };
    row.querySelectorAll = () => (kind === "hosting" ? [button] : []);
    row.button = button;
    return row;
  });
  const group = { classList: classes(), querySelectorAll: () => rows };
  const document = {
    body: {},
    readyState: "complete",
    addEventListener: (name, fn) => {
      events[name] = fn;
    },
    querySelector: (selector) =>
      selector === ".show-hidden-sites"
        ? toggle
        : selector.includes('data-sf-count="with"')
          ? counters.with
          : selector.includes('data-sf-count="without"')
            ? counters.without
            : null,
    querySelectorAll: (selector) =>
      selector.includes(".site-group")
        ? [group]
        : selector.includes(".site-row[data-nm-state]")
          ? rows
          : [],
  };
  runInNewContext(source, {
    document,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (blocked) throw new Error("blocked");
        storage.set(key, value);
      },
    },
    window: { alert: (message) => alerts.push(message) },
  });
  return {
    rows,
    alerts,
    counters,
    click: () =>
      events.click({
        target: { closest: () => rows[0].button },
        preventDefault() {},
        stopPropagation() {},
      }),
    show: () => {
      toggle.checked = true;
      events.change({ target: toggle });
    },
  };
}

test("hosting visibility survives reload, excludes hidden rows from counts, and can be restored", () => {
  const storage = new Map();
  const first = browser(storage);
  first.click();
  assert.ok(first.rows[0].classList.contains("sf-hidden"));
  assert.ok(!first.rows[1].classList.contains("sf-hidden"));
  assert.equal(first.counters.with.textContent, "1");
  const reloaded = browser(storage);
  assert.ok(reloaded.rows[0].classList.contains("sf-hidden"));
  reloaded.show();
  assert.ok(!reloaded.rows[0].classList.contains("sf-hidden"));
  assert.equal(reloaded.rows[0].button.textContent, "Restore to list");
  reloaded.click();
  assert.ok(!browser(storage).rows[0].classList.contains("sf-hidden"));
});

test("blocked visibility storage never silently hides a site", () => {
  const page = browser(new Map(), true);
  page.click();
  assert.ok(!page.rows[0].classList.contains("sf-hidden"));
  assert.equal(page.alerts.length, 1);
});

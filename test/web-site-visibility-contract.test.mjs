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

function browser(storage, blocked = false, failDisconnect = false) {
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
  let confirmation;
  const calls = [];
  const window = {
    location: { reload() {} },
    novamiraUi: {
      notice: (message) => alerts.push(message),
      confirmAction: (message, action, label, choices) => {
        confirmation = { message, action, label, choices };
      },
    },
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
    window,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: !failDisconnect,
        json: async () => ({
          ok: !failDisconnect,
          data: { disconnected: true },
        }),
      };
    },
  });
  return {
    rows,
    alerts,
    counters,
    calls,
    confirmation: () => confirmation,
    approve: (selected = []) => confirmation.action(selected),
    click: (names = []) =>
      window.novamiraSites.hideSite(
        '["account","site"]',
        "Site — account",
        names,
        "test-token",
      ),
    show: () => {
      toggle.checked = true;
      events.change({ target: toggle });
    },
  };
}

test("hosting visibility survives reload and can be restored", async () => {
  const storage = new Map();
  const first = browser(storage);
  first.click();
  assert.ok(!first.rows[0].classList.contains("sf-hidden"));
  await first.approve();
  assert.ok(first.rows[0].classList.contains("sf-hidden"));
  assert.ok(!first.rows[1].classList.contains("sf-hidden"));
  const reloaded = browser(storage);
  assert.ok(reloaded.rows[0].classList.contains("sf-hidden"));
  reloaded.show();
  assert.ok(!reloaded.rows[0].classList.contains("sf-hidden"));
  assert.equal(reloaded.rows[0].button.textContent, "Restore to list");
  reloaded.click();
  assert.ok(!browser(storage).rows[0].classList.contains("sf-hidden"));
});

test("blocked visibility storage never silently hides a site", async () => {
  const page = browser(new Map(), true);
  page.click();
  await assert.rejects(page.approve());
  assert.ok(!page.rows[0].classList.contains("sf-hidden"));
  assert.equal(page.calls.length, 0);
});

test("disconnect is opt-in, explicitly scoped, and failure leaves the site visible", async () => {
  const hideOnly = browser(new Map());
  hideOnly.click(["first", "second"]);
  await hideOnly.approve();
  assert.equal(hideOnly.calls.length, 0);
  const page = browser(new Map());
  page.click(["first", "second"]);
  assert.equal(page.confirmation().choices.length, 2);
  assert.equal(page.calls.length, 0);
  await page.approve(["second"]);
  assert.equal(page.calls.length, 1);
  assert.ok(page.calls[0].url.endsWith("name=second"));
  assert.equal(
    page.calls[0].options.headers["X-Novamira-Dashboard-Token"],
    "test-token",
  );
  assert.ok(page.rows[0].classList.contains("sf-hidden"));
  const failed = browser(new Map(), false, true);
  failed.click(["first"]);
  await assert.rejects(failed.approve(["first"]));
  assert.ok(!failed.rows[0].classList.contains("sf-hidden"));
});

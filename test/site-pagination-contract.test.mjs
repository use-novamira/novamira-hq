// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Show more stays expanded after observer refreshes and replacement fragments", async () => {
  const script = await readFile(
    new URL("../src/web/static/sites-filter.js", import.meta.url),
    "utf8",
  );
  let refresh;
  let button;
  const makeRows = () =>
    Array.from({ length: 22 }, () => {
      const classes = new Set(["site-row"]);
      return {
        classList: {
          contains: (name) => classes.has(name),
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
        },
      };
    });
  const grid = {
    children: makeRows(),
    closest: () => ({ id: "inventory-hosting-example" }),
    querySelector: () => button,
    appendChild: (value) => {
      button = value;
    },
  };
  vm.runInNewContext(script, {
    document: {
      body: {},
      readyState: "complete",
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === "#sites-result .site-grid") return [grid];
        if (selector === ".sf-more") return button ? [button] : [];
        if (selector === ".site-row.sf-capped")
          return grid.children.filter((row) =>
            row.classList.contains("sf-capped"),
          );
        return [];
      },
      createElement: () => ({
        addEventListener(name, fn) {
          this.click = fn;
        },
        remove() {
          button = null;
        },
      }),
    },
    window: {},
    localStorage: { getItem: () => null },
    MutationObserver: class {
      constructor(fn) {
        refresh = fn;
      }
      observe() {}
      disconnect() {}
    },
  });
  const hidden = () =>
    grid.children.filter((row) => row.classList.contains("sf-capped")).length;
  assert.equal(hidden(), 10);
  assert.equal(button.textContent, "Show 10 more");
  button.click();
  assert.equal(hidden(), 0);
  refresh();
  assert.equal(hidden(), 0);
  assert.equal(button, null);
  grid.children = makeRows();
  refresh();
  assert.equal(hidden(), 0);
  assert.equal(button, null);
});

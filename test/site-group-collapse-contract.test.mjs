// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("inventory groups remember independent collapse state across patches and reloads", async () => {
  const script = await readFile(
    new URL("../src/web/static/sites-filter.js", import.meta.url),
    "utf8",
  );
  const storage = new Map();
  function page(blockStorage = false) {
    const groups = ["inventory-manual", "inventory-hosting-kinsta"].map(
      (id) => ({ id, open: true }),
    );
    const clicks = [];
    let patch;
    const document = {
      body: {},
      readyState: "complete",
      querySelector: () => null,
      querySelectorAll: (selector) =>
        selector === "details.inventory-group[id]" ? groups : [],
      addEventListener: (name, fn) => {
        if (name === "click") clicks.push(fn);
      },
    };
    vm.runInNewContext(script, {
      document,
      window: {},
      localStorage: {
        getItem: (key) => storage.get(key),
        setItem: (key, value) => {
          if (blockStorage) throw new Error("blocked");
          storage.set(key, value);
        },
      },
      MutationObserver: class {
        constructor(fn) {
          patch = fn;
        }
        observe() {}
        disconnect() {}
      },
    });
    return {
      groups,
      patch: () => patch(),
      click: (index) =>
        clicks.forEach((fn) =>
          fn({
            preventDefault() {},
            target: {
              closest: (selector) =>
                selector === "details.inventory-group > summary"
                  ? { parentElement: groups[index] }
                  : null,
            },
          }),
        ),
    };
  }
  const first = page();
  first.click(0);
  assert.equal(first.groups[0].open, false);
  assert.equal(first.groups[1].open, true);
  first.groups[0].open = true;
  first.patch();
  assert.equal(first.groups[0].open, false);
  const second = page();
  assert.equal(second.groups[0].open, false);
  second.click(0);
  second.click(1);
  const third = page();
  assert.equal(third.groups[0].open, true);
  assert.equal(third.groups[1].open, false);
  const blocked = page(true);
  blocked.click(0);
  blocked.patch();
  assert.equal(blocked.groups[0].open, false);
});

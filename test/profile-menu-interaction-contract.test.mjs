// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("profile menus are exclusive, close outside and on Escape, and return focus", async () => {
  const listeners = new Map();
  let focus;
  const menus = [0, 1, 2].map((id) => ({
    open: false,
    matches: (selector) => selector === "details.profile-menu",
    contains: (value) => value === id,
    querySelector: () => ({ focus: () => (focus = id) }),
  }));
  const document = {
    querySelector: () => null,
    activeElement: 1,
    addEventListener(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
    },
    querySelectorAll: () => menus.filter((menu) => menu.open),
  };
  vm.runInNewContext(
    await readFile(
      new URL("../src/web/static/ui-feedback.js", import.meta.url),
      "utf8",
    ),
    { document, window: {} },
  );
  const fire = (name, event) =>
    listeners.get(name).forEach((handler) => handler(event));
  menus[0].open = true;
  menus[1].open = true;
  fire("toggle", { target: menus[1] });
  assert.equal(menus[0].open, false);
  assert.equal(menus[1].open, true);
  fire("click", {
    target: {
      closest: (selector) =>
        selector === "details.profile-menu" ? menus[1] : null,
    },
  });
  assert.equal(menus[1].open, true);
  fire("keydown", { key: "Escape" });
  assert.equal(menus[1].open, false);
  assert.equal(focus, 1);
  menus[2].open = true;
  fire("click", { target: { closest: () => null } });
  assert.equal(menus[2].open, false);
});

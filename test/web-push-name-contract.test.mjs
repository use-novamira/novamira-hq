// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderExpr, suggestPushName } from "../dist/web/expr.js";

test("push name follows the direction until customized", () => {
  const expression = renderExpr(
    suggestPushName([
      { id: "a", name: "Live" },
      { id: "b", name: "Test" },
    ]),
  );
  const form = {
    sourceEnvId: "a",
    targetEnvId: "b",
    name: "",
    suggestedName: "",
  };
  const update = () => runInNewContext(expression, { $pushForm: form });
  update();
  assert.equal(form.name, "live-to-test");
  form.sourceEnvId = "b";
  form.targetEnvId = "a";
  update();
  assert.equal(form.name, "test-to-live");
  form.name = "my-release";
  form.targetEnvId = "";
  update();
  assert.equal(form.name, "my-release");
  form.name = "";
  form.targetEnvId = "a";
  update();
  assert.equal(form.name, "test-to-live");
  form.targetEnvId = "b";
  update();
  assert.equal(form.name, "");
});

test("generated names satisfy the grammar, length limit and escape untrusted labels", () => {
  const form = {
    sourceEnvId: "a",
    targetEnvId: "b",
    name: "",
    suggestedName: "",
  };
  const expression = renderExpr(
    suggestPushName([
      { id: "a", name: "Été / Live " + "x".repeat(80) },
      { id: "b", name: "</script> ' ; throw new Error() //" },
    ]),
  );
  runInNewContext(expression, { $pushForm: form });
  assert.match(form.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.ok(form.name.startsWith("ete-live-"));
});

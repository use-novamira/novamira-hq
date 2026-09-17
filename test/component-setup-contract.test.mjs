// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { withComponentSetup } from "../dist/setup/components.js";

function fixture(initial = "absent", consent = false) {
  const state = { status: initial, consent, installs: 0, approvals: 0 };
  const service = withComponentSetup({
    acknowledgement: {
      accepted: async () => state.consent,
      accept: async () => {
        state.consent = true;
        state.approvals++;
      },
    },
    probe: async () => ({ status: state.status, minimum: "1.0.0" }),
    install: async () => {
      state.installs++;
      state.status = "available";
    },
  });
  return { state, service };
}

test("startup does not install and prior consent cannot bypass missing components", async () => {
  const { state, service } = fixture("absent", true);
  assert.equal(await service.accepted(), false);
  assert.equal(state.installs, 0);
});

test("setup installs once and accepts only a working complete installation", async () => {
  const { state, service } = fixture();
  await Promise.all([service.accept(), service.accept()]);
  assert.equal(state.installs, 1);
  assert.equal(state.approvals, 1);
  assert.equal(await service.accepted(), true);
});

test("compatible existing installations are reused", async () => {
  const { state, service } = fixture("available");
  await service.accept();
  assert.equal(state.installs, 0);
  assert.equal(await service.accepted(), true);
});

for (const status of ["incompatible", "unreadable"]) {
  test(`${status} installations cannot be skipped or silently replaced`, async () => {
    const { state, service } = fixture(status);
    await assert.rejects(service.accept({ hostingOnly: true }), /retry setup/);
    assert.equal(state.installs, 0);
    assert.equal(state.approvals, 0);
    assert.equal(await service.accepted(), false);
    state.status = "available";
    await service.accept();
    assert.equal(await service.accepted(), true);
  });
}

test("failed installation or verification leaves setup incomplete and retryable", async () => {
  let available = false;
  let fail = true;
  let approvals = 0;
  const service = withComponentSetup({
    acknowledgement: {
      accepted: async () => approvals > 0,
      accept: async () => {
        approvals++;
      },
    },
    probe: async () => ({
      status: available ? "available" : "absent",
      minimum: "1.0.0",
    }),
    install: async () => {
      if (fail) throw new Error("Install failed");
    },
  });
  await assert.rejects(service.accept(), /Install failed/);
  fail = false;
  await assert.rejects(service.accept(), /not ready/);
  assert.equal(approvals, 0);
  assert.equal(await service.accepted(), false);
  available = true;
  await service.accept();
  assert.equal(await service.accepted(), true);
});

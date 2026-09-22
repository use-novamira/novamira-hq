// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { shareableDiagnostics } from "../dist/web/services/shareable-diagnostics.js";

test("shared diagnostics omit personal data, free text and unknown fields without mutating local report", () => {
  const report = {
    status: "warn",
    offline: true,
    fix: false,
    secret: "private-key",
    checks: [
      {
        id: "storage.atomic",
        status: "pass",
        summary: "/Users/alice/private",
        evidence: { stateDir: "/Users/alice/private" },
      },
      {
        id: "profile.credentials",
        status: "warn",
        evidence: {
          profiles: [
            { name: "customer-secret", credential: "stored:private-reference" },
          ],
        },
      },
      {
        id: "private-new-check",
        status: "private-new-status",
        summary: "private-key",
      },
    ],
  };
  const before = JSON.stringify(report);
  const safe = shareableDiagnostics(report);
  const text = JSON.stringify(safe);
  for (const value of [
    "alice",
    "private",
    "customer",
    "stored:",
    "summary",
    '"evidence":',
  ])
    assert.ok(!text.includes(value), value);
  assert.equal(safe.status, "warn");
  assert.equal(safe.checks[1].status, "warn");
  assert.equal(safe.checks[2].id, "other");
  assert.equal(JSON.stringify(report), before);
});

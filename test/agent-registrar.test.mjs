// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { createSkillRegistrar } from "../dist/agent-setup/registrar.js";

test("registrar never spawns for cancellation or unsupported agents", async () => {
  const registrar = createSkillRegistrar({
    command: "unused",
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await registrar.installHosting("windsurf", abort.signal)).reason,
    "aborted",
  );
  assert.equal(
    (await registrar.installHosting("unknown", new AbortController().signal))
      .reason,
    "unsupported_agent",
  );
});

test("registrar cancellation stops an in-flight child and reports aborted", async () => {
  const registrar = createSkillRegistrar({
    command: process.execPath,
    prefixArgs: ["-e", "setInterval(() => {}, 1000)", "--"],
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await registrar.installHosting(
      "claude-code",
      controller.signal,
    );
    assert.equal(result.reason, "aborted");
  } finally {
    clearTimeout(timer);
  }
});

test("registrar handles timeout, cancellation, overflow, zero-exit copy failure and malformed listing, cleaning staging", async () => {
  for (const kind of [
    "timed_out",
    "aborted",
    "truncated",
    "spawn_failed",
    "exited",
    "malformed",
  ]) {
    const home = await mkdtemp(join(tmpdir(), "hq-registrar-"));
    let calls = 0;
    try {
      const registrar = createSkillRegistrar({
        command: "desktop",
        env: { NOVAMIRA_HQ_HOME: home },
        spawn: async (invocation) => {
          assert.equal(invocation.env.DISABLE_TELEMETRY, "1");
          assert.equal(invocation.env.DO_NOT_TRACK, "1");
          assert.equal(invocation.timeoutMs, 30_000);
          assert.ok(invocation.maxStdoutBytes <= 262_144);
          calls++;
          if (calls === 2)
            return {
              kind: kind === "malformed" ? "exited" : kind,
              code: kind === "exited" || kind === "malformed" ? 0 : null,
              stdout: "",
              stderr: "private output",
            };
          return {
            kind: "exited",
            code: 0,
            stdout: kind === "malformed" ? "not json" : "[]",
            stderr: "",
          };
        },
      });
      const result = await registrar.installHosting(
        "windsurf",
        new AbortController().signal,
      );
      assert.equal(result.ok, false);
      assert.equal(
        result.reason,
        kind === "exited"
          ? "verification_failed"
          : kind === "malformed"
            ? "failed"
            : kind,
      );
      assert.ok(!JSON.stringify(result).includes("private output"));
      assert.deepEqual(await readdir(join(home, "cache")).catch(() => []), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createSiteOperations } from "../dist/integration/operations.js";
import { nodeSpawnChild } from "../dist/integration/spawn.js";

function fixture(
  outcome = {
    kind: "exited",
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      data: { result: "done", token: "must-not-escape" },
    }),
    stderr: "private-error",
  },
) {
  const calls = [];
  return {
    calls,
    service: createSiteOperations({
      environment: {},
      resolve: async () => ({ command: "novamira", prefixArgs: [] }),
      spawn: async (invocation) => {
        calls.push(invocation);
        return outcome;
      },
    }),
  };
}

test("WordPress run delegates fixed CLI grammar with bounded stdin and explicit site", async () => {
  const { service, calls } = fixture();
  const result = await service.execute({
    kind: "run",
    site: "example",
    ability: "novamira/test",
    input: { text: "$(whoami)" },
    approveDestructive: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, '{"text":"$(whoami)"}');
  assert.ok(!calls[0].args.includes("--yes"));
  assert.deepEqual(calls[0].args.slice(-5), [
    "run",
    "novamira/test",
    "--fresh",
    "--input",
    "-",
  ]);
  assert.equal(calls[0].args[calls[0].args.indexOf("--site") + 1], "example");
  assert.equal(calls[0].env.NOVAMIRA_UPDATE_CHECK, "0");
  assert.equal(result.untrustedSiteData, true);
  assert.ok(!JSON.stringify(result).includes("must-not-escape"));
});

test("WordPress destructive confirmation is opt-in per invocation", async () => {
  const { service, calls } = fixture();
  await service.execute({
    kind: "run",
    site: "example",
    ability: "novamira/test",
    input: {},
    approveDestructive: true,
  });
  assert.ok(calls[0].args.includes("--yes"));
});

test("invalid site, option injection and oversized input never spawn", async () => {
  const { service, calls } = fixture();
  for (const operation of [
    { kind: "doctor", site: "--site" },
    { kind: "describe", site: "example", ability: "--help" },
    {
      kind: "run",
      site: "example",
      ability: "test",
      input: "x".repeat(262145),
      approveDestructive: false,
    },
  ])
    await assert.rejects(service.execute(operation), { code: "usage_error" });
  assert.equal(calls.length, 0);
});

test("site list projects public fields only", async () => {
  const { service } = fixture({
    kind: "exited",
    code: 0,
    stderr: "",
    stdout: JSON.stringify({
      ok: true,
      data: [
        {
          name: "example",
          siteUrl: "https://example.com",
          origin: "https://example.com",
          credential: "private",
        },
      ],
    }),
  });
  assert.deepEqual(await service.execute({ kind: "list" }), [
    {
      name: "example",
      siteUrl: "https://example.com",
      origin: "https://example.com",
    },
  ]);
});

test("missing CLI is actionable without accessing a site", async () => {
  const service = createSiteOperations({
    environment: {},
    resolve: async () => undefined,
    spawn: async () => assert.fail("must not spawn"),
  });
  await assert.rejects(
    service.execute({ kind: "list" }),
    /Install @novamira\/cli/,
  );
});

test("ambiguous mutations are non-retryable and never disclose child errors", async () => {
  for (const outcome of [
    { kind: "timed_out", code: null, stdout: "secret", stderr: "secret" },
    { kind: "exited", code: 1, stdout: "malformed-secret", stderr: "secret" },
    {
      kind: "exited",
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "server_unsupported", message: "secret" },
      }),
      stderr: "secret",
    },
  ]) {
    const { service, calls } = fixture(outcome);
    await assert.rejects(
      service.execute({
        kind: "run",
        site: "example",
        ability: "test",
        input: {},
        approveDestructive: false,
      }),
      (error) => {
        assert.equal(error.retryable, false);
        assert.match(error.message, /Verify the site/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  }
});

test("spawn seam writes JSON stdin and closes it without a shell", async () => {
  const result = await nodeSpawnChild({
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    env: process.env,
    input: '{"value":"hello"}',
    timeoutMs: 2000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(result.kind, "exited");
  assert.equal(result.stdout, '{"value":"hello"}');
});

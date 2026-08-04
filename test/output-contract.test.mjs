// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  CliError,
  ERROR_CODES,
  asCliError,
  exitCodeFor,
} from "../dist/errors.js";
import {
  createRenderer,
  failureEnvelope,
  successEnvelope,
} from "../dist/output/render.js";

// The documented taxonomy (plan §5.7). Hard-coded so a silent remapping fails
// here rather than surprising an agent that branches on the exit code.
const EXIT_CODES = {
  usage_error: 2,
  config_error: 2,
  profile_not_found: 2,
  credential_missing: 3,
  credential_invalid: 3,
  provider_unsupported: 4,
  provider_error: 4,
  network_error: 4,
  timeout: 4,
  rate_limited: 4,
  not_found: 4,
  conflict: 4,
  schema_validation_failed: 5,
  confirmation_required: 6,
  integration_unavailable: 4,
  server_unsupported: 4,
  internal_error: 1,
};

function capture(options = {}) {
  const out = [];
  const err = [];
  const renderer = createRenderer(
    { requestId: "request-id-fixed", ...options },
    {
      stdout: { write: (chunk) => out.push(chunk) },
      stderr: { write: (chunk) => err.push(chunk) },
    },
  );
  return {
    renderer,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("the success envelope is byte-for-byte the documented shape", () => {
  const streams = capture({ json: true });
  streams.renderer.success({ sites: [{ id: "site-1" }] });
  assert.equal(
    streams.stdout(),
    '{"ok":true,"data":{"sites":[{"id":"site-1"}]},"meta":{"requestId":"request-id-fixed"}}\n',
  );
  assert.equal(streams.stderr(), "");

  const withMeta = capture({ json: true });
  withMeta.renderer.success(null, {
    meta: { profile: "production", provider: "kinsta" },
    warnings: [{ code: "fallback", message: "Using the file fallback." }],
  });
  assert.deepEqual(JSON.parse(withMeta.stdout()), {
    ok: true,
    data: null,
    meta: {
      requestId: "request-id-fixed",
      profile: "production",
      provider: "kinsta",
      warnings: [{ code: "fallback", message: "Using the file fallback." }],
    },
  });

  assert.deepEqual(successEnvelope({ a: 1 }, { requestId: "r" }), {
    ok: true,
    data: { a: 1 },
    meta: { requestId: "r" },
  });
});

test("the failure envelope is byte-for-byte the documented shape", () => {
  const streams = capture({ json: true });
  const exit = streams.renderer.failure(
    new CliError("not_found", "The site was not found."),
  );
  assert.equal(
    streams.stdout(),
    '{"ok":false,"error":{"code":"not_found","message":"The site was not found.","retryable":false}}\n',
  );
  assert.equal(exit, 4);
  assert.equal(streams.stderr(), "");

  assert.deepEqual(
    failureEnvelope(
      new CliError("rate_limited", "Slow down.", {
        retryable: true,
        remoteCode: "429",
        details: { provider: "kinsta", retryAfterMs: 1000 },
      }),
    ),
    {
      ok: false,
      error: {
        code: "rate_limited",
        message: "Slow down.",
        retryable: true,
        remoteCode: "429",
        details: { provider: "kinsta", retryAfterMs: 1000 },
      },
    },
  );

  // Details are redacted before they reach the envelope.
  const envelope = failureEnvelope(
    new CliError(
      "credential_invalid",
      "The provider rejected the credential.",
      {
        details: { apiKey: "placeholder-not-a-secret", provider: "kinsta" },
      },
    ),
  );
  assert.equal(envelope.error.details.provider, "kinsta");
  assert.equal(
    JSON.stringify(envelope).includes("placeholder-not-a-secret"),
    false,
  );
});

test("JSON mode keeps stdout a single parseable value with diagnostics on stderr", () => {
  const streams = capture({ json: true, verbose: true });
  streams.renderer.note("this note is human-mode only");
  streams.renderer.writeLine("this line is human-mode only");
  streams.renderer.warn("the file fallback is in use");
  streams.renderer.diagnostic("http", {
    method: "GET",
    url: "https://api.kinsta.test/sites?api_key=placeholder-not-a-secret",
  });
  streams.renderer.success({ ok: 1 });

  const stdout = streams.stdout();
  assert.equal(stdout.split("\n").filter((line) => line !== "").length, 1);
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    data: { ok: 1 },
    meta: { requestId: "request-id-fixed" },
  });

  const stderr = streams.stderr();
  assert.match(stderr, /^Warning: the file fallback is in use$/m);
  assert.match(stderr, /^http: /m);
  assert.equal(stderr.includes("this note is human-mode only"), false);
  assert.equal(stderr.includes("this line is human-mode only"), false);
  // Verbose diagnostics are redacted before they are written.
  assert.equal(stderr.includes("placeholder-not-a-secret"), false);

  // Colour is always off in JSON mode, whatever the caller asked for.
  assert.equal(createRenderer({ json: true, color: true }).color, false);
});

test("quiet suppresses commentary but never the envelope", () => {
  const streams = capture({ json: true, quiet: true, verbose: true });
  streams.renderer.warn("suppressed");
  streams.renderer.note("suppressed");
  streams.renderer.diagnostic("http", { suppressed: true });
  streams.renderer.success("done");
  assert.equal(streams.stderr(), "");
  assert.deepEqual(JSON.parse(streams.stdout()).data, "done");

  const failing = capture({ json: true, quiet: true });
  assert.equal(
    failing.renderer.failure(new CliError("timeout", "Too slow.")),
    4,
  );
  assert.equal(JSON.parse(failing.stdout()).error.code, "timeout");
});

test("human mode prints readable text and routes errors to stderr", () => {
  const streams = capture();
  streams.renderer.success({ id: "site-1" }, { human: "site-1 created" });
  streams.renderer.writeLine("a plain line");
  assert.equal(streams.stdout(), "site-1 created\na plain line\n");

  const objects = capture();
  objects.renderer.success({ id: "site-1" });
  assert.equal(
    objects.stdout(),
    `${JSON.stringify({ id: "site-1" }, null, 2)}\n`,
  );

  const empty = capture();
  empty.renderer.success(undefined);
  assert.equal(empty.stdout(), "");

  const failing = capture();
  assert.equal(
    failing.renderer.failure(new CliError("usage_error", "Select a profile.")),
    2,
  );
  assert.equal(failing.stdout(), "");
  assert.equal(failing.stderr(), "Error [usage_error]: Select a profile.\n");
});

test("every error code maps to its documented exit code", () => {
  assert.deepEqual([...ERROR_CODES].sort(), Object.keys(EXIT_CODES).sort());
  for (const [code, expected] of Object.entries(EXIT_CODES)) {
    assert.equal(exitCodeFor(new CliError(code, "message")), expected, code);
    const streams = capture({ json: true });
    assert.equal(
      streams.renderer.failure(new CliError(code, "message")),
      expected,
    );
    assert.equal(JSON.parse(streams.stdout()).error.code, code);
  }

  // Anything that is not a CliError is an internal error, never a crash.
  const wrapped = asCliError(new TypeError("boom"));
  assert.equal(wrapped.code, "internal_error");
  assert.equal(exitCodeFor(wrapped), 1);
  assert.equal(wrapped.cause instanceof TypeError, true);
  const streams = capture({ json: true });
  assert.equal(streams.renderer.failure(new TypeError("boom")), 1);
  assert.equal(
    JSON.parse(streams.stdout()).error.message.includes("boom"),
    false,
  );
});

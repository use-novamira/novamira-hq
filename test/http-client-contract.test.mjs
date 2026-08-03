// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  bearerAuth,
  createHttpClient,
  jsonBody,
} from "../dist/hosting/http-client.js";

// Never a real-looking secret: this only has to prove the header travels.
const TOKEN = "placeholder-not-a-secret";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Records what each hop actually received, body included. */
function recordingHandler(respond) {
  const seen = [];
  return {
    seen,
    handler(request, response) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"],
          authorization: request.headers.authorization,
        });
        respond(request, response);
      });
    },
  };
}

function client(server, options = {}) {
  return createHttpClient({
    baseUrl: `${server.baseUrl}/v1`,
    providerLabel: "Kinsta",
    auth: bearerAuth(TOKEN),
    retry: { maxAttempts: 1 },
    ...options,
  });
}

// RFC 9110 §15.4: a 303 — and a 301/302 answering a POST — is followed with
// GET and no body. Replaying the method and body would re-send a mutating
// request the provider never asked to be repeated, defeating the retry guard
// that deliberately refuses to replay a non-idempotent method.
for (const status of [301, 302, 303]) {
  test(`a ${String(status)} after POST is followed as a bodiless GET`, async () => {
    const recorder = recordingHandler((request, response) => {
      if (request.url === "/v1/sites") {
        response.writeHead(status, { location: "/v1/sites/42" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 42 }));
    });
    const server = await startServer(recorder.handler);
    try {
      const response = await client(server).request({
        path: "/sites",
        method: "POST",
        body: jsonBody({ name: "new-site" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { id: 42 });
      assert.equal(recorder.seen.length, 2);

      assert.deepEqual(recorder.seen[0], {
        method: "POST",
        url: "/v1/sites",
        body: '{"name":"new-site"}',
        contentType: "application/json",
        authorization: `Bearer ${TOKEN}`,
      });
      // The redirect hop must not be a second POST, and must carry no body.
      assert.equal(recorder.seen[1].method, "GET");
      assert.equal(recorder.seen[1].url, "/v1/sites/42");
      assert.equal(recorder.seen[1].body, "");
      assert.equal(recorder.seen[1].contentType, undefined);
      // Same origin, so the credential still travels.
      assert.equal(recorder.seen[1].authorization, `Bearer ${TOKEN}`);
    } finally {
      await server.close();
    }
  });
}

test("only 307 and 308 replay the method and body", async () => {
  const recorder = recordingHandler((request, response) => {
    if (request.url === "/v1/sites") {
      response.writeHead(307, { location: "/v1/sites/42" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 42 }));
  });
  const server = await startServer(recorder.handler);
  try {
    await client(server).request({
      path: "/sites",
      method: "POST",
      body: jsonBody({ name: "new-site" }),
    });
    assert.equal(recorder.seen.length, 2);
    assert.equal(recorder.seen[1].method, "POST");
    assert.equal(recorder.seen[1].body, '{"name":"new-site"}');
    assert.equal(recorder.seen[1].contentType, "application/json");
  } finally {
    await server.close();
  }
});

test("a redirect chain cannot outlive the request's own timeout", async () => {
  const hopDelayMs = 120;
  const timeoutMs = 200;
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    setTimeout(() => {
      if (hop < 3) {
        response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    }, hopDelayMs);
  });
  try {
    const startedAt = Date.now();
    // Each hop used to get a fresh `AbortSignal.timeout(timeoutMs)`, so three
    // redirects could run for four times the configured budget and still
    // succeed. The budget is now one absolute deadline for the whole attempt.
    await assert.rejects(
      client(server).request({
        path: "/hop0",
        timeoutMs,
        totalTimeoutMs: timeoutMs,
      }),
      { code: "timeout" },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < 4 * timeoutMs,
      `the attempt took ${String(elapsedMs)}ms, over the ${String(timeoutMs)}ms budget`,
    );
  } finally {
    await server.close();
  }
});

test("a redirect chain that fits the budget still succeeds", async () => {
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    if (hop < 3) {
      response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hop }));
  });
  try {
    const response = await client(server).request({ path: "/hop0" });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { hop: 3 });
    assert.ok(response.url.endsWith("/v1/hop3"));
  } finally {
    await server.close();
  }
});

test("a fourth redirect is refused rather than followed", async () => {
  const server = await startServer((request, response) => {
    const hop = Number(/hop(\d+)/.exec(request.url)[1]);
    response.writeHead(302, { location: `/v1/hop${String(hop + 1)}` });
    response.end();
  });
  try {
    await assert.rejects(client(server).request({ path: "/hop0" }), {
      code: "provider_error",
    });
  } finally {
    await server.close();
  }
});

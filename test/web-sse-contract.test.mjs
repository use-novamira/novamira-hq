// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The SSE wrapper: the exact bytes on the wire, and the narrowness of the
 * interface handlers see.
 *
 * No socket is involved. `streamSse` is driven with a `ServerResponse`-shaped
 * stub that collects everything written, which is the direct port of Go's
 * `ssePatchBlock` helper in `internal/dashboard/server_test.go` — the frames are
 * asserted as text, line for line, so a change in the SDK's dataline suppression
 * shows up here rather than in a browser.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { html, renderHtml } from "../dist/web/html.js";
import { connCellId, SSE_PATCH_FRAGMENTS } from "../dist/web/patches.js";
import { streamSse } from "../dist/web/sse.js";
import {
  renderMain,
  renderNav,
  renderToast,
} from "../dist/web/views/layout.js";

function stubs() {
  const message = new EventEmitter();
  const headers = new Map();
  let written = "";
  let ended = false;
  const response = {
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    getHeader: (name) => headers.get(name.toLowerCase()),
    writeHead: (status, extra) => {
      response.statusCode = status;
      for (const [name, value] of Object.entries(extra ?? {}))
        headers.set(name.toLowerCase(), value);
      return response;
    },
    flushHeaders: () => undefined,
    write: (chunk) => {
      written += chunk;
      return true;
    },
    end: () => {
      ended = true;
    },
    statusCode: 0,
  };
  return {
    message,
    response,
    headers,
    body: () => written,
    ended: () => ended,
  };
}

function blocks(body) {
  return body
    .split("\n\n")
    .filter((block) => block !== "")
    .map((block) => block.split("\n").filter((line) => line !== ""));
}

test("an outer patch emits no mode dataline and prepends the # itself", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, (stream) => {
    stream.patchElements(html`<main id="main">x</main>`, {
      selectorId: "main",
      mode: "outer",
    });
  });
  assert.deepEqual(blocks(stub.body()), [
    [
      "event: datastar-patch-elements",
      "data: selector #main",
      'data: elements <main id="main">x</main>',
    ],
  ]);
  assert.ok(!stub.body().includes("data: mode"));
});

test("an inner patch emits data: mode inner", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, (stream) => {
    stream.patchElements(html`<li>row</li>`, {
      selectorId: "main",
      mode: "inner",
    });
  });
  const [block] = blocks(stub.body());
  assert.ok(block.includes("data: mode inner"));
  assert.ok(block.includes("data: selector #main"));
});

test("blocks are separated by a blank line and split cleanly", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, (stream) => {
    stream.patchElements(html`<main id="main">a</main>`, {
      selectorId: "main",
      mode: "outer",
    });
    stream.patchElements(html`<nav id="nav">b</nav>`, {
      selectorId: "nav",
      mode: "outer",
    });
  });
  assert.equal(blocks(stub.body()).length, 2);
  assert.ok(stub.body().endsWith("\n\n"));
});

test("patchSignals emits one datastar-patch-signals block", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, (stream) => {
    stream.patchSignals({ x: 1, nested: { y: true } });
  });
  assert.deepEqual(blocks(stub.body()), [
    [
      "event: datastar-patch-signals",
      'data: signals {"x":1,"nested":{"y":true}}',
    ],
  ]);
});

test("every catalogued outer fragment has a root element carrying its id", () => {
  const rendered = new Map([
    ["main", renderHtml(renderMain("providers", html`<p>x</p>`))],
    ["nav", renderHtml(renderNav("providers"))],
    ["toast", renderHtml(renderToast({ level: "ok", message: "done" }))],
  ]);
  assert.ok(SSE_PATCH_FRAGMENTS.length > 0);
  for (const fragment of SSE_PATCH_FRAGMENTS) {
    assert.match(fragment.selectorId, /^[a-z][a-z0-9-]*$/);
    const markup = rendered.get(fragment.selectorId);
    assert.ok(markup, `${fragment.selectorId} has a 6a renderer`);
    if (fragment.mode === "outer")
      assert.match(
        markup,
        new RegExp(`^<[a-z]+[^>]*\\sid="${fragment.selectorId}"`),
        fragment.selectorId,
      );
  }
});

test("connCellId is selector-safe, injective and hex", () => {
  const id = connCellId("prod.us:blue/slash");
  assert.match(id, /^conn-[0-9a-f]+$/);
  for (const character of [".", ":", "/"])
    assert.ok(!id.includes(character), character);
  assert.match(connCellId("prôd-ü"), /^conn-[0-9a-f]+$/);
  assert.notEqual(connCellId("a-b"), connCellId("ab"));
  assert.notEqual(connCellId("prod"), connCellId("prod2"));
});

test("security headers are set before the SDK writes its head", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, (stream) => {
    stream.patchSignals({ x: 1 });
  });
  assert.equal(stub.headers.get("x-content-type-options"), "nosniff");
  assert.equal(stub.headers.get("referrer-policy"), "no-referrer");
  assert.equal(stub.headers.get("x-frame-options"), "DENY");
  assert.equal(stub.headers.get("pragma"), "no-cache");
  assert.equal(stub.headers.get("content-type"), "text/event-stream");
  assert.equal(stub.headers.get("cache-control"), "no-cache");
  assert.equal(stub.response.statusCode, 200);
});

test("close ends the response and a second close is a no-op", async () => {
  const stub = stubs();
  let ends = 0;
  stub.response.end = () => {
    ends += 1;
  };
  await streamSse(
    stub.message,
    stub.response,
    (stream) => {
      stream.close();
      stream.close();
    },
    { keepalive: true },
  );
  assert.equal(ends, 1);
});

test("without keepalive the response ends when the handler resolves", async () => {
  const stub = stubs();
  await streamSse(stub.message, stub.response, async (stream) => {
    await Promise.resolve();
    stream.patchSignals({ x: 1 });
  });
  assert.equal(stub.ended(), true);
});

test("a throwing handler ends the response and surfaces the rejection", async () => {
  const stub = stubs();
  await assert.rejects(
    () =>
      streamSse(stub.message, stub.response, () => {
        throw new Error("handler exploded");
      }),
    /handler exploded/,
  );
  assert.equal(stub.ended(), true);
});

test("SseStream exposes exactly three methods", async () => {
  const stub = stubs();
  let seen;
  await streamSse(stub.message, stub.response, (stream) => {
    seen = stream;
  });
  assert.deepEqual(Object.keys(seen).sort(), [
    "close",
    "patchElements",
    "patchSignals",
  ]);
  for (const forbidden of [
    "executeScript",
    "removeElements",
    "removeSignals",
    "send",
  ])
    assert.equal(seen[forbidden], undefined, forbidden);
});

test("no module outside src/web/sse.ts imports the Datastar SDK", async () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "static") await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const source = await readFile(full, "utf8");
      // Only real imports count; the package is named in several header
      // comments, which is the point of documenting where it may be reached.
      if (
        !/(?:from|import)\s*\(?\s*"@starfederation\/datastar-sdk/.test(source)
      )
        continue;
      if (full.endsWith(join("web", "sse.ts"))) continue;
      offenders.push(full);
    }
  };
  await walk(root);
  assert.deepEqual(offenders, []);
});

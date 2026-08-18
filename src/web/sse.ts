// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard's Server-Sent Events surface: a three-method interface, and the
 * one module in HQ that imports `@starfederation/datastar-sdk`.
 *
 * **What the Go did.** `server.go` handed
 * `datastar.NewSSE(w, r)` straight to every handler, so the SDK's whole API —
 * `ExecuteScript`, `RemoveFragments`, `MarshalAndPatchSignals`, the option
 * functions — was in scope at thirty call sites, and the `#` in
 * `WithSelectorID("#main")` was written by the caller each time (or, in
 * `datastar-go`'s helper form, added by the library; the two spellings coexisted
 * in the same file).
 *
 * **What HQ does instead.** Views and route handlers see {@link SseStream}:
 * `patchElements`, `patchSignals`, `close`, and nothing else. No SDK type
 * appears in any exported signature here, so the SDK is replaceable and, more
 * usefully, unreachable — conventions rule 12 asserts by scanning the source
 * tree that no other module imports it. `patchElements` takes a
 * {@link PatchSelectorId} from the catalog and prepends the `#` itself, so the
 * id in `patches.ts`, the `id=` in the markup and the `data: selector` line on
 * the wire are one value that cannot drift.
 *
 * **Three SDK methods are deliberately not exposed.** `executeScript` injects an
 * inline `<script>`, which the dashboard's CSP forbids anyway (`script-src
 * 'self' 'unsafe-eval'`, never `'unsafe-inline'`); `removeElements` and
 * `removeSignals` have no use in HQ. Narrowing the surface is the point of the
 * wrapper, not an accident of what was needed first.
 *
 * **`ServerSentEventGenerator.readSignals` is not used either.** It reads the
 * request body into an unbounded string. `src/web/request.ts` reads the body
 * itself under a 256 KiB cap. An unbounded read on a process-lifetime server is
 * a needless footgun even on loopback.
 *
 * **Wire compatibility with Go.** The SDK suppresses datalines whose value
 * equals the protocol default (`DefaultMapping`), so an `outer` patch emits no
 * `data: mode` line at all and an `inner` patch emits `data: mode inner` — byte
 * for byte what `datastar-go` produced, which is what Go's `ssePatchBlock` test
 * helper asserted against.
 *
 * **The SDK's disconnect listener is retargeted.** `ServerSentEventGenerator.stream`
 * registers `req.on("close", () => res.end())` to end the stream when the client
 * goes away. On Node an `IncomingMessage` emits `close` as soon as its body has
 * been *consumed*, not only when the peer disappears — so every route that reads
 * its Datastar signals from the body (which is every `POST` under
 * `/_dashboard/`) had its response ended before the first patch was written, and
 * answered a real mutation with a `200` and zero bytes. The disconnect that
 * matters to a response already being streamed is the response socket closing,
 * so {@link disconnectView} is what the SDK is handed.
 *
 * **Headers.** The SDK's constructor calls `res.writeHead(200, sseHeaders)`.
 * Node merges headers previously set with `setHeader` into that call, with
 * `writeHead`'s own entries winning on collision, and the security headers do
 * not collide with `Cache-Control`, `Connection` or `Content-Type`. So the
 * security headers are applied *before* `stream()` runs and survive. The SDK's
 * `Cache-Control: no-cache` is accepted as-is on SSE responses rather than
 * fought over: an event stream is not cacheable in any case, and `Pragma:
 * no-cache` is added for the same reason a proxy might still be listening.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ServerSentEventGenerator } from "@starfederation/datastar-sdk";

import type { JsonValue } from "./expr.js";
import { renderHtml, type Html } from "./html.js";
import type { PatchMode, PatchSelectorId } from "./patches.js";
import { SECURITY_HEADERS } from "./responses.js";

/** Where a fragment goes: a catalogued element id and a patch mode. */
export interface SsePatchTarget {
  readonly selectorId: PatchSelectorId;
  readonly mode: PatchMode;
}

/** Everything routes and views may know about SSE. */
export interface SseStream {
  /** Patch `markup` into `#${target.selectorId}`; the `#` is added here. */
  patchElements(markup: Html, target: SsePatchTarget): void;
  /** RFC 7386 merge-patch over the client's signal store. */
  patchSignals(values: Readonly<Record<string, JsonValue>>): void;
  /** End the response. Idempotent. */
  close(): void;
}

export type SseHandler = (stream: SseStream) => Promise<void> | void;

export interface SseStreamOptions {
  /** Keep the response open after the handler resolves. Defaults to false. */
  readonly keepalive?: boolean;
}

/**
 * Remove every carriage return before it reaches the SDK.
 *
 * The SDK splits a value on line feed only before prefixing `data: `, but
 * browsers treat a bare `\r`, an `\r\n` pair or a lone `\n` alike as a SSE line
 * delimiter. A `\r` therefore survives the SDK's `split("\n")`, reaches the wire
 * inside what looks like one `data:` line, and is re-interpreted by the browser
 * as the start of a field or event the sender never wrote. Stripping `\r` here —
 * after escaping and rendering, and before framing — turns `\r\n` into `\n`
 * (still a data-line split) and removes a lone `\r` outright, so neither can
 * select its own field or event. This is the only module that can touch both
 * sides of the boundary: it renders, normalizes, and frames in one place.
 */
function normalizeSseValue(value: string): string {
  return value.replaceAll("\r", "");
}

/**
 * Adapt one `node:http` request/response pair into an {@link SseStream} and run
 * `handler` over it.
 *
 * The returned promise settles when the SDK's stream does. A handler that
 * throws ends the response and the rejection propagates to the caller — the
 * dispatcher — rather than surfacing as a half-written socket.
 */
export async function streamSse(
  request: IncomingMessage,
  response: ServerResponse,
  handler: SseHandler,
  options: SseStreamOptions = {},
): Promise<void> {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("Pragma", "no-cache");

  await ServerSentEventGenerator.stream(
    disconnectView(request, response),
    response,
    (generator) => {
      let closed = false;
      const stream: SseStream = {
        patchElements(markup, target) {
          generator.patchElements(normalizeSseValue(renderHtml(markup)), {
            selector: `#${target.selectorId}`,
            mode: target.mode,
          });
        },
        patchSignals(values) {
          generator.patchSignals(normalizeSseValue(JSON.stringify(values)));
        },
        close() {
          // The SDK's `close` is a bare `res.end()`; a second one would raise
          // ERR_STREAM_ALREADY_FINISHED on the response's error path, so the
          // idempotence a caller expects is enforced here.
          if (closed) return;
          closed = true;
          generator.close();
        },
      };
      return handler(stream);
    },
    options.keepalive === undefined ? {} : { keepalive: options.keepalive },
  );
}

/**
 * The request as the SDK should see it: everything delegated, except that a
 * `close` listener is registered on the *response*.
 *
 * A `Proxy` rather than a hand-built object because the SDK stores the value as
 * its `req` field, and delegating wholesale means a future SDK release that
 * reaches for another property finds the real one instead of `undefined`.
 *
 * The response emits `close` on a normal end too, so the SDK's `() => res.end()`
 * would run a second `end()` on a finished response; `writableEnded` filters
 * that out, leaving only the case the listener is for.
 */
function disconnectView(
  request: IncomingMessage,
  response: ServerResponse,
): IncomingMessage {
  return new Proxy(request, {
    get(target, property, receiver) {
      if (property !== "on") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return (event: string, listener: () => void): IncomingMessage => {
        if (event === "close") {
          response.on("close", () => {
            if (!response.writableEnded) listener();
          });
          return receiver as IncomingMessage;
        }
        target.on(event, listener);
        return receiver as IncomingMessage;
      };
    },
  });
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The request as a dashboard route sees it: a plain value, not an
 * `IncomingMessage`.
 *
 * **What the Go did.** Every handler took `(w http.ResponseWriter, r
 * *http.Request)` and reached into it for whatever it needed, and the body was
 * read by `datastar.ReadSignals(r, &signals)` — which, in the Node SDK HQ links
 * against, accumulates the entire body into a string with no cap at all
 * (`esm/node/serverSentEventGenerator.js`). On a server that lives for the
 * length of an operator's session that is a needless footgun even on loopback,
 * so HQ reads the body itself.
 *
 * **What HQ does instead.** {@link DashboardRequest} is four fields and a
 * method. A route test builds one as an object literal — no socket, no
 * `node:http` object, no header casing to remember, because the keys are
 * lower-cased here once. `body()` is bounded at
 * {@link MAX_REQUEST_BODY_BYTES} and memoized, so a handler that reads it twice
 * sees the same bytes rather than an empty stream the second time (the same
 * lesson `CommandIo.readStdin` learned).
 *
 * **The body is where secrets travel.** A dashboard credential field posts its
 * value in the request body and nowhere else — never a query string, never a
 * URL, never a header. Nothing here logs, stores, or echoes the body, and the
 * oversized-body error names a byte count and nothing else.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { CliError } from "../errors.js";
import { asRecord } from "../json.js";

/** 256 KiB. A signal post is a few hundred bytes; this is slack, not a budget. */
export const MAX_REQUEST_BODY_BYTES = 262_144;

export interface DashboardRequest {
  /** Upper-cased. */
  readonly method: string;
  /** Percent-decoded, query stripped. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Keys lower-cased, as `node:http` already delivers them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * Aborts when the client goes away.
   *
   * Go read `r.Context().Done()` in exactly one handler, the setup job stream
   * (`server.go:1013`), and it was the only thing that stopped a one-second poll
   * loop from running for the rest of the process when the operator closed the
   * tab. HQ's equivalent is this signal, and it is **required** rather than
   * optional so that a looping handler cannot forget to honour it: a synthesized
   * request in a test passes `new AbortController().signal`, which simply never
   * aborts.
   */
  readonly signal: AbortSignal;
  /** Bounded and memoized: a second call returns the first call's value. */
  body(): Promise<string>;
}

/**
 * Errors raised because a body exceeded the cap.
 *
 * The dispatcher answers those with HTTP 413 rather than the 400 the
 * `usage_error` code maps to. A `WeakSet` rather than a `CliError` subclass
 * keeps the taxonomy a closed union of codes — the repository's rule — and
 * keeps the marker out of the failure envelope, where it would be noise.
 */
const OVERSIZED_BODIES = new WeakSet<CliError>();

export function isBodyTooLarge(error: unknown): boolean {
  return error instanceof CliError && OVERSIZED_BODIES.has(error);
}

function bodyTooLarge(): CliError {
  const error = new CliError(
    "usage_error",
    `The dashboard request body exceeds the ${String(MAX_REQUEST_BODY_BYTES)} byte limit.`,
  );
  OVERSIZED_BODIES.add(error);
  return error;
}

/**
 * Percent-decode once.
 *
 * A malformed escape is not an error here: the undecodable path simply matches
 * no route and becomes a 404. Decoding *before* the static handler's traversal
 * guard is deliberate — it is what makes `/assets/..%2f..%2fpackage.json` and
 * `/assets/%2e%2e/%2e%2e/package.json` fail the `..`-segment check rather than
 * sail through it as opaque bytes.
 */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function lowerCasedHeaders(
  source: IncomingMessage["headers"],
): Readonly<Record<string, string | undefined>> {
  const headers: Record<string, string | undefined> = Object.create(
    null,
  ) as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(source)) {
    headers[name.toLowerCase()] = Array.isArray(value)
      ? // `node:http` only ever arrays `set-cookie`; joining keeps the type
        // honest without inventing a second shape for one header.
        value.join(", ")
      : value;
  }
  return headers;
}

/**
 * Read at most {@link MAX_REQUEST_BODY_BYTES}, then stop.
 *
 * Nothing beyond the cap is ever buffered: the loop leaves the moment the count
 * is exceeded and the accumulated chunks go out of scope with the rejection.
 *
 * What it must **not** do is tear the connection down on the way out. Destroying
 * the `IncomingMessage` destroys its socket, so the `413` the dispatcher is
 * about to write would have nowhere to go and every client would see a
 * connection reset instead of the status the contract documents. That is why the
 * iterator is taken with `destroyOnReturn: false` — Node's default for
 * `for await` is to destroy the stream when the loop is left early — and why the
 * throw is bare. The adapter in `server.ts` writes the response and then drops
 * the connection, in that order.
 */
async function readBoundedBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const body: AsyncIterable<Buffer | string> = message.iterator({
    destroyOnReturn: false,
  });
  for await (const chunk of body) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw bodyTooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Adapt one `node:http` message. The only place `IncomingMessage` is read.
 *
 * `response` is what the abort signal watches. An `IncomingMessage` emits
 * `close` once its body has been *consumed*, not only when the peer disappears,
 * so watching the request would abort every route that reads its Datastar
 * signals from the body — which is every `POST` under `/_dashboard/` — the
 * instant it had them. The response socket closing before the response was
 * ended is the disconnect a looping handler must stop for.
 */
export function dashboardRequestFrom(
  message: IncomingMessage,
  response: ServerResponse,
): DashboardRequest {
  const target = new URL(message.url ?? "/", "http://dashboard.invalid");
  let pending: Promise<string> | undefined;
  const disconnected = new AbortController();
  const abort = (): void => {
    disconnected.abort();
  };
  message.once("aborted", abort);
  response.once("close", () => {
    // A normal end closes the response too; only an unfinished one is a client
    // that went away while a handler was still writing.
    if (!response.writableEnded) abort();
  });
  return {
    method: (message.method ?? "GET").toUpperCase(),
    path: decodePath(target.pathname),
    query: target.searchParams,
    headers: lowerCasedHeaders(message.headers),
    signal: disconnected.signal,
    body() {
      pending ??= readBoundedBody(message);
      return pending;
    },
  };
}

/**
 * The body parsed as a Datastar signal record.
 *
 * Datastar posts a JSON object; anything else is a client that is not the
 * dashboard's own page, and is refused rather than coerced.
 */
export async function readSignals(
  request: DashboardRequest,
): Promise<Readonly<Record<string, unknown>>> {
  const text = await request.body();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === "" ? "null" : text);
  } catch {
    throw new CliError(
      "schema_validation_failed",
      "The dashboard request body is not valid JSON.",
    );
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    throw new CliError(
      "schema_validation_failed",
      "The dashboard request body must be a JSON object of Datastar signals.",
    );
  }
  return record;
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a dashboard route returns, and how a `CliError` becomes an HTTP status.
 *
 * **What the Go did.** Handlers wrote to `http.ResponseWriter` directly:
 * `w.Header().Set(...)`, `w.WriteHeader(status)`, `w.Write([]byte(...))`, with
 * `writeError(w, status, message)` (server.go:1987) emitting a bare
 * `text/plain` line that shared nothing with the CLI's JSON envelope. A handler
 * could therefore forget a header, write a body twice, or invent a status, and
 * the dashboard's error shape and the CLI's error shape were simply different
 * things.
 *
 * **What HQ does instead.** A handler returns a value. {@link DashboardResponse}
 * is a discriminated union of the five things the dashboard can answer with, and
 * the one adapter in `server.ts` turns it into bytes — so every response,
 * including a 404 and an asset, carries {@link SECURITY_HEADERS}, and no handler
 * can half-write one.
 *
 * JSON responses go through `successEnvelope`/`failureEnvelope` from
 * `src/output/render.ts` unchanged, so the dashboard and the CLI emit the
 * identical shape; contract tests commit to that.
 * `failureEnvelope` runs `redact()` over `details`, so a provider secret that
 * reached an error's details cannot reach the browser.
 *
 * **The status map is the one thing the dashboard needs that the CLI never
 * did.** The CLI's taxonomy is a code plus an exit status; HTTP wants a third
 * number. The mapping is total over `ErrorCode` — a new code is a compile error
 * here, not a silent 500 — and the finer route-level meanings (403 for a
 * rejected token, 405 for a wrong method, 413 for an oversized body, 304 for an
 * ETag hit) are set by the dispatcher on top of it, keeping the envelope's
 * `code` honest about *what* went wrong while the status says *how* the caller
 * should react.
 */

import type { CliError, ErrorCode } from "../errors.js";
import {
  failureEnvelope,
  successEnvelope,
  type Envelope,
  type InvocationMeta,
} from "../output/render.js";
import type { Html } from "./html.js";
import type { SseStream } from "./sse.js";

/**
 * Applied to *every* response: HTML, JSON, assets, errors and SSE.
 *
 * The first three are Go's `securityHeaders` middleware (server.go:174-182)
 * verbatim. `X-Frame-Options` and `Cross-Origin-Resource-Policy` are HQ
 * additions: the dashboard holds a mutation token in its DOM, so it must not be
 * framable by, or fetchable as a subresource from, another origin.
 *
 * `'unsafe-eval'` stays — Datastar evaluates its expressions — and
 * `'unsafe-inline'` must never be added, which is exactly why `executeScript` is
 * not exposed by `src/web/sse.ts` and why no view emits an inline `<script>` or
 * an interpolated `style=`.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    "X-Novamira-HQ-Dashboard": "1",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
  },
);

/** `Cache-Control` for a rendered page: never store the token-bearing HTML. */
export const HTML_CACHE_CONTROL = "no-store";

/** `Cache-Control` for a static asset: revalidate, do not serve stale bytes. */
export const ASSET_CACHE_CONTROL = "no-cache";

export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export type DashboardResponse =
  | { readonly kind: "html"; readonly status: number; readonly body: Html }
  | {
      readonly kind: "json";
      readonly status: number;
      readonly envelope: Envelope;
      /** Extra response headers; only 405's `Allow` uses it. */
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "text";
      readonly status: number;
      readonly contentType: string;
      readonly body: string;
    }
  | {
      readonly kind: "asset";
      readonly status: number;
      readonly contentType: string;
      readonly cacheControl: string;
      readonly etag: string;
      /** Absent for `HEAD` and for `304`; `Content-Length` still reports it. */
      readonly body: Uint8Array | undefined;
      readonly contentLength: number;
      readonly contentDisposition?: string;
    }
  | { readonly kind: "sse"; run(stream: SseStream): Promise<void> | void };

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  usage_error: 400,
  config_error: 500,
  profile_not_found: 404,
  credential_missing: 400,
  credential_invalid: 400,
  provider_unsupported: 501,
  provider_error: 502,
  network_error: 502,
  timeout: 504,
  rate_limited: 429,
  not_found: 404,
  conflict: 409,
  schema_validation_failed: 422,
  confirmation_required: 409,
  integration_unavailable: 503,
  server_unsupported: 502,
  internal_error: 500,
};

/** The HTTP status for a taxonomy code. Total by construction. */
export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export function htmlResponse(body: Html, status = 200): DashboardResponse {
  return { kind: "html", status, body };
}

export function jsonSuccess(
  data: unknown,
  meta: InvocationMeta,
  status = 200,
): DashboardResponse {
  return { kind: "json", status, envelope: successEnvelope(data, meta) };
}

/**
 * The failure envelope, at the status the map gives its code.
 *
 * `status` overrides it for the route-level rejections that are not about
 * *what* failed but about *where*: 403 for the token and loopback guards, 405
 * for a wrong method, 413 for an oversized body.
 */
export function jsonFailure(
  error: CliError,
  status?: number,
  headers?: Readonly<Record<string, string>>,
): DashboardResponse {
  return {
    kind: "json",
    status: status ?? httpStatusFor(error.code),
    envelope: failureEnvelope(error),
    ...(headers === undefined ? {} : { headers }),
  };
}

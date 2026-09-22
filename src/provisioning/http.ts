// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single injectable outbound-HTTP seam every non-provider request in
 * provisioning goes through.
 *
 * Go reached for `http.DefaultClient` from inside `resolveNovamiraLatestZip`
 * and `validateRemotePluginInstallSource`, which made both untestable without
 * network access. HQ declares the narrowest interface those calls need and
 * injects it, so every provisioning contract test runs offline against a
 * literal double or a loopback server. The type started life private inside
 * `src/cli/hosting/wp.ts` as `{ ok, status, json() }`; Phase 5's compatibility
 * preflight also needs response headers, manual redirects, a request abort
 * signal and the raw body, so the seam widens here. Widening is safe: the only
 * production implementation is the real `fetch`, and the existing WP contract
 * test drives a loopback server through the real `fetch` rather than a literal.
 *
 * Deliberately NOT `src/hosting/http-client.ts`. That client is provider-shaped
 * — it demands a `baseUrl` and a `providerLabel`, injects provider credentials
 * on every request and folds each non-2xx into a *provider* error. A WordPress
 * site is not a hosting provider and must never appear in a provider-voiced
 * diagnostic, and nothing here may ever carry a credential.
 */

import { Buffer } from "node:buffer";

/**
 * The part of a `fetch` response provisioning reads.
 *
 * `body` is optional so a test double can be a plain object literal with just
 * `text()`; when it is present — as it always is on a real `Response` — the
 * bounded reads stream it so an oversized body is abandoned rather than
 * buffered.
 */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** The part of `RequestInit` provisioning sets. No body: every call is a read. */
export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly redirect?: "manual" | "follow";
  readonly signal?: AbortSignal;
}

export type HttpFetch = (
  input: string,
  init?: HttpRequestInit,
) => Promise<HttpResponse>;

/** The production seam: the global `fetch`, narrowed to {@link HttpFetch}. */
export const globalHttpFetch: HttpFetch = (input, init) => fetch(input, init);

/** Cancel a response body that will not be consumed. */
export async function discardBody(response: HttpResponse): Promise<void> {
  const stream = response.body;
  if (stream === undefined || stream === null) return;
  await stream.cancel().catch(() => undefined);
}

/** Read no more than `limit` bytes, cancelling a stream once it exceeds that. */
export async function readBoundedText(
  response: HttpResponse,
  limit: number,
): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await discardBody(response);
    return undefined;
  }

  const stream = response.body;
  if (stream === undefined || stream === null) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > limit ? undefined : text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

import { CliError, type ErrorCode } from "../errors.js";
import {
  collectSensitiveValues,
  redact,
  redactText,
  registerSensitiveValues,
} from "../output/redact.js";

/**
 * Provider-facing HTTP client.
 *
 * It talks to hosting provider control-plane APIs (Kinsta, WP Engine, ...) and
 * never to a WordPress site: HQ holds no site token and proxies no Ability.
 */

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Ordered query pairs (order is preserved, mirroring the Go client). */
export type QueryPairs = readonly (readonly [
  string,
  string | number | boolean,
])[];

export type QueryParameters =
  QueryPairs | Readonly<Record<string, string | number | boolean | undefined>>;

/** Request payloads a provider API accepts. */
export type HttpBody =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "form"; readonly value: Readonly<Record<string, string>> }
  | {
      readonly kind: "text";
      readonly value: string;
      readonly contentType: string;
    };

export interface HttpAuthorization {
  /** Header names are lower-cased before use. */
  readonly headers: Readonly<Record<string, string>>;
  /** Literal secrets scrubbed from diagnostics and error messages. */
  readonly secrets?: readonly string[];
}

/**
 * Injects credentials per request, so providers that cache a short-lived token
 * (Cloudways, Pressable, Rocket.net, Pantheon) can refresh it transparently.
 */
export interface HttpAuthProvider {
  authorize(): Promise<HttpAuthorization> | HttpAuthorization;
}

export interface RetryPolicy {
  /** Total attempts, including the first one. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
  /** Upper bound applied to a `Retry-After` header. */
  readonly retryAfterCeilingMs: number;
}

export interface HttpDiagnostic {
  readonly phase: "request" | "response" | "retry" | "failure";
  readonly method: HttpMethod;
  readonly origin: string;
  readonly path: string;
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs?: number;
  readonly retryInMs?: number;
  readonly code?: ErrorCode;
}

export interface HttpClientOptions {
  /** Provider API root, e.g. `https://api.kinsta.com/v2`. */
  readonly baseUrl: string;
  /** Human-readable provider label used in error messages, e.g. `Kinsta`. */
  readonly providerLabel?: string;
  readonly auth?: HttpAuthProvider;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Per-attempt timeout. Default 30s. */
  readonly timeoutMs?: number;
  /** Budget for every attempt plus backoff of one request. Default 120s. */
  readonly totalTimeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly responseCeilingBytes?: number;
  readonly onDiagnostic?: (diagnostic: HttpDiagnostic) => void;
  /** Injection points; tests point these at a local mock HTTP server. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface HttpRequest {
  /** Absolute URL (same origin as the base URL) or a path below it. */
  readonly path: string;
  readonly method?: HttpMethod;
  readonly query?: QueryParameters;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: HttpBody;
  /** Skip credential injection (token-exchange endpoints). */
  readonly anonymous?: boolean;
  /** Extra literal secrets to scrub, e.g. one carried in the request body. */
  readonly secrets?: readonly string[];
  /**
   * Non-2xx statuses treated as success, e.g. Kinsta's operations endpoint
   * which reports a failed operation as HTTP 500 with a JSON body.
   */
  readonly acceptStatuses?: readonly number[];
  /**
   * Opt a non-safe method into retries. Only set it when replaying the request
   * cannot produce a second side effect.
   */
  readonly idempotent?: boolean;
  readonly retry?: Partial<RetryPolicy>;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  /** Parsed JSON body; `null` when the response had no body. */
  readonly data: T;
  /** Raw response text, bounded by the response ceiling. */
  readonly text: string;
  readonly attempts: number;
}

export interface PollOptions<T> {
  readonly isComplete: (response: HttpResponse<T>) => boolean;
  readonly initialIntervalMs?: number;
  readonly maxIntervalMs?: number;
  readonly backoffFactor?: number;
  /** Total polling budget. Default 5 minutes. */
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface HttpClient {
  readonly baseUrl: string;
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
  json<T = unknown>(request: HttpRequest): Promise<T>;
  /** Repeats `request` until `isComplete` accepts a response or time runs out. */
  poll<T = unknown>(
    request: HttpRequest,
    options: PollOptions<T>,
  ): Promise<HttpResponse<T>>;
}

export const HTTP_RESPONSE_CEILING_BYTES = 25 * 1024 * 1024;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 8_000,
  backoffFactor: 2,
  retryAfterCeilingMs: 30_000,
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_MAX_INTERVAL_MS = 15_000;
const DEFAULT_POLL_DEADLINE_MS = 300_000;
const MAX_REDIRECTS = 3;
const ERROR_MESSAGE_LIMIT = 240;

/** Methods retried by default: replaying them cannot create a side effect. */
const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  "GET",
  "HEAD",
]);

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** `Authorization: Bearer <token>` for the majority of provider APIs. */
export function bearerAuth(token: string): HttpAuthProvider {
  return {
    authorize: () => ({
      headers: { authorization: `Bearer ${token}` },
      secrets: [token],
    }),
  };
}

/** HTTP Basic, used by WP Engine's API user / password pair. */
export function basicAuth(
  username: string,
  password: string,
): HttpAuthProvider {
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(
    "base64",
  );
  return {
    authorize: () => ({
      headers: { authorization: `Basic ${encoded}` },
      secrets: [password, encoded],
    }),
  };
}

/** A single custom credential header, e.g. `X-Api-Key`. */
export function headerAuth(name: string, value: string): HttpAuthProvider {
  return {
    authorize: () => ({
      headers: { [name.toLowerCase()]: value },
      secrets: [value],
    }),
  };
}

/** Wraps a token cache: the callback runs before every authenticated request. */
export function dynamicAuth(
  authorize: () => Promise<HttpAuthorization> | HttpAuthorization,
): HttpAuthProvider {
  return { authorize };
}

export function jsonBody(value: unknown): HttpBody {
  return { kind: "json", value };
}

export function formBody(value: Readonly<Record<string, string>>): HttpBody {
  return { kind: "form", value };
}

export function textBody(value: string, contentType: string): HttpBody {
  return { kind: "text", value, contentType };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  return new ProviderHttpClient(options);
}

interface PreparedBody {
  readonly payload: string | undefined;
  readonly contentType: string | undefined;
}

interface AttemptContext {
  readonly method: HttpMethod;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: PreparedBody;
  readonly acceptStatuses: ReadonlySet<number>;
  readonly secrets: readonly string[];
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

const NO_BODY: PreparedBody = { payload: undefined, contentType: undefined };

/**
 * The redirect hop that follows `status`, per RFC 9110 §15.4: 303 is always
 * rewritten to a bodiless GET (HEAD stays HEAD), 301 and 302 are rewritten the
 * same way after a POST by universal practice, and only 307/308 may replay the
 * original method and body. Without this a POST answered with a 303 would be
 * re-sent as a second mutating POST — exactly what the non-idempotent retry
 * guard refuses to do.
 */
function redirectedRequest(
  context: AttemptContext,
  status: number,
  target: URL,
): AttemptContext {
  const rewrite =
    status === 303 ||
    ((status === 301 || status === 302) && context.method === "POST");
  if (!rewrite) return { ...context, url: target };
  return {
    ...context,
    url: target,
    method: context.method === "HEAD" ? "HEAD" : "GET",
    body: NO_BODY,
    headers: withoutHeader(context.headers, "content-type"),
  };
}

function withoutHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).filter(([header]) => header !== name),
  );
}

class ProviderHttpClient implements HttpClient {
  readonly baseUrl: string;

  private readonly base: URL;
  private readonly providerLabel: string;
  private readonly auth: HttpAuthProvider | undefined;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly responseCeilingBytes: number;
  private readonly onDiagnostic:
    ((diagnostic: HttpDiagnostic) => void) | undefined;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: HttpClientOptions) {
    this.base = strictHttpUrl(options.baseUrl);
    this.base.search = "";
    // The trailing slash must be stripped from the *string*, never through the
    // URL: `pathname = ""` on an http(s) URL normalizes straight back to "/",
    // so a base URL with no path (`https://api.pantheon.io`) would keep its
    // slash and every request would be sent to `https://api.pantheon.io//v0/…`.
    this.baseUrl = this.base.origin + this.base.pathname.replace(/\/+$/, "");
    this.providerLabel = options.providerLabel ?? "provider";
    this.auth = options.auth;
    this.defaultHeaders = lowerCaseHeaders({
      accept: "application/json",
      ...options.defaultHeaders,
    });
    this.timeoutMs = positiveDuration(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Request timeout",
    );
    this.totalTimeoutMs = positiveDuration(
      options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
      "Total request timeout",
    );
    this.retry = mergeRetryPolicy(DEFAULT_RETRY_POLICY, options.retry);
    this.responseCeilingBytes =
      options.responseCeilingBytes ?? HTTP_RESPONSE_CEILING_BYTES;
    if (
      !Number.isSafeInteger(this.responseCeilingBytes) ||
      this.responseCeilingBytes < 1 ||
      this.responseCeilingBytes > HTTP_RESPONSE_CEILING_BYTES
    )
      throw new CliError(
        "usage_error",
        "HTTP response limit must be between 1 byte and 25 MiB.",
      );
    this.onDiagnostic = options.onDiagnostic;
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  async json<T = unknown>(request: HttpRequest): Promise<T> {
    return (await this.request<T>(request)).data;
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const method = request.method ?? "GET";
    const url = this.resolveUrl(request);
    const retry = mergeRetryPolicy(this.retry, request.retry);
    const timeoutMs = positiveDuration(
      request.timeoutMs ?? this.timeoutMs,
      "Request timeout",
    );
    const totalTimeoutMs = positiveDuration(
      request.totalTimeoutMs ?? this.totalTimeoutMs,
      "Total request timeout",
    );
    const deadline = Date.now() + totalTimeoutMs;
    const retryable = request.idempotent ?? SAFE_METHODS.has(method);
    const maxAttempts = retryable ? Math.max(1, retry.maxAttempts) : 1;

    const authorization =
      request.anonymous === true || this.auth === undefined
        ? undefined
        : await this.auth.authorize();
    const secrets = [
      ...(authorization?.secrets ?? []),
      ...(request.secrets ?? []),
      ...collectSensitiveValues(request.headers),
      ...collectSensitiveValues(request.query),
      ...collectSensitiveValues(request.body),
    ].filter((secret) => secret !== "");
    const headers = lowerCaseHeaders({
      ...this.defaultHeaders,
      ...request.headers,
      ...lowerCaseHeaders(authorization?.headers ?? {}),
    });
    const body = prepareBody(request.body);

    for (let attempt = 1; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw this.timeoutError(method, url, attempt, secrets);
      try {
        return await this.attempt<T>({
          method,
          url,
          headers:
            body.contentType === undefined
              ? headers
              : { "content-type": body.contentType, ...headers },
          body,
          acceptStatuses: new Set(request.acceptStatuses ?? []),
          secrets,
          attempt,
          timeoutMs: Math.min(timeoutMs, remaining),
          signal: request.signal,
        });
      } catch (error) {
        const failure = asProviderError(error, this.providerLabel);
        if (!failure.retryable || attempt >= maxAttempts) {
          this.diagnostic(
            {
              phase: "failure",
              method,
              origin: url.origin,
              path: url.pathname,
              attempt,
              code: failure.code,
            },
            secrets,
          );
          throw failure;
        }
        const waitMs = this.retryDelayMs(failure, attempt, retry);
        if (waitMs === undefined || Date.now() + waitMs >= deadline) {
          this.diagnostic(
            {
              phase: "failure",
              method,
              origin: url.origin,
              path: url.pathname,
              attempt,
              code: failure.code,
            },
            secrets,
          );
          throw failure;
        }
        this.diagnostic(
          {
            phase: "retry",
            method,
            origin: url.origin,
            path: url.pathname,
            attempt,
            retryInMs: waitMs,
            code: failure.code,
          },
          secrets,
        );
        await this.pause(waitMs, request.signal);
      }
    }
  }

  async poll<T = unknown>(
    request: HttpRequest,
    options: PollOptions<T>,
  ): Promise<HttpResponse<T>> {
    const deadlineMs = positiveDuration(
      options.deadlineMs ?? DEFAULT_POLL_DEADLINE_MS,
      "Polling deadline",
    );
    const maxIntervalMs = positiveDuration(
      options.maxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS,
      "Polling interval",
    );
    const backoffFactor = Math.max(1, options.backoffFactor ?? 1.5);
    let intervalMs = Math.min(
      maxIntervalMs,
      positiveDuration(
        options.initialIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        "Polling interval",
      ),
    );
    const deadline = Date.now() + deadlineMs;

    for (let attempt = 1; ; attempt += 1) {
      const pollRequest: HttpRequest =
        options.signal === undefined
          ? request
          : { ...request, signal: options.signal };
      const response = await this.request<T>(pollRequest);
      if (options.isComplete(response)) return response;
      if (Date.now() + intervalMs >= deadline)
        throw new CliError(
          "timeout",
          `The ${this.providerLabel} operation did not finish before the polling deadline.`,
          { retryable: true, details: { attempts: attempt } },
        );
      await this.pause(intervalMs, options.signal);
      intervalMs = Math.min(maxIntervalMs, intervalMs * backoffFactor);
    }
  }

  private async attempt<T>(context: AttemptContext): Promise<HttpResponse<T>> {
    const startedAt = Date.now();
    // One absolute deadline for the whole attempt, redirect hops included.
    // A fresh `AbortSignal.timeout(timeoutMs)` per hop would let a chain run
    // for `MAX_REDIRECTS + 1` times the configured timeout. `context.timeoutMs`
    // is already clamped to what is left of the total budget by `request`.
    const attemptDeadline = startedAt + context.timeoutMs;
    let hop = context;

    for (let redirects = 0; ; redirects += 1) {
      const remainingMs = attemptDeadline - Date.now();
      if (remainingMs <= 0) throw this.attemptTimeout(hop);
      const timeoutSignal = AbortSignal.timeout(remainingMs);
      const signal =
        hop.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([timeoutSignal, hop.signal]);

      this.diagnostic(
        {
          phase: "request",
          method: hop.method,
          origin: hop.url.origin,
          path: hop.url.pathname,
          attempt: hop.attempt,
        },
        hop.secrets,
      );

      let response: Response;
      try {
        response = await this.fetchImplementation(hop.url, {
          method: hop.method,
          headers: { ...hop.headers },
          ...(hop.body.payload === undefined ? {} : { body: hop.body.payload }),
          redirect: "manual",
          signal,
        });
      } catch (cause) {
        throw this.transportError(cause, hop, timeoutSignal);
      }

      this.diagnostic(
        {
          phase: "response",
          method: hop.method,
          origin: hop.url.origin,
          path: hop.url.pathname,
          attempt: hop.attempt,
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
        hop.secrets,
      );

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelBody(response);
        const location = response.headers.get("location");
        if (location === null || redirects >= MAX_REDIRECTS)
          throw new CliError(
            "provider_error",
            `The ${this.providerLabel} API returned an unusable redirect.`,
            { details: this.errorDetails(hop, hop.url, response.status) },
          );
        const target = strictHttpUrl(new URL(location, hop.url));
        if (target.origin !== hop.url.origin)
          throw new CliError(
            "provider_error",
            `The ${this.providerLabel} API attempted a cross-origin redirect.`,
            { details: this.errorDetails(hop, hop.url, response.status) },
          );
        hop = redirectedRequest(hop, response.status, target);
        continue;
      }

      const text = await this.readBody(response, hop);
      const accepted =
        (response.status >= 200 && response.status < 300) ||
        hop.acceptStatuses.has(response.status);
      if (!accepted) throw this.responseError(hop, hop.url, response, text);

      let data: unknown;
      try {
        data = text.trim() === "" ? null : (JSON.parse(text) as unknown);
      } catch (cause) {
        throw new CliError(
          "provider_error",
          `The ${this.providerLabel} API returned a response that is not valid JSON.`,
          {
            retryable: response.status >= 500,
            cause,
            details: this.errorDetails(hop, hop.url, response.status),
          },
        );
      }
      registerSensitiveValues(data, hop.secrets);

      return {
        status: response.status,
        headers: response.headers,
        url: hop.url.toString(),
        data: data as T,
        text,
        attempts: hop.attempt,
      };
    }
  }

  /** The attempt's own deadline ran out, redirect hops included. */
  private attemptTimeout(context: AttemptContext): CliError {
    return new CliError(
      "timeout",
      `The ${this.providerLabel} API request timed out.`,
      {
        retryable: true,
        details: this.errorDetails(context, context.url),
      },
    );
  }

  private async readBody(
    response: Response,
    context: AttemptContext,
  ): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.responseCeilingBytes) {
      await cancelBody(response);
      throw this.oversizedResponse(context);
    }
    if (response.body === null) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.responseCeilingBytes) {
          await reader.cancel().catch(() => undefined);
          throw this.oversizedResponse(context);
        }
        chunks.push(value);
      }
    } catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw new CliError(
        "network_error",
        `The ${this.providerLabel} API response was interrupted.`,
        {
          retryable: true,
          cause,
          details: this.errorDetails(context, context.url, response.status),
        },
      );
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  private oversizedResponse(context: AttemptContext): CliError {
    return new CliError(
      "provider_error",
      `The ${this.providerLabel} API response exceeded the configured safety limit.`,
      { details: this.errorDetails(context, context.url) },
    );
  }

  private transportError(
    cause: unknown,
    context: AttemptContext,
    timeoutSignal: AbortSignal,
  ): CliError {
    const details = this.errorDetails(context, context.url);
    if (context.signal?.aborted === true)
      return new CliError(
        "network_error",
        `The ${this.providerLabel} API request was cancelled.`,
        { cause, details },
      );
    if (timeoutSignal.aborted)
      return new CliError(
        "timeout",
        `The ${this.providerLabel} API request timed out.`,
        { retryable: true, cause, details },
      );
    return new CliError(
      "network_error",
      `The ${this.providerLabel} API could not be reached.`,
      { retryable: true, cause, details },
    );
  }

  private responseError(
    context: AttemptContext,
    url: URL,
    response: Response,
    text: string,
  ): CliError {
    const status = response.status;
    const code = statusErrorCode(status);
    const remote = remoteMessage(text, context.secrets);
    const safeRemote =
      remote === undefined
        ? undefined
        : truncate(redactText(remote, context.secrets), ERROR_MESSAGE_LIMIT);
    const summary = `The ${this.providerLabel} API request failed with HTTP ${String(status)}`;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    const details: Record<string, unknown> = {
      ...this.errorDetails(context, url, status),
    };
    if (retryAfterMs !== undefined) details.retryAfterMs = retryAfterMs;

    return new CliError(
      code,
      safeRemote === undefined || safeRemote === ""
        ? `${summary}.`
        : `${summary}: ${safeRemote}`,
      {
        retryable: RETRYABLE_STATUSES.has(status),
        details,
      },
    );
  }

  private errorDetails(
    context: AttemptContext,
    url: URL,
    status?: number,
  ): Readonly<Record<string, unknown>> {
    return redact(
      {
        provider: this.providerLabel,
        method: context.method,
        origin: url.origin,
        path: url.pathname,
        attempt: context.attempt,
        ...(status === undefined ? {} : { status }),
      },
      context.secrets,
    ) as Readonly<Record<string, unknown>>;
  }

  private timeoutError(
    method: HttpMethod,
    url: URL,
    attempt: number,
    secrets: readonly string[],
  ): CliError {
    return new CliError(
      "timeout",
      `The ${this.providerLabel} API request exceeded its total time budget.`,
      {
        retryable: true,
        details: redact(
          {
            provider: this.providerLabel,
            method,
            origin: url.origin,
            path: url.pathname,
            attempt,
          },
          secrets,
        ) as Readonly<Record<string, unknown>>,
      },
    );
  }

  private retryDelayMs(
    error: CliError,
    attempt: number,
    retry: RetryPolicy,
  ): number | undefined {
    const retryAfter = error.details?.retryAfterMs;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      if (retryAfter > retry.retryAfterCeilingMs) return undefined;
      return Math.max(0, Math.ceil(retryAfter));
    }
    const exponential =
      retry.initialDelayMs * Math.pow(retry.backoffFactor, attempt - 1);
    const capped = Math.min(retry.maxDelayMs, exponential);
    // Equal jitter: half the window is fixed, half is random.
    return Math.ceil(capped / 2 + this.random() * (capped / 2));
  }

  private async pause(ms: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.sleep(ms, signal);
    } catch (cause) {
      throw new CliError(
        "network_error",
        `The ${this.providerLabel} API request was cancelled.`,
        { cause },
      );
    }
  }

  private resolveUrl(request: HttpRequest): URL {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(request.path)
      ? strictHttpUrl(request.path)
      : strictHttpUrl(
          `${this.baseUrl}${request.path.startsWith("/") ? "" : "/"}${request.path}`,
        );
    if (target.origin !== this.base.origin)
      throw new CliError(
        "usage_error",
        "Provider requests must stay on the configured API origin.",
      );
    const search = buildQuery(request.query);
    if (search !== "") target.search = search;
    return target;
  }

  private diagnostic(
    diagnostic: HttpDiagnostic,
    secrets: readonly string[],
  ): void {
    if (this.onDiagnostic === undefined) return;
    this.onDiagnostic(redact(diagnostic, secrets) as HttpDiagnostic);
  }
}

function statusErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
    case 403:
      return "credential_invalid";
    case 404:
    case 410:
      return "not_found";
    case 408:
      return "timeout";
    case 409:
      return "conflict";
    case 422:
      return "schema_validation_failed";
    case 429:
      return "rate_limited";
    default:
      return "provider_error";
  }
}

function asProviderError(error: unknown, providerLabel: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    "provider_error",
    `The ${providerLabel} API request failed unexpectedly.`,
    { cause: error },
  );
}

/** Extracts the provider's own error message from a JSON error body. */
function remoteMessage(
  text: string,
  secrets: readonly string[],
): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return trimmed;
  const record = value as Record<string, unknown>;
  for (const key of [
    "message",
    "error_description",
    "detail",
    "description",
    "error",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "")
      return candidate;
    if (candidate !== null && typeof candidate === "object") {
      const nested = (candidate as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim() !== "") return nested;
    }
  }
  return JSON.stringify(redact(value, secrets));
}

function truncate(value: string, limit: number): string {
  const compact = value.replaceAll(/[\r\n\t]+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function prepareBody(body: HttpBody | undefined): PreparedBody {
  if (body === undefined) return { payload: undefined, contentType: undefined };
  switch (body.kind) {
    case "json": {
      // `JSON.stringify` yields `undefined` for these, which is not a body.
      const serializable =
        body.value !== undefined &&
        typeof body.value !== "function" &&
        typeof body.value !== "symbol";
      return serializable
        ? {
            payload: JSON.stringify(body.value),
            contentType: "application/json",
          }
        : { payload: undefined, contentType: undefined };
    }
    case "form":
      return {
        payload: new URLSearchParams(body.value).toString(),
        contentType: "application/x-www-form-urlencoded",
      };
    case "text":
      return { payload: body.value, contentType: body.contentType };
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

function buildQuery(query: QueryParameters | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  if (Array.isArray(query)) {
    for (const pair of query as QueryPairs)
      params.append(pair[0], String(pair[1]));
  } else {
    for (const [key, value] of Object.entries(
      query as Readonly<Record<string, string | number | boolean | undefined>>,
    ))
      if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

function lowerCaseHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    normalized[name.toLowerCase()] = value;
  return normalized;
}

function mergeRetryPolicy(
  base: RetryPolicy,
  overrides: Partial<RetryPolicy> | undefined,
): RetryPolicy {
  const merged: RetryPolicy = { ...base, ...overrides };
  if (
    !Number.isSafeInteger(merged.maxAttempts) ||
    merged.maxAttempts < 1 ||
    merged.initialDelayMs < 0 ||
    merged.maxDelayMs < 0 ||
    merged.backoffFactor < 1 ||
    merged.retryAfterCeilingMs < 0
  )
    throw new CliError("usage_error", "The HTTP retry policy is invalid.");
  return merged;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new CliError("usage_error", `${label} must be positive.`);
  return Math.ceil(value);
}

function strictHttpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("usage_error", "The provider API URL is invalid.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    throw new CliError(
      "usage_error",
      "The provider API URL must be HTTP, contain no credentials, and contain no fragment.",
    );
  return url;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal === undefined ? undefined : { signal });
}

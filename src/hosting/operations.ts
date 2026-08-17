// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Polling for long-running provider operations, ported from Go's
 * `waitForOperationStatus` in `internal/cli/wp_install.go`.
 *
 * Go put this next to the plugin-install command because that was its first
 * caller; HQ started the same way, in `src/cli/hosting-command.ts`. It is
 * provider machinery rather than CLI grammar — it takes a `ProviderClient` and
 * a budget and returns a provider status — and Phase 5's provisioning service
 * needs it without pulling `src/cli/` into its import graph, so it moves down
 * here. `src/cli/hosting-command.ts` re-exports both functions and the options
 * type, so no existing import or contract test changes.
 */

import { CliError } from "../errors.js";
import { redactAssociatedText } from "../output/redact.js";
import type { ProviderClient } from "./client.js";
import { redactOperationText, releaseOperationSecrets } from "./redaction.js";
import type { OperationStatus } from "./types.js";

export interface WaitForOperationOptions {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  /** Injectable for deterministic tests; defaults to a real timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

function realSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("The operation was cancelled.");
}

async function sleepWithSignal(
  sleep: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Go's `waitForOperationStatus`. Poll until the provider reports the operation
 * done or failed, or until the budget is spent.
 *
 * Go returned a bare `fmt.Errorf` for both failure modes; HQ separates them:
 * a zero interval is a `usage_error` (the user asked for a busy loop) and an
 * exhausted budget is `timeout`, which the taxonomy already marks retryable.
 * A *failed* operation is not an error here — it is returned, because several
 * callers inspect it before deciding whether to fail.
 */
export async function waitForOperationStatus(
  client: ProviderClient,
  operationId: string,
  options: WaitForOperationOptions,
): Promise<OperationStatus> {
  if (options.intervalSeconds <= 0) {
    throw new CliError(
      "usage_error",
      "--interval-seconds must be greater than zero.",
      { details: { flag: "--interval-seconds" } },
    );
  }
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutSeconds * 1000;
  const timedOut = (): CliError => {
    const safeOperationId = redactOperationText(
      client,
      operationId,
      operationId,
    );
    releaseOperationSecrets(client, operationId);
    return new CliError(
      "timeout",
      `Timed out waiting for operation ${safeOperationId}.`,
      {
        retryable: true,
        details: {
          operationId: safeOperationId,
          timeoutSeconds: options.timeoutSeconds,
        },
      },
    );
  };
  for (;;) {
    options.signal?.throwIfAborted();
    if (now() >= deadline) throw timedOut();
    const status = await client.operationStatus(operationId);
    options.signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw timedOut();
    if (status.done || status.failed) return status;
    const sleepMs = Math.min(options.intervalSeconds * 1000, remaining);
    await (options.sleep === undefined
      ? realSleep(sleepMs, options.signal)
      : sleepWithSignal(sleep(sleepMs), options.signal));
  }
}

/**
 * The error Go raised for an operation the provider reported as failed,
 * mapped onto `provider_error`.
 */
export function operationFailure(status: OperationStatus): CliError {
  const operationId = redactAssociatedText(status.operationId, status);
  return new CliError(
    "provider_error",
    redactAssociatedText(
      `Operation ${status.operationId} failed: ${status.message ?? "provider reported failure"}`,
      status,
    ),
    {
      details: {
        provider: status.provider,
        operationId,
        status: status.status,
      },
    },
  );
}

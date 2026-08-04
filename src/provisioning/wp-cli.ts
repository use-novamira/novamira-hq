// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Running a WP-CLI command through a provider and reading its output back,
 * ported from `wpCliOutput`, `unwrapWpCliOutputString`, `wpCliOutputFromArray`,
 * `pointerValue`, `cleanWpCliCommandOutput`, `runWpCliCommandAndWait` and
 * `runWpCliCommandForOutput` in `internal/cli/hosting_novamira.go`.
 *
 * The eight providers HQ speaks to agree on nothing about where a WP-CLI run's
 * text ends up. Kinsta puts it at `/data/result`, Pressable at `/data/output`,
 * Rocket.net at `/result/response` — sometimes as a JSON document smuggled
 * inside that string — and InstaWP returns an array of per-command records.
 * {@link wpCliOutput} tries every shape Go tried, in Go's order, and returns
 * `""` rather than throwing when none matches; the caller decides whether an
 * empty result is a failure, because for `wp option update` it is not and for
 * `wp option get home` it is.
 *
 * Several providers also echo the command back before its output, some with a
 * timestamp prefix. {@link cleanWpCliOutput} strips that echo, and only that
 * echo: it stops at the first line that is not an echo, so a command name that
 * legitimately reappears later in the output survives.
 *
 * This module was `src/cli/hosting/wp.ts`'s private machinery, with a standing
 * comment promising the lift once provisioning landed. It has landed: the
 * provisioning service must be callable from Phase 6's dashboard with no
 * commander in the graph, so the extraction lives here and `wp.ts` imports it.
 */

import { CliError, asCliError } from "../errors.js";
import type { ProviderClient } from "../hosting/client.js";
import { waitForOperationStatus } from "../hosting/operations.js";
import { wpCliCommandPayload } from "../hosting/shell.js";
import type { ActionResult, OperationStatus } from "../hosting/types.js";
import { asRecord, jsonPointerLookupString } from "../json.js";

/** How long a caller is willing to poll a provider operation. */
export interface PollBudget {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Output extraction                                                          */
/* -------------------------------------------------------------------------- */

/** Where providers put the textual result of a WP-CLI run, in Go's order. */
const WP_CLI_OUTPUT_POINTERS = [
  "/data/result",
  "/data/output",
  "/data",
  "/result/response",
  "/result/output",
  "/result",
  "/output",
  "/response",
] as const;

/** The pointers whose value may instead be a list of per-command results. */
const WP_CLI_OUTPUT_LIST_POINTERS = ["/data", "/result"] as const;

/** The keys a list entry may carry its output under. */
const WP_CLI_OUTPUT_KEYS = ["output", "result", "response"] as const;

/**
 * Go's `pointerValue`, for the two list-shaped pointers only. Neither `/data`
 * nor `/result` contains an RFC 6901 escape, so token decoding — which
 * {@link jsonPointerLookupString} still performs for the string lookups — is
 * not repeated here.
 */
function pointerValue(value: unknown, pointer: string): unknown {
  let current: unknown = value;
  for (const token of pointer.slice(1).split("/")) {
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[token];
  }
  return current;
}

/** Go's `unwrapWpCliOutputString`: a JSON document smuggled inside a string. */
function unwrapWpCliOutputString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
  for (const pointer of ["/data", "/output", "/response"]) {
    const found = jsonPointerLookupString(parsed, pointer);
    if (found !== undefined) return found;
  }
  return value;
}

/** Go's `wpCliOutputFromArray`. */
function wpCliOutputFromArray(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const entries = value as readonly unknown[];
  const parts: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    for (const key of WP_CLI_OUTPUT_KEYS) {
      const text = record[key];
      if (typeof text === "string" && text.trim() !== "") {
        parts.push(text);
        break;
      }
    }
  }
  return parts.join("\n");
}

/**
 * Go's `wpCliOutput`: the textual result of a WP-CLI operation, wherever the
 * provider chose to put it. An unrecognised shape is `""`, never an error.
 */
export function wpCliOutput(raw: unknown): string {
  for (const pointer of WP_CLI_OUTPUT_POINTERS) {
    const found = jsonPointerLookupString(raw, pointer);
    if (found !== undefined) return unwrapWpCliOutputString(found);
  }
  for (const pointer of WP_CLI_OUTPUT_LIST_POINTERS) {
    const found = wpCliOutputFromArray(pointerValue(raw, pointer));
    if (found !== "") return found;
  }
  return "";
}

/**
 * Go's `cleanWpCliCommandOutput`. Strips the provider's leading echo of the
 * command — bare, or behind a timestamp prefix — and trailing carriage returns.
 *
 * The trailing trim is `/\r+$/`, not `/\r$/`: Go's `strings.TrimRight(s, "\r")`
 * takes a cutset and removes every trailing `\r`, which is what a provider that
 * pipes CRLF output through a CRLF transport actually produces.
 */
export function cleanWpCliOutput(output: string, command: string): string {
  const trimmed = output.trim();
  if (trimmed === "") return "";
  const lines = trimmed.split("\n");
  while (lines.length > 0) {
    const first = (lines[0] ?? "").replace(/\r+$/, "").trim();
    if (first === command || first.endsWith(` ${command}`)) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines
    .map((line) => line.replace(/\r+$/, ""))
    .join("\n")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Re-raise `error` with `prefix` in front of its message, keeping its code. */
export function contextualize(error: unknown, prefix: string): CliError {
  const cause = asCliError(error);
  return new CliError(cause.code, `${prefix}: ${cause.message}`, {
    retryable: cause.retryable,
    cause: error,
    ...(cause.remoteCode === undefined ? {} : { remoteCode: cause.remoteCode }),
    ...(cause.details === undefined ? {} : { details: cause.details }),
  });
}

function syncFailure(result: ActionResult): CliError {
  return new CliError(
    "provider_error",
    `Provider returned status ${String(result.status)}: ${result.message ?? "request failed"}`,
    { details: { provider: result.provider, status: result.status } },
  );
}

function asyncFailure(status: OperationStatus): CliError {
  return new CliError(
    "provider_error",
    `WP-CLI operation ${status.operationId} failed: ${status.message ?? "provider reported failure"}`,
    {
      details: {
        provider: status.provider,
        operationId: status.operationId,
        status: status.status,
      },
    },
  );
}

/**
 * Go's `runWpCliCommandAndWait`. `undefined` means the provider answered
 * synchronously and there is no operation to poll.
 */
export async function runWpCli(
  client: ProviderClient,
  envId: string,
  command: string,
  budget: PollBudget,
): Promise<OperationStatus | undefined> {
  const result = await client.action({
    kind: "run-wp-cli",
    envId,
    body: wpCliCommandPayload(command),
  });
  if (result.operationId === undefined) {
    if (result.status >= 400) throw syncFailure(result);
    return undefined;
  }
  return waitForOperationStatus(client, result.operationId, budget);
}

/**
 * Go's `runWpCliCommandForOutput`: dispatch, wait when the provider answered
 * asynchronously, then extract and echo-strip the textual result. An empty
 * result is not an error here — the caller decides.
 *
 * This cannot be built on {@link runWpCli}, which discards the synchronous
 * `ActionResult.raw` and so has nothing to extract from in that branch.
 */
export async function runWpCliForOutput(
  client: ProviderClient,
  envId: string,
  command: string,
  budget: PollBudget,
): Promise<string> {
  const result = await client.action({
    kind: "run-wp-cli",
    envId,
    body: wpCliCommandPayload(command),
  });
  if (result.operationId !== undefined) {
    const status = await waitForOperationStatus(
      client,
      result.operationId,
      budget,
    );
    if (status.failed) throw asyncFailure(status);
    return cleanWpCliOutput(wpCliOutput(status.raw), command);
  }
  if (result.status >= 400) throw syncFailure(result);
  return cleanWpCliOutput(wpCliOutput(result.raw), command);
}

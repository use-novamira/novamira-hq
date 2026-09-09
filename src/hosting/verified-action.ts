// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../errors.js";
import { asRecord } from "../json.js";
import type { ActionRequest, ProviderClient } from "./client.js";
import {
  operationFailure,
  waitForOperationStatus,
  type WaitForOperationOptions,
} from "./operations.js";
import type { ActionResult, OperationStatus } from "./types.js";

/** A transport failure after dispatch must never suggest replaying a write. */
export async function sendGuardedAction(
  client: ProviderClient,
  request: ActionRequest,
  signal?: AbortSignal,
): Promise<ActionResult> {
  signal?.throwIfAborted();
  try {
    return await client.action(request);
  } catch (error) {
    const failure = asCliError(error);
    throw new CliError(
      failure.code,
      `${failure.message} The request may already have taken effect. Verify at the provider before repeating it.`,
      {
        retryable: false,
        details: { mutationSent: null, completionVerified: false },
      },
    );
  }
}

/** Check runtime provider evidence rather than relying on TypeScript assertions. */
export function hasVerifiedCompletion(
  status: OperationStatus,
  provider: ProviderClient["provider"],
  operationId: string,
): boolean {
  const evidence = asRecord(status);
  return (
    evidence?.provider === provider &&
    evidence.operationId === operationId &&
    evidence.done === true &&
    evidence.failed === false &&
    typeof evidence.status === "number" &&
    evidence.status >= 200 &&
    evidence.status < 300 &&
    evidence.raw != null
  );
}

/** Guarded writes require positive completion evidence, never HTTP acceptance. */
export async function waitForVerifiedAction(
  client: ProviderClient,
  action: ActionResult,
  options: WaitForOperationOptions,
): Promise<OperationStatus> {
  try {
    if (
      action.provider !== client.provider ||
      action.status >= 400 ||
      !action.operationId
    )
      throw new CliError(
        "provider_error",
        "The provider did not supply a verifiable operation for the hosting request.",
      );
    const status = await waitForOperationStatus(
      client,
      action.operationId,
      options,
    );
    if (status.failed) throw operationFailure(status);
    if (!hasVerifiedCompletion(status, client.provider, action.operationId))
      throw new CliError(
        "provider_error",
        "The provider did not prove that the hosting operation completed.",
      );
    return status;
  } catch (error) {
    const failure = asCliError(error);
    throw new CliError(
      failure.code,
      `${failure.message} The request may already have taken effect. Verify at the provider before repeating it.`,
      {
        retryable: false,
        details: { mutationSent: true, completionVerified: false },
      },
    );
  }
}

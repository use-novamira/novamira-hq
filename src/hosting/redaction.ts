// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import {
  collectSensitiveValues,
  redact,
  redactText,
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../output/redact.js";
import type { ProviderClient } from "./client.js";

const OPERATION_SECRETS = new WeakMap<
  ProviderClient,
  Map<string, readonly string[]>
>();

/** Protects action inputs when a provider echoes them in a result or error. */
export function secretSafeProviderClient(
  client: ProviderClient,
): ProviderClient {
  const operationSecrets = new Map<string, readonly string[]>();
  const listPushTargets = client.listPushTargets?.bind(client);

  const safeClient: ProviderClient = {
    provider: client.provider,
    validate: () => client.validate(),
    listSites: (options) => client.listSites(options),
    getSite: (siteId) => client.getSite(siteId),
    listEnvironments: (siteId) => client.listEnvironments(siteId),
    ...(listPushTargets === undefined ? {} : { listPushTargets }),
    read: (request) => client.read(request),
    async action(request) {
      const secrets = collectSensitiveValues(
        "body" in request ? request.body : undefined,
      );
      try {
        const result = await client.action(request);
        const resultSecrets = mergeSecrets(
          secrets,
          registeredSensitiveValues(result.raw),
        );
        const safeResult =
          result.message === undefined
            ? result
            : {
                ...result,
                message: redactText(result.message, resultSecrets),
              };
        registerSensitiveValues(safeResult, resultSecrets);
        registerSensitiveValues(safeResult.raw, resultSecrets);
        if (safeResult.operationId !== undefined && resultSecrets.length > 0)
          operationSecrets.set(safeResult.operationId, resultSecrets);
        return safeResult;
      } catch (error) {
        throw safeProviderError(error, secrets);
      }
    },
    async operationStatus(operationId) {
      const secrets = operationSecrets.get(operationId) ?? [];
      try {
        const status = await client.operationStatus(operationId);
        const statusSecrets = mergeSecrets(
          secrets,
          registeredSensitiveValues(status.raw),
        );
        const safeStatus =
          status.message === undefined
            ? status
            : {
                ...status,
                message: redactText(status.message, statusSecrets),
              };
        registerSensitiveValues(safeStatus, statusSecrets);
        registerSensitiveValues(safeStatus.raw, statusSecrets);
        if (safeStatus.done || safeStatus.failed)
          operationSecrets.delete(operationId);
        return safeStatus;
      } catch (error) {
        throw safeProviderError(error, secrets);
      }
    },
    ...(client.wpCliResultsObservable === undefined
      ? {}
      : {
          wpCliResultsObservable: () =>
            client.wpCliResultsObservable?.() ?? true,
        }),
  };
  OPERATION_SECRETS.set(safeClient, operationSecrets);
  return safeClient;
}

/** Redacts text against the action secrets retained for one operation. */
export function redactOperationText(
  client: ProviderClient,
  operationId: string,
  value: string,
): string {
  return redactText(
    value,
    OPERATION_SECRETS.get(client)?.get(operationId) ?? [],
  );
}

/** Releases action secrets when a poller abandons an operation. */
export function releaseOperationSecrets(
  client: ProviderClient,
  operationId: string,
): void {
  OPERATION_SECRETS.get(client)?.delete(operationId);
}

function safeProviderError(
  error: unknown,
  secrets: readonly string[],
): unknown {
  if (secrets.length === 0) return error;
  if (!(error instanceof CliError)) return redact(error, secrets);
  const safe = new CliError(error.code, redactText(error.message, secrets), {
    retryable: error.retryable,
    ...(error.remoteCode === undefined
      ? {}
      : { remoteCode: redactText(error.remoteCode, secrets) }),
    ...(error.details === undefined
      ? {}
      : {
          details: redact(error.details, secrets) as Readonly<
            Record<string, unknown>
          >,
        }),
    ...(error.cause === undefined
      ? {}
      : { cause: redact(error.cause, secrets) }),
  });
  registerSensitiveValues(safe, secrets);
  return safe;
}

function mergeSecrets(
  ...groups: readonly (readonly string[])[]
): readonly string[] {
  return [...new Set(groups.flat())].sort(
    (left, right) => right.length - left.length,
  );
}

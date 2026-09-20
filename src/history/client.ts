// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../errors.js";
import {
  currentOperationContext,
  currentPushHistoryContext,
} from "../operation-context.js";
import type { ProviderClient } from "../hosting/client.js";
import type { ActionResult, OperationStatus } from "../hosting/types.js";
import { hasVerifiedCompletion } from "../hosting/verified-action.js";
import { asRecord } from "../json.js";
import {
  collectSensitiveValues,
  registeredSensitiveValues,
} from "../output/redact.js";
import {
  historyText,
  type HistoryChannel,
  type HistoryStore,
} from "./index.js";

/** Records provider requests and workflow correlation, never human approval. */
/**
 * What a push moves, written the way the dashboard writes it.
 *
 * The three parts are independent and any of them can be absent, so each is
 * dropped rather than rendered empty: a push carrying only the database reads
 * "database", never "database, , ".
 */
function pushScope(body: Readonly<Record<string, unknown>>): string {
  return [
    body.push_db === true ? "database" : undefined,
    body.push_files_option === "ALL_FILES"
      ? "all files"
      : body.push_files === true
        ? "selected files"
        : undefined,
    body.run_search_and_replace === true ? "search-replace" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

export function historyClient(
  client: ProviderClient,
  profile: string,
  history: HistoryStore,
  channel: () => HistoryChannel,
): ProviderClient {
  return {
    provider: client.provider,
    validate: () => client.validate(),
    listSites: (options) => client.listSites(options),
    getSite: (id) => client.getSite(id),
    listEnvironments: (id) => client.listEnvironments(id),
    read: (request) => client.read(request),
    ...(client.wpCliResultsObservable === undefined
      ? {}
      : {
          wpCliResultsObservable: () =>
            client.wpCliResultsObservable?.() ?? true,
        }),
    async action(request) {
      const body = asRecord("body" in request ? request.body : undefined) ?? {};
      const secrets = collectSensitiveValues(body);
      const workflow = currentOperationContext();
      if (workflow)
        workflow.observers.set(history, (status, errorCode) =>
          saveOutcome(() =>
            history.finishWorkflow(workflow.id, status, errorCode),
          ),
        );
      const environment =
        "envId" in request
          ? request.envId
          : "targetEnvId" in request
            ? request.targetEnvId
            : body.target_env_id;
      // Record intent before dispatch. No startup recovery replays an action.
      const id = await history.begin({
        ...(request.kind === "push-environment"
          ? currentPushHistoryContext()
          : {}),
        ...(workflow
          ? {
              workflowId: workflow.id,
              workflowKind: workflow.kind,
              workflowStatus: "running",
            }
          : {}),
        ...(typeof body.source_env_id === "string"
          ? {
              sourceEnvironmentId: historyText(body.source_env_id, secrets),
              scope: pushScope(body),
            }
          : {}),
        profile: historyText(profile),
        provider: client.provider,
        channel: channel(),
        action: request.kind,
        ...("siteId" in request
          ? { siteId: historyText(request.siteId, secrets) }
          : {}),
        ...(typeof environment === "string" && environment !== ""
          ? { environmentId: historyText(environment, secrets) }
          : {}),
      });
      let result: ActionResult;
      try {
        result = await client.action(request);
      } catch (error) {
        const code = asCliError(error).code;
        const rejected = [
          "usage_error",
          "provider_unsupported",
          "credential_missing",
          "credential_invalid",
          "confirmation_required",
        ].includes(code);
        await saveOutcome(() =>
          history.finish(id, rejected ? "failed" : "needs_verification", {
            errorCode: code,
          }),
        );
        throw error;
      }
      const operationId =
        result.operationId === undefined
          ? undefined
          : historyText(result.operationId, [
              ...secrets,
              ...registeredSensitiveValues(result),
              ...registeredSensitiveValues(result.raw),
            ]);
      await saveOutcome(() =>
        history.finish(
          id,
          result.status >= 400 ? "needs_verification" : "accepted",
          operationId ? { operationId } : {},
        ),
      );
      return result;
    },
    async operationStatus(operationId) {
      const observe = async (
        status: "needs_verification" | "accepted" | "succeeded" | "failed",
      ): Promise<void> => {
        if (
          (await history.list(profile)).some(
            (row) =>
              row.provider === client.provider &&
              row.operationId === operationId,
          )
        )
          await saveOutcome(() =>
            history.observe(profile, client.provider, operationId, status),
          );
      };
      let result: OperationStatus;
      try {
        result = await client.operationStatus(operationId);
      } catch (error) {
        await observe("needs_verification");
        throw error;
      }
      // Synthetic done:true with raw:null is not evidence of completion.
      const status =
        result.raw == null ||
        result.provider !== client.provider ||
        result.operationId !== operationId
          ? "needs_verification"
          : result.failed
            ? "failed"
            : hasVerifiedCompletion(result, client.provider, operationId)
              ? "succeeded"
              : "accepted";
      await observe(status);
      return result;
    },
  };
}

async function saveOutcome(save: () => Promise<void>): Promise<void> {
  try {
    await save();
  } catch {
    throw new CliError(
      "config_error",
      "The hosting request was sent, but its outcome could not be saved. Verify at the provider before repeating it.",
    );
  }
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { asCliError, type ErrorCode } from "./errors.js";

export type WorkflowKind = "novamira-setup" | "backup-restore";
export type WorkflowStatus = "running" | "succeeded" | "failed";
export interface OperationContext {
  readonly id: string;
  readonly kind: WorkflowKind;
  readonly observers: Map<
    object,
    (status: WorkflowStatus, errorCode?: ErrorCode) => Promise<void>
  >;
}
const context = new AsyncLocalStorage<OperationContext>();
/** Non-secret display metadata, persisted with the provider request before dispatch. */
export interface PushHistoryContext {
  readonly pushJobId: string;
  readonly pushName: string;
  readonly sourceUrl: string;
  readonly targetUrl: string;
}
const pushContext = new AsyncLocalStorage<PushHistoryContext>();
export const currentPushHistoryContext = (): PushHistoryContext | undefined =>
  pushContext.getStore();
export function withPushHistory<T>(
  metadata: PushHistoryContext,
  run: () => Promise<T>,
): Promise<T> {
  return pushContext.run(metadata, run);
}
export const currentOperationContext = (): OperationContext | undefined =>
  context.getStore();

/** Correlates child requests without logging arguments, bodies or outputs. */
export async function runHostingWorkflow<T>(
  kind: WorkflowKind,
  run: () => Promise<T>,
): Promise<T> {
  const operation: OperationContext = {
    id: randomUUID(),
    kind,
    observers: new Map(),
  };
  return context.run(operation, async () => {
    let outcome: WorkflowStatus = "failed";
    let errorCode: ErrorCode | undefined;
    try {
      const result = await run();
      outcome = "succeeded";
      return result;
    } catch (error) {
      errorCode = asCliError(error).code;
      throw error;
    } finally {
      for (const observer of operation.observers.values())
        await observer(outcome, errorCode);
    }
  });
}

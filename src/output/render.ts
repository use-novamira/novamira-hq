// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  asCliError,
  exitCodeFor,
  type CliError,
  type ErrorCode,
} from "../errors.js";
import { redact } from "./redact.js";

export interface OutputStreams {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export interface InvocationWarning {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** `meta` of a successful envelope. `requestId` is supplied by the renderer. */
export interface InvocationMeta {
  readonly requestId: string;
  readonly profile?: string;
  readonly provider?: string;
  readonly warnings?: readonly InvocationWarning[];
}

/** The part of `meta` a command contributes. */
export type CommandMeta = Omit<InvocationMeta, "requestId" | "warnings">;

export interface ErrorEnvelopeBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly remoteCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SuccessEnvelope {
  readonly ok: true;
  readonly data: unknown;
  readonly meta: InvocationMeta;
}

export interface FailureEnvelope {
  readonly ok: false;
  readonly error: ErrorEnvelopeBody;
}

export type Envelope = SuccessEnvelope | FailureEnvelope;

export interface SuccessOptions {
  /** Extra `meta` fields for the JSON envelope. */
  readonly meta?: CommandMeta;
  /** Non-fatal warnings: `meta.warnings` in JSON mode, stderr otherwise. */
  readonly warnings?: readonly InvocationWarning[];
  /** Human-mode rendering of `data`. Ignored in JSON mode. */
  readonly human?: string;
}

export interface RenderOptions {
  /** `--json`: emit exactly one JSON value on stdout. */
  readonly json?: boolean;
  /** `--quiet`: suppress warnings, notes and diagnostics. */
  readonly quiet?: boolean;
  /** `--verbose`: emit redacted diagnostics on stderr. */
  readonly verbose?: boolean;
  /** False for `--no-color` or `NO_COLOR`. Always false in JSON mode. */
  readonly color?: boolean;
  /** Injectable for deterministic tests; defaults to `crypto.randomUUID()`. */
  readonly requestId?: string | (() => string);
}

/**
 * The single writer for everything a command emits. Nothing else in HQ writes
 * to stdout or stderr, and `console` is never used.
 */
export interface Renderer {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  /** Correlation id echoed in `meta.requestId` and in diagnostics. */
  readonly requestId: string;
  /** Terminal success output. Call at most once per invocation. */
  success(data: unknown, options?: SuccessOptions): void;
  /** Terminal failure output. Returns the process exit code. */
  failure(error: unknown): number;
  /** `Warning: …` on stderr; suppressed by `--quiet`. */
  warn(message: string): void;
  /** Human-mode progress note on stderr; suppressed by `--json`/`--quiet`. */
  note(message: string): void;
  /** Redacted diagnostic on stderr; only with `--verbose` and not `--quiet`. */
  diagnostic(label: string, payload: unknown): void;
  /** Free-form human-mode stdout line; a no-op in JSON mode. */
  writeLine(text: string): void;
}

export function successEnvelope(
  data: unknown,
  meta: InvocationMeta,
): SuccessEnvelope {
  return { ok: true, data, meta };
}

export function failureEnvelope(error: CliError): FailureEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.remoteCode === undefined
        ? {}
        : { remoteCode: error.remoteCode }),
      ...(error.details === undefined
        ? {}
        : {
            details: redact(error.details) as Readonly<Record<string, unknown>>,
          }),
    },
  };
}

export function createRenderer(
  options: RenderOptions = {},
  streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr },
): Renderer {
  const json = options.json ?? false;
  const quiet = options.quiet ?? false;
  const verbose = options.verbose ?? false;
  const color = (options.color ?? true) && !json;
  const requestId =
    typeof options.requestId === "function"
      ? options.requestId()
      : (options.requestId ?? randomUUID());

  const writeStderrLine = (text: string): void => {
    streams.stderr.write(`${text}\n`);
  };

  const renderer: Renderer = {
    json,
    quiet,
    verbose,
    color,
    requestId,

    success(data, successOptions = {}) {
      const warnings =
        successOptions.warnings === undefined ||
        successOptions.warnings.length === 0
          ? undefined
          : successOptions.warnings;
      if (json) {
        streams.stdout.write(
          `${JSON.stringify(
            successEnvelope(data, {
              requestId,
              ...successOptions.meta,
              ...(warnings === undefined ? {} : { warnings }),
            }),
          )}\n`,
        );
        return;
      }
      if (warnings !== undefined && !quiet)
        for (const warning of warnings)
          writeStderrLine(`Warning: ${warning.message}`);
      if (successOptions.human !== undefined) {
        if (successOptions.human !== "")
          streams.stdout.write(`${successOptions.human}\n`);
        return;
      }
      if (data === undefined) return;
      streams.stdout.write(
        `${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`,
      );
    },

    failure(error) {
      const cliError = asCliError(error);
      renderer.diagnostic("error", { requestId, error: cliError });
      if (json)
        streams.stdout.write(`${JSON.stringify(failureEnvelope(cliError))}\n`);
      else writeStderrLine(`Error [${cliError.code}]: ${cliError.message}`);
      return exitCodeFor(cliError);
    },

    warn(message) {
      if (!quiet) writeStderrLine(`Warning: ${message}`);
    },

    note(message) {
      if (!quiet && !json) writeStderrLine(message);
    },

    diagnostic(label, payload) {
      if (!verbose || quiet) return;
      writeStderrLine(`${label}: ${JSON.stringify(redact(payload))}`);
    },

    writeLine(text) {
      if (!json) streams.stdout.write(`${text}\n`);
    },
  };

  return renderer;
}

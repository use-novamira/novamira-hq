// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

export const ERROR_CODES = [
  "usage_error",
  "config_error",
  "profile_not_found",
  "credential_missing",
  "credential_invalid",
  "provider_unsupported",
  "provider_error",
  "network_error",
  "timeout",
  "rate_limited",
  "not_found",
  "conflict",
  "schema_validation_failed",
  "confirmation_required",
  "integration_unavailable",
  // The provisioning preflight's verdict that the WordPress site itself cannot
  // run Novamira. Spelled and exited identically to the site CLI's code of the
  // same name, so an operator sees one answer from both tools.
  "server_unsupported",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  usage_error: 2,
  config_error: 2,
  profile_not_found: 2,
  credential_missing: 3,
  credential_invalid: 3,
  provider_unsupported: 4,
  provider_error: 4,
  network_error: 4,
  timeout: 4,
  rate_limited: 4,
  not_found: 4,
  conflict: 4,
  schema_validation_failed: 5,
  confirmation_required: 6,
  integration_unavailable: 4,
  server_unsupported: 4,
  internal_error: 1,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remoteCode: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      remoteCode?: string;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CliError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.remoteCode = options.remoteCode;
    this.details = options.details;
  }
}

export function exitCodeFor(error: CliError): number {
  return EXIT_CODES[error.code];
}

export function asCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError("internal_error", "An unexpected internal error occurred.", {
        cause: error,
      });
}

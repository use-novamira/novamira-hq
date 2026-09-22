// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Option parsers, validators and the option groups that repeat across the
 * hosting command tree, ported from `internal/cli/flagtypes.go` and the
 * `validateEnum` helper in `internal/cli/hosting.go`.
 *
 * Go declared one `*Flags` struct per command and validated inside `RunE`, so a
 * bad `--limit` surfaced as a cobra parse error for numbers and as an ad-hoc
 * `fmt.Errorf` for enums. HQ splits the two deliberately:
 *
 * - a **parser** ({@link parseUnsignedInteger}, {@link oneOf}, ...) runs during
 *   commander's own parse and throws `InvalidArgumentError`, exactly as
 *   `program.ts` already does for `--timeout`. `main.ts` turns commander
 *   failures into `usage_error`, so the exit code is 2 either way;
 * - a **validator** ({@link requireEnum}) runs inside a handler and throws
 *   `CliError("usage_error", ...)`, for the cases where the value did not come
 *   straight off argv.
 *
 * The `add*Options` helpers exist so seven command groups spell the same option
 * the same way. In particular {@link addSecretSourceOptions} is the only
 * sanctioned way to accept a secret: it offers a variable name, a path, or
 * stdin, and never a value.
 */

import { InvalidArgumentError, type Command } from "commander";

import { CliError } from "../errors.js";

/** Go's `--interval-seconds` default for every polling command. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Go's `--timeout-seconds` default for every polling command. */
export const DEFAULT_POLL_TIMEOUT_SECONDS = 300;

/** The `--from-json` value that means "read the payload from stdin". */
export const STDIN_PATH = "-";

/**
 * Go's `uint32`/`uint64` flag types. JavaScript has one number type, so the
 * guarantee is narrowed to "a non-negative safe integer": beyond
 * `Number.MAX_SAFE_INTEGER` a decimal literal no longer round-trips, and
 * silently sending a different number to a provider is worse than refusing.
 */
export function parseUnsignedInteger(value: string): number {
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError("must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new InvalidArgumentError(
      `must be at most ${String(Number.MAX_SAFE_INTEGER)}`,
    );
  return parsed;
}

/** As {@link parseUnsignedInteger}, but rejects zero. */
export function parsePositiveInteger(value: string): number {
  const parsed = parseUnsignedInteger(value);
  if (parsed === 0) throw new InvalidArgumentError("must be greater than zero");
  return parsed;
}

/**
 * Accumulator for a repeatable option, replacing cobra's `StringArrayVar`.
 * Register as `.option("--value <v>", "...", collect, [])`; commander passes the
 * previous value (the default on the first call) as the second argument.
 */
export function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/**
 * A parser that constrains an option to a fixed set, and narrows its type to
 * the union of the allowed literals. Go compared strings and returned
 * `providers.CacheKind` through a lossy `cacheKindFromArg` that mapped every
 * unknown value to `CacheSite`; here an unknown value cannot reach the handler.
 */
export function oneOf<const T extends string>(
  allowed: readonly T[],
): (value: string) => T {
  return (value: string): T => {
    if ((allowed as readonly string[]).includes(value)) return value as T;
    throw new InvalidArgumentError(`must be one of ${allowed.join(", ")}`);
  };
}

/**
 * Go's `validateEnum`, for a value a handler received from somewhere other than
 * commander's parser (a default, a config document, a dashboard request body).
 */
export function requireEnum<const T extends string>(
  value: string,
  flag: string,
  allowed: readonly T[],
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new CliError("usage_error", `Invalid value "${value}" for ${flag}.`, {
    details: { flag, allowed: [...allowed] },
  });
}

/* -------------------------------------------------------------------------- */
/* Shared option groups                                                       */
/* -------------------------------------------------------------------------- */

/** `--from-json <path>`, accepted by every command with a request body. */
export function addFromJsonOption(command: Command): Command {
  return command.option(
    "--from-json <path>",
    `read the request body from a JSON file, or ${STDIN_PATH} for stdin`,
  );
}

/**
 * The three ways a command may be pointed at a secret. `prefix` is the option
 * stem, so `addSecretSourceOptions(command, "admin-password", "the admin
 * password")` registers `--admin-password-env`, `--admin-password-stdin` and
 * `--admin-password-file`, matching {@link readSecret}'s `SecretSpec.prefix`.
 *
 * There is no `--<prefix>` option carrying the value itself, and there must
 * never be one: a secret in argv is visible in the process table.
 */
export function addSecretSourceOptions(
  command: Command,
  prefix: string,
  description: string,
): Command {
  return command
    .option(
      `--${prefix}-env <name>`,
      `name of the environment variable holding ${description}`,
    )
    .option(`--${prefix}-stdin`, `read ${description} from stdin`)
    .option(`--${prefix}-file <path>`, `path of a file holding ${description}`);
}

/** `--interval-seconds` / `--timeout-seconds`, for commands that poll. */
export function addPollingOptions(command: Command): Command {
  return command
    .option(
      "--interval-seconds <seconds>",
      "polling interval for asynchronous provider operations",
      parsePositiveInteger,
      DEFAULT_POLL_INTERVAL_SECONDS,
    )
    .option(
      "--timeout-seconds <seconds>",
      "polling timeout for asynchronous provider operations",
      parseUnsignedInteger,
      DEFAULT_POLL_TIMEOUT_SECONDS,
    );
}

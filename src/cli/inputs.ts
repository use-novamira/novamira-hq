// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared command inputs, ported from `internal/cli/helpers.go`.
 *
 * Everything a hosting command reads from outside the process — stdin, a file
 * the user named on the command line, an environment variable holding a
 * secret — goes through the {@link CommandIo} seam declared here. Go reached
 * for `os.Stdin`, `os.ReadFile` and `os.LookupEnv` directly from inside the
 * payload builders, which made them untestable without a real process
 * environment; HQ injects them instead, so every payload contract test runs
 * offline and deterministically and no test can accidentally consume the real
 * stdin.
 *
 * Go's helpers all return `fmt.Errorf` strings. HQ maps them onto the
 * `CliError` taxonomy (`src/errors.ts`): everything the user could have typed
 * differently is `usage_error`, and a secret that the user pointed at but that
 * turned out to be absent or empty is `credential_missing`, which the v1
 * contract defines as "an absent secret" and which exits 3 rather than 2.
 */

import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";

import { atomicWritePrivateFile } from "../config/atomic-write.js";
import {
  defaultFileSecurity,
  type VerifiedFileSecurity,
} from "../config/file-security.js";
import { MAX_SECRET_BYTES } from "../credentials/resolve.js";
import { CliError } from "../errors.js";

/* -------------------------------------------------------------------------- */
/* JSON values                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A parsed JSON value. Go modelled request bodies as `map[string]any` and
 * `any`; HQ names the shape, so a payload builder cannot put a `Date`, a
 * `Buffer` or a function into a request body by accident.
 *
 * One deliberate difference from Go: Go decoded with `json.Number` so that a
 * `uint64` round-tripped exactly. `JSON.parse` produces IEEE-754 doubles, so an
 * integer beyond `Number.MAX_SAFE_INTEGER` inside a `--from-json` payload loses
 * precision. Provider ids that large do not occur in any of the eight provider
 * APIs, and the alternative — a bespoke JSON reader — would be a much larger
 * risk than the one it removes.
 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonRecord;

export interface JsonRecord {
  readonly [key: string]: JsonValue;
}

/** A JSON object under construction, before it is frozen into a `JsonRecord`. */
export type JsonBuilder = Record<string, JsonValue>;

/* -------------------------------------------------------------------------- */
/* The I/O seam                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The outside world, as a hosting command sees it. Implementations must be
 * side-effect free apart from the obvious ones; `readStdin` in particular is
 * expected to be idempotent, because a command may resolve both a secret and a
 * payload and stdin can only be drained once.
 */
export interface CommandIo {
  /** The environment secret references are resolved from. */
  readonly env: NodeJS.ProcessEnv;
  /** All of stdin, decoded as UTF-8. Memoized: repeated calls agree. */
  readStdin(maxBytes?: number): Promise<string>;
  /** Read a user-named text file. Rejects with the raw filesystem error. */
  readFile(path: string): Promise<string>;
  /** Read an owner-only regular file without following a final symlink. */
  readPrivateFile?(path: string, maxBytes: number): Promise<string>;
  /** Create or truncate `path` with owner-only permissions and write `content`. */
  writePrivateFile(path: string, content: string): Promise<void>;
}

export interface CommandIoOptions {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to draining file descriptor 0. */
  readonly readStdin?: (maxBytes?: number) => Promise<string>;
  /** Defaults to the platform file security used by the config store. */
  readonly security?: VerifiedFileSecurity;
  /** Defaults to `process.platform`; injectable for file-security tests. */
  readonly platform?: NodeJS.Platform;
}

async function drainStdin(maxBytes?: number): Promise<string> {
  // `process.stdin`'s async iterator is typed as yielding `any`; narrowing the
  // stream to a typed AsyncIterable keeps the loop body checked.
  const stream: AsyncIterable<Buffer | string> = process.stdin;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buffer.byteLength;
    if (maxBytes !== undefined && size > maxBytes) throw secretTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function secretTooLarge(path?: string): CliError {
  const description = path ?? "standard input";
  return new CliError(
    path === undefined ? "usage_error" : "credential_invalid",
    `The secret read from ${description} is larger than ${String(MAX_SECRET_BYTES)} bytes.`,
    { details: { source: path === undefined ? "stdin" : `file:${path}` } },
  );
}

/**
 * The production {@link CommandIo}. Stdin is read at most once per process and
 * the result cached, so `--command-stdin` and a `--from-json -` payload in the
 * same invocation see the same bytes instead of the second one silently
 * observing an empty stream.
 */
export function createCommandIo(options: CommandIoOptions = {}): CommandIo {
  const env = options.env ?? process.env;
  const read = options.readStdin ?? drainStdin;
  const platform = options.platform ?? process.platform;
  const security = options.security ?? defaultFileSecurity(platform);
  let pending: Promise<string> | undefined;

  return {
    env,
    async readStdin(maxBytes?: number): Promise<string> {
      pending ??= read(maxBytes);
      const value = await pending;
      if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes)
        throw secretTooLarge();
      return value;
    },
    async readFile(path: string): Promise<string> {
      return readFile(path, "utf8");
    },
    async readPrivateFile(path: string, maxBytes: number): Promise<string> {
      const flags =
        platform === "win32"
          ? constants.O_RDONLY
          : constants.O_RDONLY | constants.O_NOFOLLOW;
      let handle;
      try {
        const before = await lstat(path);
        if (before.isSymbolicLink())
          throw new CliError(
            "credential_invalid",
            `The secret file ${path} must not be a symbolic link.`,
            { details: { source: `file:${path}` } },
          );
        if (!before.isFile())
          throw new CliError(
            "credential_invalid",
            `The secret file ${path} is not a regular file.`,
          );
        if (before.size > maxBytes) throw secretTooLarge(path);

        if (platform === "win32") {
          if (!(await security.verifyFile(path)))
            throw new CliError(
              "credential_invalid",
              `The secret file ${path} is not owner-only.`,
              { details: { source: `file:${path}` } },
            );
          const verified = await lstat(path);
          if (
            verified.isSymbolicLink() ||
            verified.dev !== before.dev ||
            verified.ino !== before.ino
          )
            throw new CliError(
              "credential_invalid",
              `The secret file ${path} changed while it was being verified.`,
            );
        }

        handle = await open(path, flags);
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.dev !== before.dev ||
          info.ino !== before.ino
        )
          throw new CliError(
            "credential_invalid",
            `The secret file ${path} changed while it was being opened.`,
          );
        if (info.size > maxBytes) throw secretTooLarge(path);

        const ownerMatches =
          process.getuid === undefined || info.uid === process.getuid();
        const ownerOnly =
          platform === "win32" || (ownerMatches && (info.mode & 0o077) === 0);
        if (!ownerOnly)
          throw new CliError(
            "credential_invalid",
            `The secret file ${path} is not owner-only.`,
            { details: { source: `file:${path}` } },
          );

        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          const chunk = Buffer.alloc(Math.min(16 * 1024, maxBytes + 1 - size));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          size += bytesRead;
          if (size > maxBytes) throw secretTooLarge(path);
          chunks.push(chunk.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ELOOP" ||
          (error as NodeJS.ErrnoException).code === "EMLINK"
        )
          throw new CliError(
            "credential_invalid",
            `The secret file ${path} must not be a symbolic link.`,
            { cause: error, details: { source: `file:${path}` } },
          );
        if (
          error instanceof CliError ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          throw error;
        throw new CliError(
          "credential_invalid",
          `The secret file ${path} could not be safely read.`,
          { cause: error, details: { source: `file:${path}` } },
        );
      } finally {
        await handle?.close();
      }
    },
    async writePrivateFile(path: string, content: string): Promise<void> {
      await atomicWritePrivateFile(path, content, security);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Required options                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Go's `requiredString(optStr(value), flag)`: an unset option and an empty
 * option are the same thing, because cobra could not tell them apart. HQ keeps
 * that rule so `--display-name ""` fails the same way it does today.
 */
export function requireOption(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new CliError(
      "usage_error",
      `${flag} is required unless --from-json is used.`,
      { details: { flag } },
    );
  }
  return value;
}

/** Go's `requiredCopyU64`, for a numeric option with no meaningful default. */
export function requireNumberOption(
  value: number | undefined,
  flag: string,
): number {
  if (value === undefined) {
    throw new CliError(
      "usage_error",
      `${flag} is required unless --from-json is used.`,
      { details: { flag } },
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Files, stdin and JSON payloads                                             */
/* -------------------------------------------------------------------------- */

/** Read a file the user named on the command line. */
export async function readTextFile(
  path: string,
  label: string,
  io: CommandIo,
): Promise<string> {
  try {
    return await io.readFile(path);
  } catch (error) {
    throw new CliError("usage_error", `Failed to read the ${label} ${path}.`, {
      cause: error,
      details: { path },
    });
  }
}

/** Parse JSON text, reporting a parse failure as a usage error. */
export function parseJsonValue(text: string, context: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new CliError("usage_error", `Failed to parse ${context} as JSON.`, {
      cause: error,
      details: { context },
    });
  }
}

/** Go's `readJSONPayload`: a path, or `-` for stdin. */
export async function readJsonPayload(
  path: string,
  io: CommandIo,
): Promise<JsonValue> {
  if (path === "-")
    return parseJsonValue(await io.readStdin(), "the JSON payload on stdin");
  return parseJsonValue(
    await readTextFile(path, "JSON payload", io),
    `the JSON payload ${path}`,
  );
}

/** Trailing newline handling shared by every stdin reader (Go's TrimRight). */
function trimTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/, "");
}

/**
 * Go's `readStdinTrimmed`. `label` is a capitalised noun phrase so the error
 * reads as a sentence, e.g. "The WP-CLI command read from stdin was empty."
 */
export async function readStdinTrimmed(
  label: string,
  io: CommandIo,
): Promise<string> {
  const value = trimTrailingNewlines(await io.readStdin());
  if (value === "")
    throw new CliError("usage_error", `${label} read from stdin was empty.`);
  return value;
}

/** Go's `readStdinRaw`: every byte, newlines included. */
export async function readStdinRaw(io: CommandIo): Promise<string> {
  return io.readStdin();
}

/* -------------------------------------------------------------------------- */
/* Secret inputs                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where a command may read a secret from. A command NEVER takes a
 * secret-valued option, so there is deliberately no `value` member: the three
 * variants name an environment variable, name a file, or select stdin.
 */
export interface SecretSource {
  /** `--<prefix>-env <name>`: the NAME of an environment variable. */
  readonly env?: string;
  /** `--<prefix>-stdin`. */
  readonly stdin?: boolean;
  /** `--<prefix>-file <path>`. */
  readonly file?: string;
}

export interface SecretSpec {
  /** Capitalised noun phrase, e.g. `The admin password`. */
  readonly label: string;
  /** Option prefix without dashes, e.g. `admin-password`. */
  readonly prefix: string;
}

function provided(source: SecretSource): number {
  let count = 0;
  if (source.env !== undefined && source.env !== "") count++;
  if (source.stdin === true) count++;
  if (source.file !== undefined && source.file !== "") count++;
  return count;
}

/**
 * Go's `secretInput`: resolve exactly one of env/stdin/file.
 *
 * Neither the secret nor anything derived from it ever reaches the error
 * message or `details` — only the non-secret source description, in the same
 * `env:NAME` / `file:PATH` form the credential module uses.
 *
 * The stdin and file sources both drop trailing newlines, matching the v1
 * contract's rule for a `file` credential reference. Without it, `echo secret >
 * secret.txt` would send `"secret\n"` — a password nobody typed and no error
 * could explain, since the value is never echoed. An environment variable is
 * used verbatim: it carries no line terminator unless one was deliberately put
 * there.
 */
export async function readSecret(
  source: SecretSource,
  spec: SecretSpec,
  io: CommandIo,
): Promise<string> {
  if (provided(source) !== 1) {
    throw new CliError(
      "usage_error",
      `${spec.label} requires exactly one of --${spec.prefix}-env, --${spec.prefix}-stdin, or --${spec.prefix}-file.`,
      { details: { secret: spec.prefix } },
    );
  }

  if (source.env !== undefined && source.env !== "") {
    const name = source.env;
    const value = io.env[name];
    if (value === undefined) {
      throw new CliError(
        "credential_missing",
        `Environment variable ${name} is not set.`,
        { details: { source: `env:${name}` } },
      );
    }
    if (value === "") {
      throw new CliError(
        "credential_missing",
        `Environment variable ${name} is empty.`,
        { details: { source: `env:${name}` } },
      );
    }
    return value;
  }

  if (source.stdin === true) {
    const value = trimTrailingNewlines(await io.readStdin(MAX_SECRET_BYTES));
    if (value === "") {
      throw new CliError(
        "credential_missing",
        `${spec.label} read from stdin was empty.`,
        { details: { source: "stdin" } },
      );
    }
    return value;
  }

  const path = source.file ?? "";
  let value: string;
  try {
    value = trimTrailingNewlines(
      await (io.readPrivateFile?.(path, MAX_SECRET_BYTES) ?? io.readFile(path)),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "credential_missing",
      `Failed to read ${spec.label.replace(/^The /, "the ")} from ${path}.`,
      { cause: error, details: { source: `file:${path}` } },
    );
  }
  if (value === "") {
    throw new CliError(
      "credential_missing",
      `${spec.label} read from ${path} was empty.`,
      { details: { source: `file:${path}` } },
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* JSON pointers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `jsonPointerLookupString` now lives in `src/json.ts`, which has no CLI
 * dependency, because `src/provisioning/` needs it and must not import
 * `src/cli/`. It is re-exported here so every existing caller — and
 * `test/cli-foundations-contract.test.mjs` — keeps working unchanged.
 */
export { jsonPointerLookupString } from "../json.js";

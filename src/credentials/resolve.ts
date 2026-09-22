// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, stat } from "node:fs/promises";

import type { CredentialRef } from "../config/schema.js";
import {
  defaultFileSecurity,
  type VerifiedFileSecurity,
} from "../config/file-security.js";
import { CliError } from "../errors.js";
import { SecretValue, type CredentialStore } from "./store.js";

export { SECRET_PLACEHOLDER, SecretValue, type SecretSource } from "./store.js";

/**
 * Largest accepted secret. Provider API keys and machine tokens are a few
 * kilobytes at most; anything larger is a mis-pointed path or a paste accident.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

export interface CredentialResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: CredentialStore;
  readonly security?: VerifiedFileSecurity;
  readonly platform?: NodeJS.Platform;
}

export interface CredentialResolver {
  /** Resolves a reference to its secret at call time; nothing is cached. */
  resolve(ref: CredentialRef): Promise<SecretValue>;
}

export function createCredentialResolver(
  options: CredentialResolverOptions = {},
): CredentialResolver {
  return {
    resolve: async (ref: CredentialRef): Promise<SecretValue> =>
      resolveCredential(ref, options),
  };
}

export async function resolveCredential(
  ref: CredentialRef,
  options: CredentialResolverOptions = {},
): Promise<SecretValue> {
  switch (ref.type) {
    case "env":
      return resolveEnvCredential(ref.name, options.env ?? process.env);
    case "file":
      return resolveFileCredential(ref.path, options);
    case "stored":
      return resolveStoredCredential(ref.id, options.store);
    default:
      return unsupportedCredentialRef(ref);
  }
}

function resolveEnvCredential(
  name: string,
  env: NodeJS.ProcessEnv,
): SecretValue {
  if (name === "") {
    throw new CliError(
      "config_error",
      "The credential reference does not name an environment variable.",
    );
  }
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new CliError(
      "credential_missing",
      `The environment variable ${name} is not set; export the provider secret before running this command.`,
    );
  }
  return new SecretValue(value, "env", `env:${name}`);
}

async function resolveFileCredential(
  path: string,
  options: CredentialResolverOptions,
): Promise<SecretValue> {
  if (path === "") {
    throw new CliError(
      "config_error",
      "The credential reference does not name a file.",
    );
  }
  const platform = options.platform ?? process.platform;
  const security = options.security ?? defaultFileSecurity(platform);

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new CliError(
        "credential_invalid",
        `The credential file ${path} is not a regular file.`,
      );
    }
    size = info.size;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(
        "credential_missing",
        `The credential file ${path} does not exist.`,
        { cause: error },
      );
    }
    throw new CliError(
      "credential_invalid",
      `The credential file ${path} could not be read.`,
      { cause: error },
    );
  }

  if (size > MAX_SECRET_BYTES) {
    throw new CliError(
      "credential_invalid",
      `The credential file ${path} is larger than ${String(MAX_SECRET_BYTES)} bytes.`,
    );
  }

  // Fail closed: a credential file readable by anyone but its owner is treated
  // as compromised, never silently accepted.
  if (!(await isOwnerOnlyFile(path, security, platform))) {
    throw new CliError(
      "credential_invalid",
      `The credential file ${path} is not owner-only; restrict it to the owner (0600 on Unix) and try again.`,
    );
  }

  const raw = await readFile(path, "utf8");
  const value = raw.replace(/[\r\n]+$/, "");
  if (value === "") {
    throw new CliError(
      "credential_missing",
      `The credential file ${path} is empty.`,
    );
  }
  return new SecretValue(value, "file", `file:${path}`);
}

async function resolveStoredCredential(
  id: string,
  store: CredentialStore | undefined,
): Promise<SecretValue> {
  if (store === undefined) {
    throw new CliError(
      "internal_error",
      "No credential store is available to resolve a stored credential.",
    );
  }
  return store.require(id);
}

async function isOwnerOnlyFile(
  path: string,
  security: VerifiedFileSecurity,
  platform: NodeJS.Platform,
): Promise<boolean> {
  // Windows has no mode bits: delegate to the ACL check used for HQ's own
  // credential files. On Unix any group or other bit disqualifies the file;
  // stricter-than-0600 modes such as 0400 stay acceptable.
  if (platform === "win32") return security.verifyFile(path);
  const info = await stat(path);
  const ownerMatches =
    process.getuid === undefined || info.uid === process.getuid();
  return ownerMatches && (info.mode & 0o077) === 0;
}

/**
 * Reads a secret from a stream, normally `process.stdin`.
 *
 * Together with `env` and `file` references this is the only supported way to
 * feed a provider secret to HQ: no command, option, or argument ever takes a
 * secret value, so secrets never reach argv, shell history, or process listings.
 */
export async function readSecretFromStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<SecretValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.byteLength;
    if (size > MAX_SECRET_BYTES) {
      throw new CliError(
        "usage_error",
        `The secret read from standard input is larger than ${String(MAX_SECRET_BYTES)} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/[\r\n]+$/, "");
  if (value === "") {
    throw new CliError(
      "usage_error",
      "No secret was provided on standard input.",
    );
  }
  return new SecretValue(value, "stdin", "stdin");
}

function unsupportedCredentialRef(ref: never): never {
  // Only the discriminator is quoted. The reference itself is never
  // interpolated: a legacy inline `value` would otherwise be echoed straight
  // into the error output.
  const type: unknown = (ref as { readonly type?: unknown }).type;
  throw new CliError(
    "config_error",
    `The credential reference type ${typeof type === "string" ? JSON.stringify(type) : "(unknown)"} is not supported; use an env, file, or stored reference.`,
  );
}

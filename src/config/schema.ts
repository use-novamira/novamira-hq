// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import { isCredentialId } from "../credentials/store.js";

/**
 * The one and only on-disk configuration version. HQ's Go predecessor was never
 * released, so there is no legacy import and no migration path (plan §5.6):
 * any other version is rejected with `config_error`.
 */
export const CONFIG_FORMAT_VERSION = 1;

export const PROVIDER_KINDS = [
  "kinsta",
  "instawp",
  "pantheon",
  "pressable",
  "wpengine",
  "rocketnet",
  "hostinger",
  "cloudways",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return (
    typeof value === "string" &&
    (PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

// Provider defaults, ported verbatim from internal/config/config.go so the
// Phase 3 provider clients keep the Go behaviour for API base URLs and for the
// environment variables a credential reference defaults to.
export const DEFAULT_KINSTA_API_BASE_URL = "https://api.kinsta.com/v2";
export const DEFAULT_KINSTA_CREDENTIAL_ENV = "KINSTA_API_KEY";
export const DEFAULT_INSTAWP_API_BASE_URL = "https://app.instawp.io/api/v2";
export const DEFAULT_INSTAWP_CREDENTIAL_ENV = "INSTAWP_API_KEY";
export const DEFAULT_PRESSABLE_API_BASE_URL = "https://my.pressable.com/v1";
export const DEFAULT_PRESSABLE_CREDENTIAL_ENV = "PRESSABLE_CLIENT_SECRET";
export const DEFAULT_PRESSABLE_CLIENT_ID_ENV = "PRESSABLE_CLIENT_ID";
export const DEFAULT_PRESSABLE_TOKEN_URL =
  "https://my.pressable.com/auth/token";
export const DEFAULT_PANTHEON_API_BASE_URL = "https://api.pantheon.io";
export const DEFAULT_PANTHEON_CREDENTIAL_ENV = "PANTHEON_MACHINE_TOKEN";
export const DEFAULT_WPENGINE_API_BASE_URL = "https://api.wpengineapi.com/v1";
export const DEFAULT_WPENGINE_CREDENTIAL_ENV = "WPE_API_PASSWORD";
export const DEFAULT_WPENGINE_API_USER_ID_ENV = "WPE_API_USER_ID";
export const DEFAULT_ROCKETNET_API_BASE_URL = "https://api.rocket.net";
export const DEFAULT_ROCKETNET_CREDENTIAL_ENV = "ROCKETNET_PASSWORD";
export const DEFAULT_ROCKETNET_USERNAME_ENV = "ROCKETNET_USERNAME";
export const DEFAULT_HOSTINGER_API_BASE_URL =
  "https://developers.hostinger.com";
export const DEFAULT_HOSTINGER_CREDENTIAL_ENV = "HOSTINGER_API_TOKEN";
export const DEFAULT_CLOUDWAYS_API_BASE_URL =
  "https://api.cloudways.com/api/v2";
export const DEFAULT_CLOUDWAYS_CREDENTIAL_ENV = "CLOUDWAYS_API_KEY";
export const DEFAULT_CLOUDWAYS_EMAIL_ENV = "CLOUDWAYS_EMAIL";

export interface ProviderDefaults {
  readonly apiBaseUrl: string;
  /** Environment variable a `env` credential reference defaults to. */
  readonly credentialEnv: string;
  /**
   * Environment variable holding the non-secret identity half of a two-part
   * credential (API user id, username, email, OAuth client id). Never a secret.
   */
  readonly identityEnv?: string;
  /** OAuth token endpoint, for providers that exchange a client secret. */
  readonly tokenUrl?: string;
}

export const PROVIDER_DEFAULTS: Readonly<
  Record<ProviderKind, ProviderDefaults>
> = {
  kinsta: {
    apiBaseUrl: DEFAULT_KINSTA_API_BASE_URL,
    credentialEnv: DEFAULT_KINSTA_CREDENTIAL_ENV,
  },
  instawp: {
    apiBaseUrl: DEFAULT_INSTAWP_API_BASE_URL,
    credentialEnv: DEFAULT_INSTAWP_CREDENTIAL_ENV,
  },
  pantheon: {
    apiBaseUrl: DEFAULT_PANTHEON_API_BASE_URL,
    credentialEnv: DEFAULT_PANTHEON_CREDENTIAL_ENV,
  },
  pressable: {
    apiBaseUrl: DEFAULT_PRESSABLE_API_BASE_URL,
    credentialEnv: DEFAULT_PRESSABLE_CREDENTIAL_ENV,
    identityEnv: DEFAULT_PRESSABLE_CLIENT_ID_ENV,
    tokenUrl: DEFAULT_PRESSABLE_TOKEN_URL,
  },
  wpengine: {
    apiBaseUrl: DEFAULT_WPENGINE_API_BASE_URL,
    credentialEnv: DEFAULT_WPENGINE_CREDENTIAL_ENV,
    identityEnv: DEFAULT_WPENGINE_API_USER_ID_ENV,
  },
  rocketnet: {
    apiBaseUrl: DEFAULT_ROCKETNET_API_BASE_URL,
    credentialEnv: DEFAULT_ROCKETNET_CREDENTIAL_ENV,
    identityEnv: DEFAULT_ROCKETNET_USERNAME_ENV,
  },
  hostinger: {
    apiBaseUrl: DEFAULT_HOSTINGER_API_BASE_URL,
    credentialEnv: DEFAULT_HOSTINGER_CREDENTIAL_ENV,
  },
  cloudways: {
    apiBaseUrl: DEFAULT_CLOUDWAYS_API_BASE_URL,
    credentialEnv: DEFAULT_CLOUDWAYS_CREDENTIAL_ENV,
    identityEnv: DEFAULT_CLOUDWAYS_EMAIL_ENV,
  },
};

export function providerDefaults(provider: ProviderKind): ProviderDefaults {
  return PROVIDER_DEFAULTS[provider];
}

export function defaultApiBaseUrl(provider: ProviderKind): string {
  return PROVIDER_DEFAULTS[provider].apiBaseUrl;
}

export function defaultCredentialEnv(provider: ProviderKind): string {
  return PROVIDER_DEFAULTS[provider].credentialEnv;
}

/**
 * Where a credential reference points. A plaintext secret is never one of the
 * options: `stored` keeps an opaque id whose secret lives in HQ's credential
 * store (keychain, with an owner-only file fallback) — plan §5.5, decision 9.
 */
export type CredentialRef =
  | { readonly type: "env"; readonly name: string }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "stored"; readonly id: string };

export type CredentialRefType = CredentialRef["type"];

export const CREDENTIAL_REF_TYPES = ["env", "file", "stored"] as const;

export function envCredential(name: string): CredentialRef {
  return { type: "env", name };
}

export function fileCredential(path: string): CredentialRef {
  return { type: "file", path };
}

export function storedCredential(id: string): CredentialRef {
  return { type: "stored", id };
}

/** Non-secret description of where a credential lives, safe for any output. */
export function credentialSource(credential: CredentialRef): string {
  switch (credential.type) {
    case "env":
      return `env:${credential.name}`;
    case "file":
      return `file:${credential.path}`;
    case "stored":
      return `stored:${credential.id}`;
    default: {
      const unexpected: never = credential;
      return String(unexpected);
    }
  }
}

export interface HostingProfile {
  readonly provider: ProviderKind;
  readonly credential: CredentialRef;
  readonly companyId?: string;
  readonly apiBaseUrl?: string;
}

/** API base URL a profile talks to, falling back to the provider default. */
export function profileApiBaseUrl(profile: HostingProfile): string {
  return profile.apiBaseUrl ?? defaultApiBaseUrl(profile.provider);
}

/** A saved provider-environment to provider-environment push preset. */
export interface SavedPush {
  readonly name: string;
  readonly hostingProfile: string;
  readonly siteId: string;
  readonly siteLabel: string;
  readonly sourceEnvId: string;
  readonly sourceEnvName: string;
  readonly sourceEnvDomain?: string;
  readonly targetEnvId: string;
  readonly targetEnvName: string;
  readonly targetEnvDomain?: string;
  readonly pushDb: boolean;
  readonly pushFiles: boolean;
  readonly searchReplace: boolean;
}

/**
 * The `config.json` document. There is deliberately no `siteProfiles` field:
 * HQ never holds a site credential (boundary rule). Unknown fields — including
 * a stray `siteProfiles` left over from a hand-migrated `config.toml` — are
 * ignored on load and dropped on the next save.
 */
export interface ConfigDocument {
  readonly version: typeof CONFIG_FORMAT_VERSION;
  readonly hostingProfiles: Readonly<Record<string, HostingProfile>>;
  readonly pushes: Readonly<Record<string, SavedPush>>;
}

/**
 * A prototype-less map. Profile and push names are user-chosen and pass
 * a pattern that accepts `toString`, `constructor` and every other
 * `Object.prototype` member, so a plain `{}` would resolve those names to
 * inherited functions instead of reporting `profile_not_found`.
 */
export function emptyNameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyConfigDocument(): ConfigDocument {
  return {
    version: CONFIG_FORMAT_VERSION,
    hostingProfiles: emptyNameMap<HostingProfile>(),
    pushes: emptyNameMap<SavedPush>(),
  };
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function schemaError(path: string, requirement: string): CliError {
  return new CliError(
    "schema_validation_failed",
    `Configuration value ${path} ${requirement}`,
    { details: { path } },
  );
}

function configError(message: string, cause?: unknown): CliError {
  return new CliError(
    "config_error",
    message,
    cause === undefined ? {} : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw schemaError(path, "must be an object.");
  return value;
}

/** JSON `null` is treated as "absent" so optional fields round-trip cleanly. */
function optionalValue(record: Record<string, unknown>, key: string): unknown {
  const value = record[key];
  return value === null ? undefined : value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (typeof value !== "string")
    throw schemaError(`${path}.${key}`, "must be a string.");
  return value;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = requireString(record, key, path);
  if (value.trim() === "")
    throw schemaError(`${path}.${key}`, "must not be empty.");
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalValue(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw schemaError(`${path}.${key}`, "must be a string.");
  return value;
}

function optionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalString(record, key, path);
  if (value === undefined) return undefined;
  if (value.trim() === "")
    throw schemaError(`${path}.${key}`, "must not be empty.");
  return value;
}

function optionalStringOrEmpty(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  return optionalString(record, key, path) ?? "";
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = optionalValue(record, key);
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw schemaError(`${path}.${key}`, "must be a boolean.");
  return value;
}

/** Names double as map keys, lock keys, and keychain account components. */
export function validateProfileName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new CliError(
      "usage_error",
      "Hosting profile name must use 1-64 letters, numbers, dots, dashes, or underscores.",
    );
  }
  return name;
}

export function validateSavedPushName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new CliError(
      "usage_error",
      "Push name must use 1-64 letters, numbers, dots, dashes, or underscores.",
    );
  }
  return name;
}

export function parseProviderKind(value: unknown, path: string): ProviderKind {
  if (!isProviderKind(value)) {
    throw schemaError(
      path,
      `must be one of ${PROVIDER_KINDS.map((kind) => `"${kind}"`).join(", ")}.`,
    );
  }
  return value;
}

function parseApiBaseUrl(value: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw schemaError(path, "must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw schemaError(path, "must use the http or https scheme.");
  return value;
}

/**
 * Parse a credential reference. A `value` field is rejected outright rather
 * than ignored: legacy `config.toml` stored secrets inline, and silently
 * dropping one would leave the operator believing the secret was migrated.
 */
export function parseCredentialRef(
  value: unknown,
  path: string,
): CredentialRef {
  const record = requireRecord(value, path);
  if (record.value !== undefined) {
    throw schemaError(
      path,
      "must not carry an inline secret; use a stored credential id, an environment variable name, or a file path.",
    );
  }
  const type = requireString(record, "type", path);
  switch (type) {
    case "env": {
      const name = requireNonEmptyString(record, "name", path);
      if (!ENV_NAME_PATTERN.test(name))
        throw schemaError(
          `${path}.name`,
          "must be an environment variable name.",
        );
      return { type: "env", name };
    }
    case "file": {
      return {
        type: "file",
        path: requireNonEmptyString(record, "path", path),
      };
    }
    case "stored": {
      const id = requireNonEmptyString(record, "id", path);
      if (!isCredentialId(id))
        throw schemaError(
          `${path}.id`,
          "must be a 64-character lowercase hexadecimal credential id.",
        );
      return { type: "stored", id };
    }
    default:
      throw schemaError(
        `${path}.type`,
        `must be one of ${CREDENTIAL_REF_TYPES.map((kind) => `"${kind}"`).join(", ")}.`,
      );
  }
}

export function isCredentialRef(value: unknown): value is CredentialRef {
  try {
    parseCredentialRef(value, "credential");
    return true;
  } catch {
    return false;
  }
}

export function parseHostingProfile(
  value: unknown,
  path: string,
): HostingProfile {
  const record = requireRecord(value, path);
  const provider = parseProviderKind(record.provider, `${path}.provider`);
  const credential = parseCredentialRef(
    record.credential,
    `${path}.credential`,
  );
  const companyId = optionalNonEmptyString(record, "companyId", path);
  const apiBaseUrl = optionalNonEmptyString(record, "apiBaseUrl", path);
  return {
    provider,
    credential,
    ...(companyId === undefined ? {} : { companyId }),
    ...(apiBaseUrl === undefined
      ? {}
      : { apiBaseUrl: parseApiBaseUrl(apiBaseUrl, `${path}.apiBaseUrl`) }),
  };
}

export function isHostingProfile(value: unknown): value is HostingProfile {
  try {
    parseHostingProfile(value, "hostingProfile");
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a push. `name` may be omitted, in which case the map key is
 * used; when present it must match the key, so the record can never disagree
 * with the map it lives in.
 */
export function parseSavedPush(
  value: unknown,
  path: string,
  key?: string,
): SavedPush {
  const record = requireRecord(value, path);
  const declared = optionalNonEmptyString(record, "name", path);
  if (declared === undefined && key === undefined)
    throw schemaError(`${path}.name`, "must be a string.");
  const name = declared ?? key ?? "";
  if (key !== undefined && declared !== undefined && declared !== key)
    throw schemaError(`${path}.name`, `must match its key ${key}.`);
  validateSavedPushName(name);
  const sourceEnvId = requireNonEmptyString(record, "sourceEnvId", path);
  const targetEnvId = requireNonEmptyString(record, "targetEnvId", path);
  if (sourceEnvId === targetEnvId)
    throw schemaError(`${path}.targetEnvId`, "must differ from sourceEnvId.");
  return {
    name,
    hostingProfile: validateProfileName(
      requireNonEmptyString(record, "hostingProfile", path),
    ),
    siteId: requireNonEmptyString(record, "siteId", path),
    siteLabel: optionalStringOrEmpty(record, "siteLabel", path),
    sourceEnvId,
    sourceEnvName: optionalStringOrEmpty(record, "sourceEnvName", path),
    ...(record.sourceEnvDomain === undefined
      ? {}
      : {
          sourceEnvDomain: optionalStringOrEmpty(
            record,
            "sourceEnvDomain",
            path,
          ),
        }),
    targetEnvId,
    targetEnvName: optionalStringOrEmpty(record, "targetEnvName", path),
    ...(record.targetEnvDomain === undefined
      ? {}
      : {
          targetEnvDomain: optionalStringOrEmpty(
            record,
            "targetEnvDomain",
            path,
          ),
        }),
    pushDb: optionalBoolean(record, "pushDb", path),
    pushFiles: optionalBoolean(record, "pushFiles", path),
    searchReplace: optionalBoolean(record, "searchReplace", path),
  };
}

export function isSavedPush(value: unknown): value is SavedPush {
  try {
    parseSavedPush(value, "push");
    return true;
  } catch {
    return false;
  }
}

function parseRecordOf<T>(
  value: unknown,
  path: string,
  validateKey: (name: string) => string,
  parseEntry: (entry: unknown, entryPath: string, key: string) => T,
): Record<string, T> {
  if (value === undefined || value === null) return emptyNameMap<T>();
  const record = requireRecord(value, path);
  const parsed = emptyNameMap<T>();
  for (const [key, entry] of Object.entries(record)) {
    validateKey(key);
    parsed[key] = parseEntry(entry, `${path}.${key}`, key);
  }
  return parsed;
}

/**
 * Validate an unknown JSON value as a version-1 configuration document.
 * Structural problems (not an object, unsupported version) raise `config_error`;
 * field-level problems raise `schema_validation_failed` naming the exact path.
 */
export function parseConfigDocument(value: unknown): ConfigDocument {
  if (!isRecord(value))
    throw configError("Configuration file must contain a JSON object.");
  const version = value.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw configError(
      "Configuration file must declare a numeric version field.",
    );
  }
  if (version !== CONFIG_FORMAT_VERSION) {
    throw configError(
      `Configuration version ${String(version)} is not supported; only version ${String(CONFIG_FORMAT_VERSION)} exists.`,
    );
  }
  return {
    version: CONFIG_FORMAT_VERSION,
    hostingProfiles: parseRecordOf(
      value.hostingProfiles,
      "hostingProfiles",
      validateProfileName,
      (entry, entryPath) => parseHostingProfile(entry, entryPath),
    ),
    pushes: parseRecordOf(
      value.pushes,
      "pushes",
      validateSavedPushName,
      (entry, entryPath, key) => parseSavedPush(entry, entryPath, key),
    ),
  };
}

function sortedEntries<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const value = record[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/**
 * Render a document for disk: stable field order, keys sorted, trailing
 * newline. Nothing here is secret — `stored` credentials keep only an id.
 */
export function serializeConfigDocument(document: ConfigDocument): string {
  const ordered = {
    version: document.version,
    hostingProfiles: sortedEntries(document.hostingProfiles),
    pushes: sortedEntries(document.pushes),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

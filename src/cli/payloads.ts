// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Request-body builders shared across the hosting command groups, ported from
 * `internal/cli/payloads.go` plus the bodies that Go built inline inside
 * `hosting.go` and `access.go`.
 *
 * Each builder is `(options, io) => Promise<JsonValue>` and follows the same
 * rule as Go: when `--from-json` is given the file (or stdin) is the payload
 * verbatim and no other option is consulted; otherwise the body is assembled
 * from the options, with required ones reported as `usage_error` naming the
 * flag the user omitted.
 *
 * Two things changed on the way over.
 *
 * 1. Go passed a `*fooFlags` struct whose fields were all zero-valued strings
 *    and bools, so "unset" and "empty" were indistinguishable and every builder
 *    began with `optStr`. HQ takes an options object with genuinely optional
 *    members, and {@link requireOption} still treats `""` as absent so the
 *    observable behaviour is unchanged.
 * 2. `map[string]any` became {@link JsonValue}. A builder can no longer put a
 *    non-serialisable value into a request body.
 *
 * Dropped on the way over: `siteExecInput` and its `--set` / `--set-json` /
 * `--stdin-to` pointer machinery. It built the input of a WordPress Ability
 * call, and HQ never proxies an Ability (boundary rule).
 */

import { CliError } from "../errors.js";
import { assertNever } from "../hosting/client.js";
import type { CacheKind, Query } from "../hosting/types.js";
import {
  readJsonPayload,
  readSecret,
  readStdinTrimmed,
  readTextFile,
  requireNumberOption,
  requireOption,
  type CommandIo,
  type JsonBuilder,
  type JsonRecord,
  type JsonValue,
  type SecretSource,
  type SecretSpec,
} from "./inputs.js";

/** Go's `--wp-language` flag default. Kept here so the builder owns it. */
export const DEFAULT_WP_LANGUAGE = "en_US";

/** Go's `--root-directory` flag default for `access sftp add`. */
export const DEFAULT_SFTP_ROOT_DIRECTORY = "/";

/** Go's `--permission` flag default for `access sftp add`. */
export const DEFAULT_SFTP_PERMISSION = "read";

/** The secret spec for every `--admin-password-*` option group. */
export const ADMIN_PASSWORD_SECRET: SecretSpec = {
  label: "The admin password",
  prefix: "admin-password",
};

/** The secret spec for `access sftp add`'s `--password-*` option group. */
export const SFTP_PASSWORD_SECRET: SecretSpec = {
  label: "The SFTP password",
  prefix: "password",
};

/* -------------------------------------------------------------------------- */
/* Payload plumbing                                                           */
/* -------------------------------------------------------------------------- */

/** Options every payload-carrying command shares. */
export interface FromJsonOptions {
  /** `--from-json`: a path, or `-` for stdin. */
  readonly fromJson?: string;
}

/**
 * Go's `payloadOrObject`: the `--from-json` payload when given, else the built
 * object. `build` is only invoked in the second case, so a command that would
 * otherwise demand `--display-name` accepts a full JSON body instead.
 */
export async function payloadOrObject(
  fromJson: string | undefined,
  build: () => Promise<JsonRecord> | JsonRecord,
  io: CommandIo,
): Promise<JsonValue> {
  if (fromJson !== undefined && fromJson !== "")
    return readJsonPayload(fromJson, io);
  return build();
}

/** Go's `requiredPayload`: a command that has no option-driven form. */
export async function requiredPayload(
  fromJson: string | undefined,
  command: string,
  io: CommandIo,
): Promise<JsonValue> {
  if (fromJson === undefined || fromJson === "") {
    throw new CliError("usage_error", `${command} requires --from-json.`, {
      details: { command },
    });
  }
  return readJsonPayload(fromJson, io);
}

/**
 * Go's `pushQuery` appended to a `*[][2]string` in place. Building the whole
 * ordered list in one expression is both clearer and harder to get wrong, and
 * order is still significant: several provider APIs are sensitive to it.
 * `undefined` and `""` entries are skipped, matching `optStr`.
 */
export type QueryEntry = readonly [
  name: string,
  value: string | number | boolean | undefined,
];

export function buildQuery(entries: readonly QueryEntry[]): Query {
  const query: [string, string][] = [];
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    const rendered = typeof value === "string" ? value : String(value);
    if (rendered === "") continue;
    query.push([name, rendered]);
  }
  return query;
}

function stringList(values: readonly string[] | undefined): JsonValue {
  return [...(values ?? [])];
}

/** Go's `dnsValues`: `["1.2.3.4"]` becomes `[{"value":"1.2.3.4"}]`. */
function dnsValues(values: readonly string[]): JsonValue {
  return values.map((value) => ({ value }));
}

/* -------------------------------------------------------------------------- */
/* Sites                                                                      */
/* -------------------------------------------------------------------------- */

export interface SiteCreateOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly siteName?: string;
  readonly templateSlug?: string;
  readonly reserved?: boolean;
  readonly shared?: boolean;
  readonly email?: string;
  readonly region?: string;
  readonly siteTitle?: string;
  readonly adminEmail?: string;
  readonly adminUser?: string;
  readonly adminPasswordEnv?: string;
  readonly adminPasswordStdin?: boolean;
  readonly adminPasswordFile?: string;
  readonly wpLanguage?: string;
  readonly isMultisite?: boolean;
  readonly isSubdomainMultisite?: boolean;
  readonly woocommerce?: boolean;
  readonly wordpressseo?: boolean;
}

/**
 * `hosting sites create`. The first branch is InstaWP's template-driven form:
 * any one of its options switches the whole payload to that shape, exactly as
 * Go did, and none of the WordPress-install options are then required.
 */
export async function siteCreatePayload(
  options: SiteCreateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => {
      const reserved = options.reserved ?? false;
      const shared = options.shared ?? false;
      if (
        (options.siteName ?? "") !== "" ||
        (options.templateSlug ?? "") !== "" ||
        reserved ||
        shared ||
        (options.email ?? "") !== ""
      ) {
        const body: JsonBuilder = {};
        if ((options.siteName ?? "") !== "")
          body.site_name = options.siteName ?? "";
        if ((options.templateSlug ?? "") !== "")
          body.template_slug = options.templateSlug ?? "";
        if (reserved) body.is_reserved = true;
        if (shared) body.is_shared = true;
        if ((options.email ?? "") !== "") body.email = options.email ?? "";
        return body;
      }

      // Order matters: it decides which missing option the user is told about
      // first, and the Go CLI's order is the documented one.
      const displayName = requireOption(options.displayName, "--display-name");
      const region = requireOption(options.region, "--region");
      const adminEmail = requireOption(options.adminEmail, "--admin-email");
      const adminPassword = await readSecret(
        adminPasswordSource(options),
        ADMIN_PASSWORD_SECRET,
        io,
      );
      const adminUser = requireOption(options.adminUser, "--admin-user");
      const siteTitle = requireOption(options.siteTitle, "--site-title");
      return {
        display_name: displayName,
        region,
        install_mode: "new",
        admin_email: adminEmail,
        admin_password: adminPassword,
        admin_user: adminUser,
        site_title: siteTitle,
        wp_language: options.wpLanguage ?? DEFAULT_WP_LANGUAGE,
        is_multisite: options.isMultisite ?? false,
        is_subdomain_multisite: options.isSubdomainMultisite ?? false,
        woocommerce: options.woocommerce ?? false,
        wordpressseo: options.wordpressseo ?? false,
      };
    },
    io,
  );
}

function adminPasswordSource(options: {
  readonly adminPasswordEnv?: string;
  readonly adminPasswordStdin?: boolean;
  readonly adminPasswordFile?: string;
}): SecretSource {
  return {
    ...(options.adminPasswordEnv === undefined
      ? {}
      : { env: options.adminPasswordEnv }),
    ...(options.adminPasswordStdin === undefined
      ? {}
      : { stdin: options.adminPasswordStdin }),
    ...(options.adminPasswordFile === undefined
      ? {}
      : { file: options.adminPasswordFile }),
  };
}

export interface SiteCreatePlainOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly region?: string;
}

/** `hosting sites create-plain`. */
export async function siteCreatePlainPayload(
  options: SiteCreatePlainOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      display_name: requireOption(options.displayName, "--display-name"),
      region: requireOption(options.region, "--region"),
    }),
    io,
  );
}

export interface SiteCloneOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly sourceEnv?: string;
}

/** `hosting sites clone`. */
export async function siteClonePayload(
  options: SiteCloneOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      display_name: requireOption(options.displayName, "--display-name"),
      source_env_id: requireOption(options.sourceEnv, "--source-env"),
    }),
    io,
  );
}

export interface SiteResetOptions extends FromJsonOptions {
  readonly adminPasswordEnv?: string;
  readonly adminPasswordStdin?: boolean;
  readonly adminPasswordFile?: string;
}

/** `hosting sites reset`. */
export async function siteResetPayload(
  options: SiteResetOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => ({
      admin_password: await readSecret(
        adminPasswordSource(options),
        ADMIN_PASSWORD_SECRET,
        io,
      ),
    }),
    io,
  );
}

/* -------------------------------------------------------------------------- */
/* Environments                                                               */
/* -------------------------------------------------------------------------- */

export interface EnvironmentCreateOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly siteTitle?: string;
  readonly adminEmail?: string;
  readonly adminUser?: string;
  readonly adminPasswordEnv?: string;
  readonly adminPasswordStdin?: boolean;
  readonly adminPasswordFile?: string;
  readonly wpLanguage?: string;
  readonly isPremium?: boolean;
  readonly isMultisite?: boolean;
  readonly isSubdomainMultisite?: boolean;
  readonly woocommerce?: boolean;
  readonly wordpressPluginEdd?: boolean;
  readonly wordpressseo?: boolean;
}

/** `hosting envs create`. */
export async function environmentCreatePayload(
  options: EnvironmentCreateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => {
      const displayName = requireOption(options.displayName, "--display-name");
      const siteTitle = requireOption(options.siteTitle, "--site-title");
      const adminEmail = requireOption(options.adminEmail, "--admin-email");
      const adminPassword = await readSecret(
        adminPasswordSource(options),
        ADMIN_PASSWORD_SECRET,
        io,
      );
      const adminUser = requireOption(options.adminUser, "--admin-user");
      return {
        display_name: displayName,
        site_title: siteTitle,
        is_premium: options.isPremium ?? false,
        admin_email: adminEmail,
        admin_password: adminPassword,
        admin_user: adminUser,
        wp_language: options.wpLanguage ?? DEFAULT_WP_LANGUAGE,
        is_multisite: options.isMultisite ?? false,
        is_subdomain_multisite: options.isSubdomainMultisite ?? false,
        woocommerce: options.woocommerce ?? false,
        wordpress_plugin_edd: options.wordpressPluginEdd ?? false,
        wordpressseo: options.wordpressseo ?? false,
      };
    },
    io,
  );
}

export interface EnvironmentCreatePlainOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly isPremium?: boolean;
}

/** `hosting envs create-plain`. */
export async function environmentCreatePlainPayload(
  options: EnvironmentCreatePlainOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      display_name: requireOption(options.displayName, "--display-name"),
      is_premium: options.isPremium ?? false,
    }),
    io,
  );
}

export interface EnvironmentCloneOptions extends FromJsonOptions {
  readonly displayName?: string;
  readonly sourceEnv?: string;
  readonly isPremium?: boolean;
}

/** `hosting envs clone`. */
export async function environmentClonePayload(
  options: EnvironmentCloneOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      display_name: requireOption(options.displayName, "--display-name"),
      source_env_id: requireOption(options.sourceEnv, "--source-env"),
      is_premium: options.isPremium ?? false,
    }),
    io,
  );
}

export interface EnvironmentPushOptions extends FromJsonOptions {
  readonly sourceEnv?: string;
  readonly targetEnv?: string;
  readonly noDb?: boolean;
  readonly noFiles?: boolean;
  readonly noSearchReplace?: boolean;
  readonly file?: readonly string[];
}

/** `hosting envs push`. */
export async function environmentPushPayload(
  options: EnvironmentPushOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const sourceEnv = requireOption(options.sourceEnv, "--source-env");
      const targetEnv = requireOption(options.targetEnv, "--target-env");
      const files = options.file ?? [];
      const body: JsonBuilder = {
        source_env_id: sourceEnv,
        target_env_id: targetEnv,
        push_db: !(options.noDb ?? false),
        push_files: !(options.noFiles ?? false),
        run_search_and_replace: !(options.noSearchReplace ?? false),
      };
      if (files.length === 0) {
        body.push_files_option = "ALL_FILES";
      } else {
        body.push_files_option = "SPECIFIC_FILES";
        body.file_list = stringList(files);
      }
      return body;
    },
    io,
  );
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                    */
/* -------------------------------------------------------------------------- */

/** Accepted values of `hosting domains add --setup-type`. */
export const DOMAIN_SETUP_TYPES = ["quick", "avoid_downtime"] as const;

export type DomainSetupType = (typeof DOMAIN_SETUP_TYPES)[number];

export interface DomainAddOptions extends FromJsonOptions {
  readonly domainName?: string;
  readonly isWildcardless?: boolean;
  readonly addWithWwwSubdomain?: boolean;
  readonly setupType?: DomainSetupType;
  readonly customSslKeyFile?: string;
  readonly customSslCertFile?: string;
}

/**
 * `hosting domains add`. The SSL key and certificate are read from files and
 * placed in the request body; neither ever reaches argv, output or an error.
 */
export async function domainAddPayload(
  options: DomainAddOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => {
      const body: JsonBuilder = {
        domain_name: requireOption(options.domainName, "--domain-name"),
        is_wildcardless: options.isWildcardless ?? false,
        add_with_www_subdomain: options.addWithWwwSubdomain ?? false,
      };
      if (options.setupType !== undefined) body.setup_type = options.setupType;
      if (
        options.customSslKeyFile !== undefined &&
        options.customSslKeyFile !== ""
      ) {
        body.custom_ssl_key = await readTextFile(
          options.customSslKeyFile,
          "custom SSL key",
          io,
        );
      }
      if (
        options.customSslCertFile !== undefined &&
        options.customSslCertFile !== ""
      ) {
        body.custom_ssl_cert = await readTextFile(
          options.customSslCertFile,
          "custom SSL certificate",
          io,
        );
      }
      return body;
    },
    io,
  );
}

export interface DomainDeleteOptions extends FromJsonOptions {
  readonly domainId?: readonly string[];
}

/** `hosting domains delete`. */
export async function domainDeletePayload(
  options: DomainDeleteOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const ids = options.domainId ?? [];
      if (ids.length === 0) {
        throw new CliError(
          "usage_error",
          "At least one --domain-id is required.",
          { details: { flag: "--domain-id" } },
        );
      }
      return { domain_ids: stringList(ids) };
    },
    io,
  );
}

export interface DomainPrimaryOptions extends FromJsonOptions {
  readonly domainId?: string;
  readonly searchReplace?: boolean;
}

/** `hosting domains primary`. */
export async function domainPrimaryPayload(
  options: DomainPrimaryOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      domain_id: requireOption(options.domainId, "--domain-id"),
      run_search_and_replace: options.searchReplace ?? false,
    }),
    io,
  );
}

/* -------------------------------------------------------------------------- */
/* DNS                                                                        */
/* -------------------------------------------------------------------------- */

export interface DnsRecordCreateOptions extends FromJsonOptions {
  readonly recordType?: string;
  readonly name?: string;
  /** Absent when `--ttl` was not given; Go tracked this with `Changed("ttl")`. */
  readonly ttl?: number;
  readonly value?: readonly string[];
}

/** `hosting dns records create`. */
export async function dnsRecordCreatePayload(
  options: DnsRecordCreateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const values = options.value ?? [];
      if (values.length === 0) {
        throw new CliError("usage_error", "At least one --value is required.", {
          details: { flag: "--value" },
        });
      }
      const recordType = requireOption(options.recordType, "--record-type");
      const name = requireOption(options.name, "--name");
      const body: JsonBuilder = { type: recordType, name };
      if (options.ttl !== undefined) body.ttl = options.ttl;
      body.resource_records = dnsValues(values);
      return body;
    },
    io,
  );
}

export interface DnsRecordUpdateOptions extends FromJsonOptions {
  readonly recordType?: string;
  readonly name?: string;
  readonly ttl?: number;
  readonly addValue?: readonly string[];
  readonly removeValue?: readonly string[];
}

/** `hosting dns records update`. */
export async function dnsRecordUpdatePayload(
  options: DnsRecordUpdateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const body: JsonBuilder = {
        type: requireOption(options.recordType, "--record-type"),
        name: requireOption(options.name, "--name"),
      };
      if (options.ttl !== undefined) body.ttl = options.ttl;
      const added = options.addValue ?? [];
      const removed = options.removeValue ?? [];
      if (added.length > 0) body.new_resource_records = dnsValues(added);
      if (removed.length > 0)
        body.removed_resource_records = dnsValues(removed);
      return body;
    },
    io,
  );
}

export interface DnsRecordDeleteOptions extends FromJsonOptions {
  readonly recordType?: string;
  readonly name?: string;
}

/** `hosting dns records delete`. */
export async function dnsRecordDeletePayload(
  options: DnsRecordDeleteOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      type: requireOption(options.recordType, "--record-type"),
      name: requireOption(options.name, "--name"),
    }),
    io,
  );
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

export interface CacheClearOptions extends FromJsonOptions {
  readonly kind: CacheKind;
  readonly env?: string;
  readonly cdnCacheId?: string;
  readonly clearSubdirectories?: boolean;
  readonly url?: string;
}

/**
 * `hosting cache clear`. Go's `switch a.kind` had no default, so an unvalidated
 * kind quietly produced a site-cache body; here `kind` is already a `CacheKind`
 * and the switch is exhaustive with an `assertNever` default.
 */
export async function cacheClearPayload(
  options: CacheClearOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const body: JsonBuilder = {
        environment_id: requireOption(options.env, "--env"),
      };
      switch (options.kind) {
        case "site":
          break;
        case "edge":
          body.clear_subdirectories = options.clearSubdirectories ?? false;
          if (options.url !== undefined && options.url !== "")
            body.url = options.url;
          break;
        case "cdn":
          body.cdn_cache_id = requireOption(
            options.cdnCacheId,
            "--cdn-cache-id",
          );
          break;
        default:
          assertNever(options.kind);
      }
      return body;
    },
    io,
  );
}

/* -------------------------------------------------------------------------- */
/* WordPress plugins and themes                                               */
/* -------------------------------------------------------------------------- */

/** Which asset family a `wp` subcommand operates on. */
export type WpAssetKind = "plugins" | "themes";

export interface WpAssetUpdateOptions extends FromJsonOptions {
  readonly name?: string;
  /**
   * `--update-version`. Go spelled this `--version`; `--version` is a global in
   * the v1 contract and commander lets an ancestor's option win anywhere in
   * argv, so the leaf flag is renamed rather than silently shadowed.
   */
  readonly updateVersion?: string;
}

/** `hosting wp plugins update` / `hosting wp themes update`. */
export async function wpAssetUpdatePayload(
  options: WpAssetUpdateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      name: requireOption(options.name, "--name"),
      update_version: requireOption(options.updateVersion, "--update-version"),
    }),
    io,
  );
}

export interface WpAssetUpdateAllOptions extends FromJsonOptions {
  readonly name?: readonly string[];
}

/**
 * `hosting wp plugins update-all` / `hosting wp themes update-all`. Go took a
 * `plugins bool`; a two-member union reads correctly at the call site and
 * cannot be passed the wrong way round.
 */
export async function wpAssetUpdateAllPayload(
  options: WpAssetUpdateAllOptions,
  asset: WpAssetKind,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      [asset]: (options.name ?? []).map((name) => ({ name })),
    }),
    io,
  );
}

export interface WpPluginInstallOptions extends FromJsonOptions {
  readonly source?: string;
  /** `--plugin-version`; Go's `--version`, renamed away from the global. */
  readonly pluginVersion?: string;
  readonly force?: boolean;
  readonly activate?: boolean;
  readonly activateNetwork?: boolean;
  readonly ignoreRequirements?: boolean;
  /** InstaWP saved-command id. Go treated `0` as "unset"; so does this. */
  readonly commandId?: number;
}

/**
 * `hosting wp plugins install`. Either an InstaWP saved-command reference or a
 * `wp plugin install` command line built from the options.
 */
export async function wpPluginInstallPayload(
  options: WpPluginInstallOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      if (options.commandId !== undefined && options.commandId !== 0)
        return { command_id: options.commandId };
      const source = requireOption(options.source, "--source");
      return { wp_command: wpPluginInstallCommand(source, options) };
    },
    io,
  );
}

/** The `wp plugin install ...` command line, quoted for a provider WP-CLI API. */
export function wpPluginInstallCommand(
  source: string,
  options: WpPluginInstallOptions,
): string {
  const parts = ["wp", "plugin", "install", source];
  // The WP-CLI flag inside the generated command line keeps its own name; only
  // HQ's own option was renamed.
  if (options.pluginVersion !== undefined && options.pluginVersion !== "")
    parts.push(`--version=${options.pluginVersion}`);
  if (options.force === true) parts.push("--force");
  if (options.ignoreRequirements === true) parts.push("--ignore-requirements");
  if (options.activateNetwork === true) parts.push("--activate-network");
  else if (options.activate === true) parts.push("--activate");
  return shellJoin(parts);
}

/** The `wp plugin activate ...` command line used after a waited install. */
export function wpPluginActivateCommand(
  slug: string,
  network: boolean,
): string {
  const parts = ["wp", "plugin", "activate", slug];
  if (network) parts.push("--network");
  return shellJoin(parts);
}

/**
 * Quote one WP-CLI argument. This is intentionally far stricter than a real
 * shell quoter: the string is handed to a provider that runs it through a
 * shell HQ cannot see, so anything that could change the command's meaning is
 * refused rather than escaped.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (value.includes("'")) {
    throw new CliError(
      "usage_error",
      "WP-CLI arguments cannot contain single quotes.",
    );
  }
  let needsQuote = false;
  for (const character of value) {
    if (character === " ") {
      needsQuote = true;
      continue;
    }
    if (!/^[-_./:=@0-9A-Za-z]$/.test(character)) {
      throw new CliError(
        "usage_error",
        "WP-CLI arguments can contain only letters, numbers, spaces, and - _ . / : = @",
      );
    }
  }
  return needsQuote ? `'${value}'` : value;
}

/** Quote and join a WP-CLI command line. */
export function shellJoin(parts: readonly string[]): string {
  return parts.map(shellQuote).join(" ");
}

export interface WpCliRunOptions extends FromJsonOptions {
  readonly command?: string;
  readonly commandStdin?: boolean;
}

/** `hosting wp-cli run`. */
export async function wpCliPayload(
  options: WpCliRunOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => ({
      wp_command:
        options.commandStdin === true
          ? await readStdinTrimmed("The WP-CLI command", io)
          : requireOption(options.command, "--command"),
    }),
    io,
  );
}

/** The body of a bare `run-wp-cli` action, for helpers that build one. */
export function wpCliCommandPayload(command: string): JsonRecord {
  return { wp_command: command };
}

/* -------------------------------------------------------------------------- */
/* Backups, PHP, denied IPs, SSH and SFTP                                     */
/* -------------------------------------------------------------------------- */

export interface BackupCreateOptions extends FromJsonOptions {
  /** Present only when `--tag` was given, including as an empty string. */
  readonly tag?: string;
}

/** `hosting backups create`. Inline in Go's `hosting.go`. */
export async function backupCreatePayload(
  options: BackupCreateOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => (options.tag === undefined ? {} : { tag: options.tag }),
    io,
  );
}

export interface BackupRestoreOptions extends FromJsonOptions {
  readonly backupId?: number;
  readonly notifiedUserId?: string;
}

/** `hosting backups restore`. Inline in Go's `hosting.go`. */
export async function backupRestorePayload(
  options: BackupRestoreOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      backup_id: requireNumberOption(options.backupId, "--backup-id"),
      notified_user_id: requireOption(
        options.notifiedUserId,
        "--notified-user-id",
      ),
    }),
    io,
  );
}

export interface PhpSetVersionOptions extends FromJsonOptions {
  readonly env?: string;
  /** `--php-version`; Go's `--version`, renamed away from the global. */
  readonly phpVersion?: string;
  readonly optOutAutoUpdates?: boolean;
}

/** `hosting php set-version`. Inline in Go's `hosting.go`. */
export async function phpSetVersionPayload(
  options: PhpSetVersionOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => {
      const body: JsonBuilder = {
        environment_id: requireOption(options.env, "--env"),
        php_version: requireOption(options.phpVersion, "--php-version"),
      };
      if (options.optOutAutoUpdates === true)
        body.is_opt_out_from_automatic_php_update = true;
      return body;
    },
    io,
  );
}

export interface DeniedIpsSetOptions extends FromJsonOptions {
  readonly env?: string;
  readonly ip?: readonly string[];
}

/** `hosting denied-ips set`. Inline in Go's `hosting.go`. */
export async function deniedIpsSetPayload(
  options: DeniedIpsSetOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({
      environment_id: requireOption(options.env, "--env"),
      ip_list: stringList(options.ip),
    }),
    io,
  );
}

export interface SshAllowlistSetOptions extends FromJsonOptions {
  readonly ip?: readonly string[];
}

/** `hosting access ssh set-allowlist`. Inline in Go's `access.go`. */
export async function sshAllowlistPayload(
  options: SshAllowlistSetOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    () => ({ ip_allowlist: stringList(options.ip) }),
    io,
  );
}

export interface SftpAddOptions extends FromJsonOptions {
  readonly username?: string;
  readonly passwordEnv?: string;
  readonly passwordStdin?: boolean;
  readonly passwordFile?: string;
  readonly rootDirectory?: string;
  readonly permission?: string;
}

/** `hosting access sftp add`. */
export async function sftpAddPayload(
  options: SftpAddOptions,
  io: CommandIo,
): Promise<JsonValue> {
  return payloadOrObject(
    options.fromJson,
    async () => {
      const username = requireOption(options.username, "--username");
      const password = await readSecret(
        {
          ...(options.passwordEnv === undefined
            ? {}
            : { env: options.passwordEnv }),
          ...(options.passwordStdin === undefined
            ? {}
            : { stdin: options.passwordStdin }),
          ...(options.passwordFile === undefined
            ? {}
            : { file: options.passwordFile }),
        },
        SFTP_PASSWORD_SECRET,
        io,
      );
      return {
        username,
        password,
        root_directory: options.rootDirectory ?? DEFAULT_SFTP_ROOT_DIRECTORY,
        permission: options.permission ?? DEFAULT_SFTP_PERMISSION,
      };
    },
    io,
  );
}

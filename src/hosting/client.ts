// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provider-neutral `ProviderClient` interface and the typed read/action
 * request variants HQ dispatches to a concrete provider.
 *
 * Go models the request sets as sealed interfaces with an unexported marker
 * method (`isReadRequest()` / `isActionRequest()`) purely to emulate a sum type,
 * then dispatches with `switch req.(type)` and a `default` that returns
 * "unknown read request type %T" at run time. TypeScript has sum types natively,
 * so HQ uses discriminated unions on a kebab-case `kind` field: a provider that
 * forgets a variant fails to compile instead of failing in production, thanks to
 * `noFallthroughCasesInSwitch` plus an `assertNever` default (plan §5.3).
 *
 * Provider modules therefore have two distinct "not handled" paths:
 *
 * - `assertNever(request)` in the `default` branch — unreachable by
 *   construction; reaching it means the union grew and this provider was not
 *   updated, which is an `internal_error`.
 * - `unsupportedReadRequest(provider, request)` / `unsupportedActionRequest(...)`
 *   in an explicit `case` — the provider deliberately does not map this
 *   operation, which is a `provider_unsupported` usage-level failure.
 */

import { CliError } from "../errors.js";
import type { ProviderKind } from "../config/schema.js";
import {
  type ActionResult,
  type CacheKind,
  type EnvironmentCreateMode,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
  type Query,
  type SiteCreateMode,
  providerLabel,
} from "./types.js";

/**
 * Exhaustiveness guard for a discriminated-union `switch`. The parameter type
 * makes TypeScript reject the call when a variant is left unhandled, so the
 * throw is only ever reached if a value crossed a runtime boundary untyped.
 */
export function assertNever(value: never, message?: string): never {
  throw new CliError(
    "internal_error",
    message ?? `Unhandled variant: ${describeUnknownVariant(value)}`,
  );
}

function describeUnknownVariant(value: unknown): string {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const { kind }: { kind: unknown } = value;
    if (typeof kind === "string") return JSON.stringify(kind);
  }
  return typeof value;
}

/**
 * The request body of a mutating action, built by the CLI or the dashboard and
 * marshaled into the HTTP request (Go's `Body any`). `undefined` means "send no
 * request body", matching Go's `nil`.
 */
export type ActionBody = unknown;

/* -------------------------------------------------------------------------- */
/* Read requests                                                              */
/* -------------------------------------------------------------------------- */

export interface ReadCapabilitiesRequest {
  readonly kind: "capabilities";
}

export interface ReadRegionsRequest {
  readonly kind: "regions";
  readonly companyId?: string;
}

export interface ReadActivityRequest {
  readonly kind: "activity";
  readonly companyId?: string;
  readonly query?: Query;
}

export interface ReadSiteDomainsRequest {
  readonly kind: "site-domains";
  readonly envId: string;
}

export interface ReadSiteDomainVerificationRequest {
  readonly kind: "site-domain-verification";
  readonly siteDomainId: string;
}

export interface ReadDnsDomainsRequest {
  readonly kind: "dns-domains";
  readonly companyId?: string;
}

export interface ReadDnsRecordsRequest {
  readonly kind: "dns-records";
  readonly domainId: string;
}

export interface ReadBackupsRequest {
  readonly kind: "backups";
  readonly envId: string;
}

export interface ReadDownloadableBackupsRequest {
  readonly kind: "downloadable-backups";
  readonly envId: string;
}

export interface ReadLogsRequest {
  readonly kind: "logs";
  readonly envId: string;
  readonly fileName: string;
  /** Go models this as `uint32`; must be a non-negative safe integer. */
  readonly lines: number;
}

export interface ReadRedirectsRequest {
  readonly kind: "redirects";
  readonly envId: string;
  readonly query?: Query;
}

export interface ReadDeniedIpsRequest {
  readonly kind: "denied-ips";
  readonly envId: string;
}

export interface ReadPluginsRequest {
  readonly kind: "plugins";
  readonly envId: string;
}

export interface ReadThemesRequest {
  readonly kind: "themes";
  readonly envId: string;
}

export interface ReadCompanyPluginsRequest {
  readonly kind: "company-plugins";
  readonly companyId?: string;
}

export interface ReadCompanyThemesRequest {
  readonly kind: "company-themes";
  readonly companyId?: string;
}

export interface ReadAnalyticsUsageRequest {
  readonly kind: "analytics-usage";
  readonly siteId: string;
  readonly metric: string;
}

export interface ReadAnalyticsEnvRequest {
  readonly kind: "analytics-env";
  readonly envId: string;
  readonly metric: string;
  readonly query?: Query;
}

export interface ReadFileListRequest {
  readonly kind: "file-list";
  readonly envId: string;
}

/** Every read-only provider request exposed by HQ. */
export type ReadRequest =
  | ReadCapabilitiesRequest
  | ReadRegionsRequest
  | ReadActivityRequest
  | ReadSiteDomainsRequest
  | ReadSiteDomainVerificationRequest
  | ReadDnsDomainsRequest
  | ReadDnsRecordsRequest
  | ReadBackupsRequest
  | ReadDownloadableBackupsRequest
  | ReadLogsRequest
  | ReadRedirectsRequest
  | ReadDeniedIpsRequest
  | ReadPluginsRequest
  | ReadThemesRequest
  | ReadCompanyPluginsRequest
  | ReadCompanyThemesRequest
  | ReadAnalyticsUsageRequest
  | ReadAnalyticsEnvRequest
  | ReadFileListRequest;

export const READ_REQUEST_KINDS = [
  "capabilities",
  "regions",
  "activity",
  "site-domains",
  "site-domain-verification",
  "dns-domains",
  "dns-records",
  "backups",
  "downloadable-backups",
  "logs",
  "redirects",
  "denied-ips",
  "plugins",
  "themes",
  "company-plugins",
  "company-themes",
  "analytics-usage",
  "analytics-env",
  "file-list",
] as const;

export type ReadRequestKind = (typeof READ_REQUEST_KINDS)[number];

export function isReadRequestKind(value: unknown): value is ReadRequestKind {
  return (
    typeof value === "string" &&
    (READ_REQUEST_KINDS as readonly string[]).includes(value)
  );
}

/* -------------------------------------------------------------------------- */
/* Action requests                                                            */
/* -------------------------------------------------------------------------- */

export interface ActionCreateSiteRequest {
  readonly kind: "create-site";
  readonly mode: SiteCreateMode;
  readonly body?: ActionBody;
}

export interface ActionCreateEnvironmentRequest {
  readonly kind: "create-environment";
  readonly siteId: string;
  readonly mode: EnvironmentCreateMode;
  readonly body?: ActionBody;
}

export interface ActionPushEnvironmentRequest {
  readonly kind: "push-environment";
  readonly siteId: string;
  readonly body?: ActionBody;
}

export interface ActionClearCacheRequest {
  readonly kind: "clear-cache";
  readonly cache: CacheKind;
  readonly body?: ActionBody;
}

export interface ActionRestartPhpRequest {
  readonly kind: "restart-php";
  readonly envId: string;
}

export interface ActionSetPhpVersionRequest {
  readonly kind: "set-php-version";
  readonly body?: ActionBody;
}

export interface ActionAddDomainRequest {
  readonly kind: "add-domain";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionChangePrimaryDomainRequest {
  readonly kind: "change-primary-domain";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionCreateBackupRequest {
  readonly kind: "create-backup";
  readonly envId: string;
  readonly body?: ActionBody;
}

/**
 * The low-level provider request used only by the guarded backup-restore
 * workflow. Callers must go through `prepareBackupRestore` and
 * `executeBackupRestore`; CLI and MCP never dispatch this variant directly.
 */
export interface ActionRestoreBackupRequest {
  readonly kind: "restore-backup";
  readonly targetEnvId: string;
  readonly body?: ActionBody;
}

export interface ActionUpdatePluginRequest {
  readonly kind: "update-plugin";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionBulkUpdatePluginsRequest {
  readonly kind: "bulk-update-plugins";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionUpdateThemeRequest {
  readonly kind: "update-theme";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionBulkUpdateThemesRequest {
  readonly kind: "bulk-update-themes";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionRunWpCliRequest {
  readonly kind: "run-wp-cli";
  readonly envId: string;
  readonly body?: ActionBody;
}

export interface ActionSetDeniedIpsRequest {
  readonly kind: "set-denied-ips";
  readonly body?: ActionBody;
}

export interface ActionApplyRedirectsRequest {
  readonly kind: "apply-redirects";
  readonly envId: string;
  readonly body?: ActionBody;
}

/** Every mutating provider request exposed by HQ. */
export type ActionRequest =
  | {
      readonly kind: "setup-novamira";
      readonly envId: string;
      readonly enableAiAbilities?: boolean;
      readonly signal?: AbortSignal;
    }
  | ActionCreateSiteRequest
  | ActionCreateEnvironmentRequest
  | ActionPushEnvironmentRequest
  | ActionClearCacheRequest
  | ActionRestartPhpRequest
  | ActionSetPhpVersionRequest
  | ActionAddDomainRequest
  | ActionChangePrimaryDomainRequest
  | ActionCreateBackupRequest
  | ActionRestoreBackupRequest
  | ActionUpdatePluginRequest
  | ActionBulkUpdatePluginsRequest
  | ActionUpdateThemeRequest
  | ActionBulkUpdateThemesRequest
  | ActionRunWpCliRequest
  | ActionSetDeniedIpsRequest
  | ActionApplyRedirectsRequest;

export const ACTION_REQUEST_KINDS = [
  "setup-novamira",
  "create-site",
  "create-environment",
  "push-environment",
  "clear-cache",
  "restart-php",
  "set-php-version",
  "add-domain",
  "change-primary-domain",
  "create-backup",
  "restore-backup",
  "update-plugin",
  "bulk-update-plugins",
  "update-theme",
  "bulk-update-themes",
  "run-wp-cli",
  "set-denied-ips",
  "apply-redirects",
] as const;

export type ActionRequestKind = (typeof ACTION_REQUEST_KINDS)[number];

export function isActionRequestKind(
  value: unknown,
): value is ActionRequestKind {
  return (
    typeof value === "string" &&
    (ACTION_REQUEST_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Compile-time proof that the `*_REQUEST_KINDS` arrays and the union
 * discriminants describe exactly the same set. Adding a union member without
 * adding its kind (or the reverse) makes `false` unassignable to `true` and
 * fails the build.
 */
type SameStringUnion<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

export const READ_REQUEST_KINDS_ARE_EXHAUSTIVE: SameStringUnion<
  ReadRequest["kind"],
  ReadRequestKind
> = true;

export const ACTION_REQUEST_KINDS_ARE_EXHAUSTIVE: SameStringUnion<
  ActionRequest["kind"],
  ActionRequestKind
> = true;

/* -------------------------------------------------------------------------- */
/* Provider client                                                            */
/* -------------------------------------------------------------------------- */

export interface ListSitesOptions {
  /** Provider account scope; defaults to the profile's configured company. */
  readonly companyId?: string;
  /** Ask the provider to embed environments in each site. Defaults to false. */
  readonly includeEnvironments?: boolean;
}

/**
 * The provider-neutral interface implemented by each backend. Every method is
 * asynchronous and rejects with a `CliError` from the shared taxonomy; the
 * shared `HttpClient` already maps provider HTTP failures onto it.
 */
export interface ProviderClient {
  /** The provider this client speaks to. */
  readonly provider: ProviderKind;

  validate(): Promise<ProviderValidation>;

  listSites(options?: ListSitesOptions): Promise<HostingSite[]>;

  getSite(siteId: string): Promise<HostingSite>;

  listEnvironments(siteId: string): Promise<HostingEnvironment[]>;

  /** Optional native push targets outside the source site's environments. */
  listPushTargets?(sourceSiteId: string): Promise<HostingEnvironment[]>;

  /**
   * Run a read-only request. The resolved value is the parsed provider
   * response, passed through unvalidated (Go returns `json.RawMessage`).
   */
  read(request: ReadRequest): Promise<unknown>;

  action(request: ActionRequest): Promise<ActionResult>;

  operationStatus(operationId: string): Promise<OperationStatus>;

  /**
   * Optional: whether this provider's WP-CLI endpoint reports command success
   * and output. Ported from Go's separate `WPCLIResultObserver` interface;
   * omitting the method means "observable", the Go default.
   */
  wpCliResultsObservable?(): boolean;
}

/**
 * Whether WP-CLI results can be observed for this client, defaulting to `true`
 * when the client does not implement the optional method (mirrors
 * `TestWPCLIResultsObservableDefaultsToTrue`).
 */
export function wpCliResultsObservable(client: ProviderClient): boolean {
  return client.wpCliResultsObservable?.() ?? true;
}

/**
 * Strip a leading `wp` binary token from a WP-CLI command, for providers whose
 * API takes the arguments only. Ported from Go's `wpCliWithoutBinary`.
 */
export function wpCliWithoutBinary(command: string): string {
  const trimmed = command.trim();
  if (trimmed.toLowerCase() === "wp") return "";
  if (trimmed.length > 3 && trimmed.slice(0, 3).toLowerCase() === "wp ")
    return trimmed.slice(3).trim();
  return trimmed;
}

/**
 * The error a provider raises for a request it deliberately does not map.
 * Mirrors Go's `provider <name> does not support read request %T`.
 */
export function unsupportedReadRequest(
  provider: ProviderKind,
  request: ReadRequest,
): CliError {
  return new CliError(
    "provider_unsupported",
    `${providerLabel(provider)} does not support the "${request.kind}" read request.`,
    { details: { provider, request: request.kind } },
  );
}

export function unsupportedActionRequest(
  provider: ProviderKind,
  request: ActionRequest,
): CliError {
  return new CliError(
    "provider_unsupported",
    `${providerLabel(provider)} does not support the "${request.kind}" action.`,
    { details: { provider, action: request.kind } },
  );
}

/**
 * The error a provider raises for an operation outside the request unions, e.g.
 * Hostinger's missing operation-status endpoint or a create mode it cannot map.
 */
export function unsupportedOperation(
  provider: ProviderKind,
  operation: string,
): CliError {
  return new CliError(
    "provider_unsupported",
    `${providerLabel(provider)} does not support ${operation}.`,
    { details: { provider, operation } },
  );
}

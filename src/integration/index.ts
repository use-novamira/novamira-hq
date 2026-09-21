// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The site CLI integration's public surface.
 *
 * The pinned site CLI is a packaged dependency, loaded only by its child entry.
 * Hosting operations remain usable if the bundled CLI is damaged. Connection
 * detection reports `unavailable` with repair guidance in that case.
 *
 * `src/integration/` is a peer of `src/web/` and of `src/cli/`: it imports
 * neither, and both may call it. Its only inputs are the stdout of two child
 * processes it spawns itself, always with an argv array and never through a
 * shell. HQ never reads the site CLI's configuration, profile store,
 * credential store or keychain records, and never reads or interprets
 * `NOVAMIRA_HOME`.
 */

export {
  createSiteCliIntegration,
  integrationUnavailableError,
  unavailableHint,
  DEFAULT_CONCURRENCY,
  DEFAULT_OVERALL_DEADLINE_MS,
  DEFAULT_PER_CHILD_TIMEOUT_MS,
  type ConnectionQuery,
  type ConnectionResult,
  type ConnectionSnapshot,
  type ConnectionState,
  type ConnectOutcome,
  type SiteCliIntegration,
  type SiteCliIntegrationOptions,
  type UnavailableReason,
} from "./connection.js";

export {
  authLoginArgs,
  createConnectAction,
  AUTH_LOGIN_TIMEOUT_MS,
  type ConnectActionOptions,
} from "./connect.js";

export {
  createSiteProfileService,
  PROFILE_ACTION_TIMEOUT_MS,
  type SiteProfileListing,
  type SiteProfileOutcome,
  type SiteProfileService,
  type SiteProfileServiceOptions,
  type SiteProfileState,
  type SiteProfileSummary,
} from "./profiles.js";

export { runPool } from "./pool.js";

export {
  verdictFor,
  verdictForStatus,
  type ProfileVerdict,
} from "./verdict.js";

export {
  envelopeReason,
  interpretChildOutcome,
  OUTCOME_REASONS,
  PROFILE_GONE_CODE,
  type ChildResult,
} from "./classify.js";

export {
  createSiteCliProbe,
  versionArgs,
  DEFAULT_PROBE_TIMEOUT_MS,
  MINIMUM_SITE_CLI_VERSION,
  type ProbeSiteCli,
  type SiteCliProbe,
  type SiteCliProbeOptions,
  type SiteCliProbeStatus,
} from "./probe.js";

export { normalizeOrigins, originOf, originsMatch } from "./origin.js";

export {
  createSiteCliResolver,
  nodeIsFile,
  SITE_CLI_COMMAND,
  SITE_CLI_INSTALL_HINT,
  SITE_CLI_OVERRIDE_ENV,
  type ResolveSiteCli,
  type SiteCliResolution,
  type SiteCliResolverOptions,
} from "./resolve.js";

export {
  authLogoutArgs,
  authStatusArgs,
  parseAuthStatus,
  parseEnvelope,
  parseSitesList,
  siteCliChildEnv,
  sitesListArgs,
  sitesRenameArgs,
  sitesRemoveArgs,
  CREDENTIAL_STATES,
  type CredentialState,
  type ParsedEnvelope,
  type SiteCliAuthStatus,
  type SiteCliProfile,
} from "./site-cli.js";

export {
  nodeSpawnChild,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type ChildInvocation,
  type ChildOutcome,
  type ChildOutcomeKind,
  type SpawnChild,
} from "./spawn.js";

export {
  createSiteOperations,
  type SiteOperation,
  type SiteOperations,
} from "./operations.js";

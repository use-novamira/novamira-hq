// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The provisioning service's public surface.
 *
 * `src/cli/hosting/novamira.ts` and Phase 6's dashboard import from here and
 * from nowhere else inside `src/provisioning/`. The direction is one-way:
 * `src/cli/` and `src/web/` import from provisioning, and provisioning imports
 * from `src/errors.ts`, `src/json.ts`, `src/version.ts` and `src/hosting/*` —
 * never the reverse. That is what lets the dashboard run the whole setup
 * sequence with no commander, no `Renderer` and no `CommandIo` in the graph.
 */

export {
  checkSiteCompatibility,
  metadataUrl,
  MINIMUM_NOVAMIRA_VERSION,
  MINIMUM_WORDPRESS_VERSION,
  REQUIRED_FEATURES,
  REQUIRED_REST_API_VERSION,
  COMPATIBILITY_CHECKS,
  PROTECTED_RESOURCE_PATH,
  type CompatibilityCheck,
  type CompatibilityOptions,
  type ServerCompatibility,
} from "./compatibility.js";

export {
  connectHandoff,
  handoffData,
  handoffHuman,
  SITE_CLI_EXECUTABLE,
  type Handoff,
} from "./handoff.js";

export {
  globalHttpFetch,
  type HttpFetch,
  type HttpRequestInit,
  type HttpResponse,
} from "./http.js";

export {
  NOVAMIRA_LATEST_RELEASE_API,
  NOVAMIRA_LATEST_SOURCE_ALIAS,
  NOVAMIRA_LEGACY_ZIP_URL,
  NOVAMIRA_PLUGIN_SLUG,
  NOVAMIRA_ZIP_ASSET,
  inferPluginSlug,
  type ActivationPlan,
} from "./plugin.js";

export {
  NOVAMIRA_SETUP_MINIMUM_PHP,
  NOVAMIRA_SETUP_MINIMUM_PHP_MAJOR,
  PHP_VERSION_COMMAND,
} from "./phpcompat.js";

export {
  normalizeSiteUrl,
  type InsecureHttpEnvironment,
  type NormalizedSite,
  type SiteUrlSource,
} from "./site-url.js";

export {
  provisionNovamira,
  type CompatibilityReport,
  type CompatibilityStatus,
  type NovamiraSetupDependencies,
  type NovamiraSetupRequest,
  type NovamiraSetupResult,
  type ProgressLevel,
  type ProgressReporter,
} from "./setup.js";

export { type PollBudget } from "./wp-cli.js";

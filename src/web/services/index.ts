// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The barrel `src/web/server.ts` builds its dependency record from.
 *
 * **What a service is here.** The dashboard's own mutable state, plus the read
 * and write paths its handlers need, with no markup and no HTTP in sight. In Go
 * all of this hung off `*Server` — the config mutex, the sites cache, the
 * `lastChecked` map, the job registry — beside the `http.Handler` and the
 * renderers, so nothing could be exercised without a server and every field was
 * in scope of every handler.
 *
 * **The layering rule.** A service may import `src/config/`,
 * `src/credentials/`, `src/hosting/`, `src/provisioning/`,
 * `src/connection-state.ts`, and `src/integration/`'s public surface. It may
 * **not** import `src/cli/` (nothing under `src/web/` may), nor anything under
 * `src/web/views/` or `src/web/handlers/` — the dependency runs handlers →
 * services → domain, and a service reaching back up into a renderer is what
 * makes a page impossible to test.
 *
 * **This file was appended to by each 6b batch**, one block per service: 6b-1
 * `providers.ts`, 6b-2 `sites.ts` and `deploy-paths.ts`, 6b-3 `setup-jobs.ts`.
 * Keep it a flat list of re-exports so a future batch's diff does not collide.
 */

export {
  createProviderService,
  type ProviderMutation,
  type ProviderService,
  type ProviderServiceOptions,
} from "./providers.js";

export {
  createSitesService,
  connectionFor,
  connectionKey,
  displayLabel,
  SITES_CACHE_TTL_MS,
  type ConnectedStateSource,
  type EnvDisplay,
  type EnvResolver,
  type ResolvedSite,
  type SiteGroup,
  type SitesListOptions,
  type SitesResult,
  type SitesService,
  type SitesServiceOptions,
} from "./sites.js";

export {
  createDeployPathService,
  type DeployPathService,
  type DeployPathServiceOptions,
} from "./deploy-paths.js";

export {
  createSetupJobService,
  MAX_EVENTS,
  MAX_JOBS,
  type SetupJobEvent,
  type SetupJobEventLevel,
  type SetupJobFailure,
  type SetupJobService,
  type SetupJobServiceOptions,
  type SetupJobSnapshot,
  type SetupJobStartInput,
  type SetupJobStatus,
} from "./setup-jobs.js";

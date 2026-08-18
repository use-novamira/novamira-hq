// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The update package's public surface.
 *
 * **Layer rules this package obeys.** `src/update/` may import `src/config/`
 * (the lock manager, atomic writes and owner-only file security), `src/semver.ts`
 * and `src/errors.js`, and nothing else. It must **not** import `src/cli/`,
 * `src/web/` or `src/doctor/`. `src/doctor/` imports *this* package — check 9,
 * `update.available`, is built on {@link UpdateChecker} — and never the reverse,
 * which is the whole reason the dependency points this way.
 *
 * **Three consumers, one checker.** `src/cli/update.ts` runs the explicit
 * command; `src/main.ts` runs the 24-hour background notice; `src/cli/dashboard.ts`
 * adapts the same object into the structurally-typed `DashboardUpdates` the
 * dashboard's update card calls. All three are given the *same*
 * {@link UpdateChecker} factory from the composition root, so there is one
 * cached record, one lock key and one registry per process.
 *
 * **Everything network-facing is injectable.** {@link RegistryOptions.fetch} and
 * {@link InstallRunner} are the two seams; every contract test supplies both, so
 * no test in this repository reaches the npm registry or spawns a package
 * manager.
 */

export {
  distTagsUrl,
  fetchLatestVersion,
  DEFAULT_REGISTRY,
  PACKAGE_NAME,
  type RegistryOptions,
} from "./registry.js";

export {
  installCommandFor,
  installVersion,
  printableCommand,
  SpawnInstallRunner,
  createSpawnResolver,
  nodeIsFile,
  DEFAULT_INSTALL_TIMEOUT_MS,
  type InstallCommand,
  type InstallRunner,
  type SelfUpdateResult,
  type SpawnSpec,
  type ResolveSpawnSpec,
  type SpawnResolverOptions,
} from "./install.js";

export {
  isNewer,
  normalizeRegistry,
  updateCheckEnabled,
  updateNotice,
  UpdateChecker,
  UPDATE_CHECK_FILE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_LOCK,
  UPDATE_CHECK_TIMEOUT_MS,
  type UpdateCheckEnvironment,
  type UpdateCheckerOptions,
  type UpdateRecord,
  type UpdateStatus,
} from "./notifier.js";

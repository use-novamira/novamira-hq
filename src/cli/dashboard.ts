// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `novamira-hq dashboard`, ported from `newDashboardCommand`
 * (`internal/cli/dashboard.go`).
 *
 * **A top-level command, not a hosting one.** Go registered it on the root, and
 * so does HQ: the dashboard is a peer surface of the whole CLI, not an operation
 * on a hosting profile. `src/web/` is likewise a peer of `src/cli/` — this file
 * imports the web layer, and nothing under `src/web/` may import `src/cli/`.
 *
 * **Two flags, and deliberately no third.** `--listen` and `--open` are free
 * against the reserved globals (`--profile --json --timeout --yes --no-color
 * --quiet --verbose --version`). The command declares **no `--timeout`**: the
 * name is reserved tree-wide because commander lets an ancestor consume a
 * matching option anywhere in argv, and a `--timeout` on a process that is
 * supposed to run until the operator stops it would mean nothing anyway. The
 * global is inherited and ignored.
 *
 * **The one place HQ's output contract meets a long-running process.**
 * `Renderer.success` is documented "call at most once per invocation". The
 * server is bound *first*, so the printed URL carries the real port when
 * `--listen 127.0.0.1:0` was used; the envelope is emitted immediately after,
 * through the same `runLocalCommand` every other local command uses; and then
 * the handler blocks until the listener stops. Nothing writes to stdout for the
 * rest of the run — a failure after that point is a signal, not a second
 * envelope.
 *
 * **`--open` never fails the command.** Go's `dashboard.OpenBrowser` printed a
 * line and carried on; HQ raises `renderer.warn` and carries on. The opener is
 * spawned with an argv array and `shell: false`, like every other child HQ
 * starts: the URL is ours, but a shell that re-parses a command line is a
 * category of bug worth not having.
 */

import { openInBrowser } from "../browser.js";
import { createAppAcknowledgement } from "../config/app-acknowledgement.js";
import type { Command } from "commander";

import { runDoctor } from "../doctor/index.js";
import {
  createSiteCliIntegration,
  createSiteOperations,
  createSiteCliResolver,
  nodeIsFile,
  nodeSpawnChild,
  type ResolveSiteCli,
  type SpawnChild,
} from "../integration/index.js";
import { globalHttpFetch, type HttpFetch } from "../provisioning/http.js";
import { CliError } from "../errors.js";
import { createProService } from "../pro/service.js";
import { installVersion, type InstallRunner } from "../update/index.js";
import {
  createDashboardServer,
  parseListenAddress,
  requireLoopbackHost,
  type BoundAddress,
  type DashboardDoctor,
  type DashboardIntegration,
  type DashboardServer,
  type DashboardUpdates,
} from "../web/index.js";
import type { CommandDependencies } from "./commands.js";
import { runLocalCommand } from "./hosting-command.js";
import type { GlobalOptions } from "./program.js";

/** Go's default (`internal/cli/dashboard.go:44`), unchanged. */
export const DEFAULT_DASHBOARD_LISTEN = "127.0.0.1:8787";
const DASHBOARD_PORT_ATTEMPTS = 10;
const DASHBOARD_IDENTITY_HEADER = "x-novamira-hq-dashboard";
const DASHBOARD_PROBE_TIMEOUT_MS = 1_000;

export interface DashboardCommandOptions {
  /** `--listen <address>`: a loopback `host:port`, `:port` or `port`. */
  readonly listen?: string;
  /** `--open`: launch the platform browser once the listener is up. */
  readonly open?: boolean;
}

export interface DashboardHandlers {
  /** `dashboard`. Resolves when the listener stops. */
  dashboard(
    options: DashboardCommandOptions,
    globals: GlobalOptions,
  ): Promise<void>;
}

/**
 * Seams for {@link createDashboardHandlers}; production supplies none.
 *
 * `spawn` and `resolveSiteCli` are the two seams of the connected-state
 * detector. They exist so a test can drive the service without a real
 * `novamira` child and without touching a real `PATH`; production builds it
 * from {@link nodeSpawnChild} and {@link createSiteCliResolver}. `integration`
 * replaces the whole service, for a test that wants to script its answers.
 */
export interface DashboardCommandOverrides {
  /** Embedded dashboard lifecycle: the MCP owns and closes its own listener. */
  readonly signal?: AbortSignal;
  readonly onReady?: (bound: BoundAddress) => void;
  readonly fetch?: HttpFetch;
  readonly randomToken?: () => string;
  readonly now?: () => number;
  readonly spawn?: SpawnChild;
  readonly resolveSiteCli?: ResolveSiteCli;
  readonly integration?: DashboardIntegration;
  /** Replaces the doctor runner, for a test that wants to script the report. */
  readonly doctor?: DashboardDoctor;
  /** Replaces both update operations, for a test that scripts them. */
  readonly updates?: DashboardUpdates;
  /**
   * Replaces only the package-manager child, leaving the real registry read and
   * the real result shape in place. It is the narrower of the two seams: a test
   * that wants to prove the card renders the exact command that ran uses this,
   * not `updates`.
   */
  readonly installRunner?: InstallRunner;
  readonly openBrowser?: (target: string) => Promise<void>;
  readonly probeDashboard?: (target: string) => Promise<boolean>;
  readonly createServer?: typeof createDashboardServer;
}

/**
 * Build the connected-state service the dashboard runs with.
 *
 * This is the only place `@novamira/cli` is reached for, and it is reached for
 * as a child process. The bundled child entry imports it; HQ never reads its
 * configuration, profile store or credentials.
 * With `novamira` absent the service still answers — every environment reports
 * `unavailable` with a fixed install hint — which is why it is built
 * unconditionally rather than only when something is found. Absent is a state,
 * not a missing dependency.
 *
 * Exported so a contract test can assert the production wiring without binding a
 * port: the seams below are the real ones unless a test replaces them.
 */
export function createDashboardIntegration(
  environment: NodeJS.ProcessEnv,
  overrides: DashboardCommandOverrides = {},
): DashboardIntegration {
  if (overrides.integration !== undefined) {
    return overrides.integration;
  }
  return createSiteCliIntegration({
    spawn: overrides.spawn ?? nodeSpawnChild,
    resolve:
      overrides.resolveSiteCli ??
      createSiteCliResolver({
        environment,
        platform: process.platform,
        isFile: nodeIsFile,
      }),
    environment,
    now: overrides.now ?? (() => Date.now()),
  });
}

/**
 * Build the report runner the Diagnostics page's Health check button calls.
 *
 * **Bound to `{ offline: true, fix: false }`, and that is not a default.** The
 * dashboard is a view: a `GET` that patches a panel must not repair the
 * operator's filesystem permissions, and it must not make a network request on
 * a button press. `novamira-hq doctor --fix` is where repair lives, and
 * {@link createDashboardUpdates} below is the one thing on this dashboard that
 * may reach a registry.
 *
 * This is also the seam that keeps `src/web/` from importing `src/doctor/`:
 * `DashboardDoctor` is declared structurally in `src/web/server.ts` and the real
 * implementation is assembled here, in the composition layer, exactly as
 * `createDashboardIntegration` assembles the site-CLI service.
 */
export function createDashboardDoctor(
  dependencies: CommandDependencies,
  environment: NodeJS.ProcessEnv,
  overrides: DashboardCommandOverrides = {},
): DashboardDoctor {
  if (overrides.doctor !== undefined) return overrides.doctor;
  return () =>
    runDoctor(
      {
        paths: dependencies.paths,
        security: dependencies.security,
        store: dependencies.store,
        credentials: dependencies.credentials,
        skills: dependencies.skills,
        probeSiteCli: dependencies.probeSiteCli,
        environment,
      },
      { offline: true, fix: false },
    );
}

/** The dashboard's registry deadline (Go: 20 s) and installer deadline (3 min). */
const DASHBOARD_UPDATE_CHECK_TIMEOUT_MS = 20_000;
const DASHBOARD_UPDATE_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Build the update card's two operations.
 *
 * **One checker, shared with the CLI.** `createUpdateChecker` closes over the
 * same `paths.stateDir`, the same `ProfileLockManager` and the same registry the
 * `update` command uses, so a check made from the browser is a check the next
 * `novamira-hq update` does not have to repeat, and two of them running at once
 * make one request rather than two.
 *
 * **The installer's output is consumed and dropped.** It is bounded by the sink
 * below and never rendered: `npm` writes progress bars, deprecation notices and
 * whatever a package's own output happens to be, none of which is a machine
 * envelope and none of which belongs in an HTML patch. What the card renders
 * instead is `command` — the exact command line that ran — which is the useful
 * half and is ours.
 *
 * **`install` re-checks before it installs**, so a card left open overnight
 * cannot install a version the registry no longer advertises; when the check
 * finds nothing newer it returns `updated: false` rather than throwing, because
 * "already up to date" is an outcome.
 */
export function createDashboardUpdates(
  dependencies: CommandDependencies,
  overrides: DashboardCommandOverrides = {},
): DashboardUpdates {
  if (dependencies.distribution === "desktop") {
    const unavailable = (): Promise<never> => {
      return Promise.reject(
        new CliError(
          "provider_unsupported",
          "This is the standalone desktop application. Install a newer desktop release to update it; npm update only changes the separately installed CLI.",
        ),
      );
    };
    return { available: false, check: unavailable, install: unavailable };
  }
  if (overrides.updates !== undefined) return overrides.updates;
  return {
    check: async () => {
      const checker = dependencies.createUpdateChecker(
        DASHBOARD_UPDATE_CHECK_TIMEOUT_MS,
      );
      const status = await checker.check();
      return { ...status, registry: checker.registryIdentity };
    },
    install: async () => {
      const checker = dependencies.createUpdateChecker(
        DASHBOARD_UPDATE_CHECK_TIMEOUT_MS,
      );
      const status = await checker.check();
      if (!status.updateAvailable) {
        return {
          updated: false,
          from: status.current,
          to: status.latest,
          command: "",
        };
      }
      const runner =
        overrides.installRunner ??
        dependencies.createInstallRunner(DASHBOARD_UPDATE_INSTALL_TIMEOUT_MS);
      return installVersion(
        status.current,
        status.latest,
        runner,
        // The bounded sink: read so the child's pipes never fill and block it,
        // and then discarded.
        () => undefined,
        undefined,
        checker.registryIdentity,
      );
    },
  };
}

/** Identify an existing dashboard before reusing its loopback port. */
async function probeDashboard(target: string): Promise<boolean> {
  try {
    const response = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(DASHBOARD_PROBE_TIMEOUT_MS),
    });
    return response.headers.get(DASHBOARD_IDENTITY_HEADER) === "1";
  } catch {
    return false;
  }
}

function humanSummary(bound: BoundAddress, configFile: string): string {
  return [`Novamira HQ dashboard: ${bound.url}`, `Config: ${configFile}`].join(
    "\n",
  );
}

function addressUrl(address: {
  readonly hostname: string;
  readonly port: number;
}): string {
  const host = address.hostname.includes(":")
    ? `[${address.hostname}]`
    : address.hostname;
  return `http://${host}:${String(address.port)}`;
}

function implicitDashboardAddresses(): readonly BoundAddress[] {
  const preferred = parseListenAddress(DEFAULT_DASHBOARD_LISTEN);
  return Array.from({ length: DASHBOARD_PORT_ATTEMPTS }, (_, offset) => {
    const address = { ...preferred, port: preferred.port + offset };
    return { ...address, url: addressUrl(address) };
  });
}

export function createDashboardHandlers(
  dependencies: CommandDependencies,
  overrides: DashboardCommandOverrides = {},
): DashboardHandlers {
  const http: HttpFetch = overrides.fetch ?? globalHttpFetch;
  const openBrowser = overrides.openBrowser ?? openInBrowser;
  const isDashboardRunning = overrides.probeDashboard ?? probeDashboard;
  const createServer = overrides.createServer ?? createDashboardServer;

  return {
    dashboard: async (options, globals) => {
      // Parsed and guarded before anything is constructed, so a bad `--listen`
      // fails with `usage_error` and never opens a socket.
      const explicitAddress =
        options.listen === undefined
          ? undefined
          : parseListenAddress(options.listen);
      const candidates =
        explicitAddress === undefined
          ? implicitDashboardAddresses()
          : [
              {
                ...explicitAddress,
                url: addressUrl(explicitAddress),
              },
            ];
      for (const candidate of candidates) {
        requireLoopbackHost(candidate.hostname);
      }

      const runningDashboard =
        options.open === true
          ? candidates[
              (
                await Promise.all(
                  candidates.map((candidate) =>
                    isDashboardRunning(candidate.url),
                  ),
                )
              ).findIndex(Boolean)
            ]
          : undefined;
      if (runningDashboard !== undefined) {
        const renderer = dependencies.rendererFor(globals);
        renderer.success(
          {
            url: runningDashboard.url,
            host: runningDashboard.hostname,
            port: runningDashboard.port,
            configFile: dependencies.store.configFile,
          },
          {
            human: humanSummary(
              runningDashboard,
              dependencies.store.configFile,
            ),
          },
        );
        try {
          await openBrowser(runningDashboard.url);
        } catch {
          renderer.warn(
            "The dashboard could not be opened in a browser; open the printed URL manually.",
          );
        }
        return;
      }

      let server: DashboardServer | undefined;
      let bound: BoundAddress | undefined;

      try {
        await runLocalCommand(
          dependencies,
          globals,
          async ({ renderer, io }) => {
            let lastConflict: CliError | undefined;
            for (const candidate of candidates) {
              const started = createServer({
                pro: createProService({
                  paths: dependencies.paths,
                  security: dependencies.security,
                  credentials: dependencies.credentials,
                  profiles: () =>
                    createDashboardIntegration(
                      io.env,
                      overrides,
                    ).listProfiles(),
                  operations: createSiteOperations({
                    spawn: overrides.spawn ?? nodeSpawnChild,
                    resolve:
                      overrides.resolveSiteCli ??
                      createSiteCliResolver({
                        environment: io.env,
                        platform: process.platform,
                        isFile: nodeIsFile,
                      }),
                    environment: io.env,
                  }),
                  fetch,
                }),
                version: dependencies.version,
                paths: dependencies.paths,
                store: dependencies.store,
                hosting: dependencies.hosting,
                history: dependencies.history,
                appAcknowledgement: createAppAcknowledgement(
                  dependencies.paths,
                  dependencies.security,
                ),
                ...(dependencies.mcpConnection
                  ? { mcpConnection: dependencies.mcpConnection }
                  : {}),
                credentials: dependencies.credentials,
                environment: io.env,
                fetch: http,
                now: overrides.now ?? (() => Date.now()),
                // Built here, where the injected environment record exists, so
                // `NOVAMIRA_HQ_SITE_CLI` and `PATH` come from the same place every
                // other command reads them from.
                integration: createDashboardIntegration(io.env, overrides),
                doctor: createDashboardDoctor(dependencies, io.env, overrides),
                updates: createDashboardUpdates(dependencies, overrides),
                ...(overrides.randomToken === undefined
                  ? {}
                  : { randomToken: overrides.randomToken }),
                onDiagnostic: (label, payload) => {
                  renderer.diagnostic(label, payload);
                },
              });
              try {
                bound = await started.listen(candidate);
                server = started;
                break;
              } catch (error) {
                if (
                  explicitAddress !== undefined ||
                  !(error instanceof CliError) ||
                  error.code !== "conflict"
                ) {
                  throw error;
                }
                lastConflict = error;
              }
            }
            if (bound === undefined) {
              throw (
                lastConflict ??
                new CliError(
                  "conflict",
                  "No dashboard listen address is available.",
                )
              );
            }
            return {
              data: {
                url: bound.url,
                host: bound.hostname,
                port: bound.port,
                configFile: dependencies.store.configFile,
              },
              human: humanSummary(bound, dependencies.store.configFile),
            };
          },
        );
      } catch (error) {
        // Close the race between the preflight probe and binding the listener.
        const exactCandidate = candidates[0];
        if (
          options.open !== true ||
          !(error instanceof CliError) ||
          error.code !== "conflict" ||
          explicitAddress === undefined ||
          exactCandidate === undefined ||
          !(await isDashboardRunning(exactCandidate.url))
        ) {
          throw error;
        }
        const renderer = dependencies.rendererFor(globals);
        renderer.success(
          {
            url: exactCandidate.url,
            host: exactCandidate.hostname,
            port: exactCandidate.port,
            configFile: dependencies.store.configFile,
          },
          {
            human: humanSummary(exactCandidate, dependencies.store.configFile),
          },
        );
        try {
          await openBrowser(exactCandidate.url);
        } catch {
          renderer.warn(
            "The dashboard could not be opened in a browser; open the printed URL manually.",
          );
        }
        return;
      }

      if (server === undefined || bound === undefined) {
        return;
      }
      const running = server;
      const renderer = dependencies.rendererFor(globals);

      if (options.open === true) {
        try {
          await openBrowser(bound.url);
        } catch {
          renderer.warn(
            "The dashboard could not be opened in a browser; open the printed URL manually.",
          );
        }
      }

      // Stop on the two signals a foreground server is stopped with, and take
      // the listeners off again in `finally` so a caller that runs `main` twice
      // in one process (the contract tests do) does not accumulate them.
      const stop = (): void => {
        void running.close();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      overrides.signal?.addEventListener("abort", stop, { once: true });
      try {
        if (overrides.signal?.aborted) stop();
        else overrides.onReady?.(bound);
        await running.closed();
      } finally {
        overrides.signal?.removeEventListener("abort", stop);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    },
  };
}

/**
 * Attach `dashboard` to the root program.
 *
 * The registration order below is the shipped flag order and is compared
 * exactly by `test/cli-program-phase4-contract.test.mjs`'s command-surface
 * assertion.
 */
export function registerDashboardCommands(
  parent: Command,
  handlers: DashboardHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  parent
    .command("dashboard")
    .description("serve the local web dashboard")
    .option("--listen <address>", "loopback listen address (host:port)")
    .option("--open", "open the dashboard in the default browser", false)
    .action(async (options: DashboardCommandOptions, command: Command) =>
      handlers.dashboard(options, optionsFor([command])),
    );
}

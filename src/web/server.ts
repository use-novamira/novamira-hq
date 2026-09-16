// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dashboard server: construction, the loopback bind guard, the per-process
 * mutation token, the request guards, the dispatcher, and the `node:http`
 * adapter.
 *
 * **What the Go did.** `dashboard.New(configPath)` built a `*Server` that owned
 * a `sync.Mutex`, three caches and an `http.Handler`; `Serve(addr)` called
 * `RequireLocalAddress` and then `http.ListenAndServe`. Authorization was
 * `r.Header.Get("X-Novamira-Dashboard-Token") == s.token`, checked by the
 * handlers that remembered to check it, and `authorizedDashboardAction`
 * additionally accepted the token out of the posted JSON body. There was no
 * `Host` or `Origin` check at all.
 *
 * **What HQ does instead, and why each change.**
 *
 * *Construction performs no I/O.* `createDashboardServer` builds the table and
 * mints the token; `listen` is the only thing that opens a socket. A route test
 * therefore never binds a port, and `dispatch` takes a plain
 * {@link DashboardRequest} and returns a {@link DashboardResponse} with no
 * `node:http` object anywhere in the graph. Go had the same idea in
 * `Server.Handler()`, but its seam was still `net/http`'s types.
 *
 * *The loopback guard is a value check, twice.* `parseListenAddress` and
 * {@link requireLoopbackHost} are pure and unit-testable without binding, and
 * the guard runs again against whatever `server.address()` actually reports —
 * Go did the same in `ServeListener` (server.go:113-120). HQ adds the IPv6 and
 * IPv4-mapped-IPv6 cases that Go got free from `net.IP.IsLoopback()` and that a
 * hand-rolled string check would miss.
 *
 * *The token is header-only.* Go's body fallback is dropped: a custom request
 * header cannot be set cross-origin without a CORS preflight this server never
 * answers, whereas a request *body* can be produced by a plain cross-origin form
 * post. Accepting the body form bought nothing — Datastar's `@post` always sends
 * the header — and widened the attack surface. Comparison is
 * `timingSafeEqual` over equal-length buffers, with a length mismatch rejected
 * before any comparison.
 *
 * *Every `/_dashboard/*` route needs the token, GET included.* Go left
 * `/_dashboard/sites` open; that GET reaches live provider APIs and its answer
 * is patched into the DOM.
 *
 * *A DNS-rebinding guard, which Go had none of.* The token alone does not close
 * the local-server hole: an attacker domain whose DNS rebinds to `127.0.0.1` is
 * same-origin to the browser, can fetch the dashboard HTML, and can read the
 * token straight out of it. So `Host` must name a loopback host on the bound
 * port, an `Origin`, when present, must be a loopback origin on the bound port,
 * and `Sec-Fetch-Site`, when present, must be `same-origin` or `none`.
 *
 * *Rejections say nothing.* Both guard failures answer HTTP 403 with the
 * ordinary failure envelope, one fixed sentence, and no `details`. The received
 * token is never echoed, never logged, never named in a message; the real token
 * appears in exactly one place in the process's output, the root `data-signals`
 * of a rendered page.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";

import type { PlatformPaths } from "../config/paths.js";
import type { ConfigStore } from "../config/profiles.js";
import { asCliError, CliError } from "../errors.js";
import type { HostingClientFactory } from "../hosting/factory.js";
import type { HistoryStore } from "../history/index.js";
import type { CredentialStore } from "../credentials/store.js";
import type { HttpFetch } from "../provisioning/http.js";
import { DASHBOARD_TOKEN_HEADER } from "./expr.js";
import { renderHtml, html } from "./html.js";
import {
  dashboardRequestFrom,
  isBodyTooLarge,
  MAX_REQUEST_BODY_BYTES,
  type DashboardRequest,
} from "./request.js";
import {
  htmlResponse,
  httpStatusFor,
  jsonFailure,
  HTML_CACHE_CONTROL,
  HTML_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  SECURITY_HEADERS,
  type DashboardResponse,
} from "./responses.js";
import {
  createRouteTable,
  matchRoute,
  pageForPath,
  type Route,
} from "./routes.js";
import { streamSse } from "./sse.js";
import { createPushService } from "./services/pushes.js";
import { createPushExecutionService } from "./services/push-execution.js";
import { createProviderService } from "./services/providers.js";
import { createSetupJobService } from "./services/setup-jobs.js";
import { createSitesService } from "./services/sites.js";
import {
  pushView,
  environmentPushSupported,
  hostingProfileView,
  type ConfigView,
} from "./views/types.js";
import type {
  ConnectionQuery,
  ConnectionSnapshot,
  ConnectOutcome,
} from "../connection-state.js";
import type {
  SiteInventorySnapshot,
  SiteProfileListing,
  SiteProfileOutcome,
} from "../site-profiles.js";

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Connected-state detection, as the dashboard needs it.
 *
 * Declared structurally rather than imported because `src/web/` and
 * `src/integration/` are peer layers and neither may depend on the other;
 * `SiteCliIntegration` satisfies this interface member for member.
 *
 * It is a **required** dependency, and that is the point. The service is what
 * degrades when `@novamira/cli` is absent — `connectionStates` answers
 * `unavailable` with an install hint and never throws — so a server built
 * without one would not be degraded, it would have the feature switched off with
 * nothing to say about it. Making the field non-optional is what stops the
 * composition root quietly shipping that: `src/cli/dashboard.ts` cannot compile
 * unless it builds the real service from the real seams.
 */
export interface DashboardIntegration {
  connectionStates(
    queries: readonly ConnectionQuery[],
  ): Promise<ConnectionSnapshot>;
  /**
   * The Connect action: spawns `novamira auth login <url>`. Resolves for every
   * failure and never throws — see `src/integration/connect.ts`, which is the
   * only place HQ runs the site CLI.
   */
  connect(siteUrl: string, name?: string): Promise<ConnectOutcome>;
  siteInventory(
    queries: readonly ConnectionQuery[],
  ): Promise<SiteInventorySnapshot>;
  /**
   * The Sites page's site-profile panel: what `novamira sites list` holds, with
   * one `auth status` per entry. Resolves for every failure and never throws —
   * an absent CLI is `cliAvailable: false` plus a reason, never an empty list,
   * because "you have no sites" and "HQ cannot tell" are different answers.
   */
  listProfiles(): Promise<SiteProfileListing>;
  /**
   * `novamira auth logout --site <name>` and `novamira sites rename/remove`.
   *
   * Both are performed by the site CLI in its own process under its own
   * credentials; HQ passes a profile name and reads the envelope's `ok`. Both
   * resolve for every integration failure; both throw `usage_error` for a name
   * the site CLI's grammar cannot represent, before anything is spawned.
   */
  logoutProfile(name: string): Promise<SiteProfileOutcome>;
  renameProfile(name: string, newName: string): Promise<SiteProfileOutcome>;
  removeProfile(name: string): Promise<SiteProfileOutcome>;
}

/**
 * The doctor report the Diagnostics page renders.
 *
 * Declared structurally, like {@link DashboardIntegration} and for the same
 * reason: `src/web/` may not import `src/doctor/`. `src/cli/dashboard.ts` builds
 * the real runner and binds it to `{ offline: true, fix: false }` — the
 * dashboard is a view, so a GET that patches a panel must neither repair the
 * operator's filesystem permissions nor make a network request.
 *
 * It is **required**, not optional. A server constructed without one would not
 * be degraded, it would have the Health check button quietly wired to nothing,
 * and making the field non-optional is what stops a composition root shipping
 * that by omission.
 */
export type DashboardDoctor = () => Promise<unknown>;

/**
 * The Settings page's update card: check the registry, install what it found.
 *
 * Declared structurally for the third time and for the third identical reason:
 * `src/web/` may not import `src/update/`. `src/cli/dashboard.ts` builds both
 * operations over the same {@link UpdateChecker} the `update` command uses, so
 * the dashboard and the CLI share one cached record, one lock key and one
 * registry — a check in the browser is a check the next `novamira-hq update`
 * does not have to repeat.
 *
 * **`install` returns `updated: false` rather than throwing** when the checker
 * finds nothing newer, because "already up to date" is an outcome and not a
 * failure. `command` is the exact package-manager command line that ran, which
 * the card renders so a failed install can be repeated by hand. The installer's
 * own stdout and stderr never cross this interface: the implementation consumes
 * them into a bounded sink and drops them.
 *
 * It is **required**, like the other two. A server built without it would have
 * the update card's buttons wired to nothing.
 */
export interface DashboardUpdates {
  check(): Promise<{
    readonly current: string;
    readonly latest: string;
    readonly updateAvailable: boolean;
    readonly checkedAt: string;
    /** Origin and path only; never a URL carrying credentials. */
    readonly registry?: string;
  }>;
  install(): Promise<{
    readonly updated: boolean;
    readonly from: string;
    readonly to: string;
    readonly command: string;
  }>;
}

export interface DashboardServerDependencies {
  readonly appAcknowledgement?: import("../config/app-acknowledgement.js").AppAcknowledgement;
  readonly mcpConnection?: import("../mcp-connection.js").McpConnectionService;
  readonly history: Pick<HistoryStore, "list">;
  readonly version: string;
  readonly paths: PlatformPaths;
  readonly store: ConfigStore;
  readonly hosting: HostingClientFactory;
  /** Lazy: constructing the credential store probes the OS keychain. 6b uses it. */
  readonly credentials: () => Promise<CredentialStore>;
  /** Injected record. Nothing under `src/web/` reads `process.env`. */
  readonly environment: NodeJS.ProcessEnv;
  /** The one outbound-HTTP seam; it reaches `provisionNovamira` and stops there. */
  readonly fetch: HttpFetch;
  /** Connected-state detection. Required; see {@link DashboardIntegration}. */
  readonly integration: DashboardIntegration;
  /** The Diagnostics page's report. Required; see {@link DashboardDoctor}. */
  readonly doctor: DashboardDoctor;
  /** The Settings page's update card. Required; see {@link DashboardUpdates}. */
  readonly updates: DashboardUpdates;
  /** Clock for cache TTLs and job timestamps. */
  readonly now: () => number;
  /** Token generator. A test injects a fixed value. */
  readonly randomToken?: () => string;
  /**
   * How long the Novamira-setup progress stream waits between renders, in
   * milliseconds. Defaults to Go's one second. It exists as a seam because that
   * loop is the one handler in the dashboard that sleeps, and a contract test
   * that had to wait a real second per tick would either be slow or would assert
   * nothing about the second iteration.
   */
  readonly setupPollMs?: number;
  /** Diagnostics sink; `main.ts` routes it to `renderer.diagnostic`. */
  readonly onDiagnostic?: (label: string, payload: unknown) => void;
  /** Extra routes, for the contract test's token-guard case. */
  readonly extraRoutes?: readonly Route[];
}

export interface ListenAddress {
  readonly hostname: string;
  readonly port: number;
}

export interface BoundAddress {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
}

export interface DashboardServer {
  /** The per-process mutation token. */
  readonly token: string;
  /** The `node:http` adapter, for socket-level tests and for `listen`. */
  readonly handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void;
  /** The route seam: no socket, no `node:http` objects. */
  dispatch(request: DashboardRequest): Promise<DashboardResponse>;
  listen(address: ListenAddress): Promise<BoundAddress>;
  close(): Promise<void>;
  /** Resolves when the listener has stopped. */
  closed(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Listen address parsing and the loopback guard                              */
/* -------------------------------------------------------------------------- */

const LISTEN_FLAG = "--listen";

function listenUsageError(message: string): CliError {
  return new CliError("usage_error", message, {
    details: { flag: LISTEN_FLAG },
  });
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) {
    throw listenUsageError(
      "The dashboard listen address needs a numeric port, as in 127.0.0.1:8787.",
    );
  }
  const port = Number(value);
  if (port > 65_535) {
    throw listenUsageError("A port must be between 0 and 65535.");
  }
  return port;
}

/**
 * Parse `:8787`, `8787`, `127.0.0.1:8787`, `localhost:8787` or `[::1]:8787`.
 *
 * An omitted host is normalized to `127.0.0.1` here rather than left empty, so
 * that everything downstream — the guard, the bind, the printed URL — sees one
 * spelling. A bare token is a port only when it is all digits, which is what
 * separates `8787` from `127.0.0.1` (a host with no port, and an error).
 */
export function parseListenAddress(value: string): ListenAddress {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw listenUsageError("The dashboard listen address must not be empty.");
  }
  if (/^\d+$/.test(trimmed)) {
    return { hostname: "127.0.0.1", port: parsePort(trimmed) };
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0 || trimmed[end + 1] !== ":") {
      throw listenUsageError(
        "A bracketed IPv6 listen address needs a port, as in [::1]:8787.",
      );
    }
    return {
      hostname: trimmed.slice(1, end),
      port: parsePort(trimmed.slice(end + 2)),
    };
  }
  const separator = trimmed.lastIndexOf(":");
  if (separator < 0) {
    throw listenUsageError(
      "The dashboard listen address needs a port, as in 127.0.0.1:8787.",
    );
  }
  const host = trimmed.slice(0, separator);
  return {
    hostname: host === "" ? "127.0.0.1" : host,
    port: parsePort(trimmed.slice(separator + 1)),
  };
}

function isLoopbackIpv4(value: string): boolean {
  if (isIP(value) !== 4) {
    return false;
  }
  return value.startsWith("127.");
}

/** Expand an IPv6 literal into its eight 16-bit groups, or `undefined`. */
function expandIpv6(value: string): readonly number[] | undefined {
  if (isIP(value) !== 6) {
    return undefined;
  }
  let text = value;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    // An embedded IPv4 tail (`::ffff:127.0.0.1`) becomes two hex groups so the
    // rest of the expansion has one shape to handle.
    const octets = tail.split(".").map((part) => Number(part));
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split("::");
  const toGroups = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  if (halves.length === 1) {
    const groups = toGroups(halves[0] ?? "");
    return groups.length === 8 ? groups : undefined;
  }
  if (halves.length !== 2) {
    return undefined;
  }
  const left = toGroups(halves[0] ?? "");
  const right = toGroups(halves[1] ?? "");
  const fill = 8 - left.length - right.length;
  if (fill < 0) {
    return undefined;
  }
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function isLoopbackIpv6(value: string): boolean {
  const groups = expandIpv6(value);
  if (groups === undefined) {
    return false;
  }
  const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
  if (!leadingZeros) {
    return false;
  }
  // `::1`
  if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
    return true;
  }
  // `::ffff:127.0.0.0/8`, in either the dotted or the hex spelling.
  return groups[5] === 0xff_ff && (groups[6] ?? 0) >>> 8 === 127;
}

/** Strip the brackets an IPv6 literal may arrive in. */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** True for the exact set of host spellings the dashboard will answer on. */
export function isLoopbackHost(hostname: string): boolean {
  const host = unbracket(hostname.trim());
  if (host === "") {
    return true;
  }
  if (host.toLowerCase() === "localhost") {
    return true;
  }
  return isLoopbackIpv4(host) || isLoopbackIpv6(host);
}

/**
 * Refuse to bind anywhere but loopback.
 *
 * The accepted set is exactly: an omitted host, the literal name `localhost`
 * (never resolved — the *name* is the allowance), any IPv4 literal in
 * `127.0.0.0/8`, the IPv6 literal `::1` with or without brackets, and an
 * IPv4-mapped IPv6 loopback. Everything else is refused, including `0.0.0.0`,
 * `::`, `localhost.evil.example` and `127.0.0.1.nip.io`.
 */
export function requireLoopbackHost(hostname: string): void {
  if (!isLoopbackHost(hostname)) {
    throw listenUsageError(
      "The dashboard binds to loopback only; use 127.0.0.1:PORT, [::1]:PORT, or localhost:PORT.",
    );
  }
}

function formatUrl(hostname: string, port: number): string {
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `http://${host}:${String(port)}`;
}

/* -------------------------------------------------------------------------- */
/* Guard failures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Errors the dispatcher must answer with 403 rather than the 400 that
 * `usage_error` maps to. A `WeakSet` keeps the taxonomy a closed union of codes
 * and keeps the marker out of the envelope.
 */
const FORBIDDEN = new WeakSet<CliError>();

function forbidden(message: string): CliError {
  const error = new CliError("usage_error", message);
  FORBIDDEN.add(error);
  return error;
}

const TOKEN_REJECTED = "The dashboard mutation token is missing or invalid.";
const HOST_REJECTED = "The dashboard accepts loopback requests only.";

/**
 * How much of an unread request body the adapter will discard before dropping
 * the connection. Sixteen times the body cap: enough that a client which sent a
 * slightly oversized body still gets its `413` on a reusable connection, small
 * enough that nothing reads an attacker-chosen number of bytes to be polite.
 */
const MAX_DISCARDED_BODY_BYTES = 16 * MAX_REQUEST_BODY_BYTES;

/* -------------------------------------------------------------------------- */
/* The server                                                                 */
/* -------------------------------------------------------------------------- */

export function createDashboardServer(
  dependencies: DashboardServerDependencies,
): DashboardServer {
  const token = dependencies.randomToken?.() ?? randomBytes(32).toString("hex");
  const tokenBuffer = Buffer.from(token, "utf8");
  let boundPort: number | undefined;
  let httpServer: Server | undefined;
  let stopped: Promise<void> | undefined;

  const sites = createSitesService({
    store: dependencies.store,
    hosting: dependencies.hosting,
    integration: dependencies.integration,
    now: dependencies.now,
  });

  const providers = createProviderService({
    store: dependencies.store,
    hosting: dependencies.hosting,
    credentials: dependencies.credentials,
    // Go's `clearSitesCacheLocked` (`server.go:1384`), on every provider
    // mutation: a removed profile must not keep answering from a warm cache.
    onMutated: () => {
      sites.invalidate();
    },
  });

  const pushes = createPushService({ store: dependencies.store });
  const pushExecution = createPushExecutionService(
    dependencies.store,
    dependencies.hosting,
  );

  // The job registry is process-lifetime state, like `lastChecked` and the
  // sites cache: an operator who restarts the dashboard has run nothing. It
  // holds the one seam that reaches the public internet (`fetch`, for the
  // plugin release and the site's discovery document) and the one that reaches
  // a provider (`hosting`), and it calls `provisionNovamira` — the same
  // function `hosting novamira setup` calls, with no commander in the graph.
  const setupJobs = createSetupJobService({
    hosting: dependencies.hosting,
    environment: dependencies.environment,
    fetch: dependencies.fetch,
    now: dependencies.now,
  });

  const loadConfigView = async (): Promise<ConfigView> => {
    const document = await dependencies.store.load();
    const profiles = Object.entries(document.hostingProfiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, profile]) =>
        hostingProfileView(name, profile, {
          environment: dependencies.environment,
          lastCheckedMillis: providers.lastChecked(name),
        }),
      );
    // Built once per view, not once per path: it walks the warm inventory, and
    // a config with a dozen pushes would otherwise walk it a dozen times.
    const resolve = sites.envResolver();
    const pushViews = Object.values(document.pushes)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((path) =>
        pushView(path, {
          resolve,
          supported: environmentPushSupported(
            document.hostingProfiles[path.hostingProfile]?.provider ?? "",
          ),
        }),
      );
    return {
      profiles,
      pushes: pushViews,
      version: dependencies.version,
      configFile: dependencies.store.configFile,
    };
  };

  const table = createRouteTable({
    history: dependencies.history,
    ...(dependencies.appAcknowledgement
      ? { appAcknowledgement: dependencies.appAcknowledgement }
      : {}),
    pushExecution,
    ...(dependencies.mcpConnection
      ? { mcpConnection: dependencies.mcpConnection }
      : {}),
    loadConfigView,
    version: dependencies.version,
    doctor: dependencies.doctor,
    updates: dependencies.updates,
    token,
    now: dependencies.now,
    providers,
    sites,
    pushes,
    setupJobs,
    integration: dependencies.integration,
    environment: dependencies.environment,
    ...(dependencies.setupPollMs === undefined
      ? {}
      : { setupPollMs: dependencies.setupPollMs }),
    ...(dependencies.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: dependencies.onDiagnostic }),
    ...(dependencies.extraRoutes === undefined
      ? {}
      : { extraRoutes: dependencies.extraRoutes }),
  });

  /* ---------------------------------------------------------------------- */
  /* Guards                                                                  */
  /* ---------------------------------------------------------------------- */

  const portMatches = (port: string | undefined): boolean => {
    if (port === undefined || port === "") {
      // A default-port request (`http://localhost` on 80) is not something the
      // dashboard can serve anyway; accepting it here keeps the guard about
      // the *host*, which is the rebinding vector.
      return true;
    }
    return boundPort === undefined || Number(port) === boundPort;
  };

  const splitHostHeader = (
    value: string,
  ): { readonly host: string; readonly port: string | undefined } => {
    if (value.startsWith("[")) {
      const end = value.indexOf("]");
      if (end < 0) {
        return { host: value, port: undefined };
      }
      const host = value.slice(0, end + 1);
      const rest = value.slice(end + 1);
      if (rest === "") {
        return { host, port: undefined };
      }
      // A bracketed authority may end with a single `:port` suffix and nothing
      // else. `[::1]garbage`, `[::1]:` and `[::1]:1:2` are malformed and must be
      // refused rather than read as a bracketed loopback host that happens to
      // carry (or ignore) a bogus suffix.
      if (!/^:[0-9]+$/.test(rest)) {
        return { host: value, port: undefined };
      }
      return { host, port: rest.slice(1) };
    }
    const separator = value.lastIndexOf(":");
    return separator < 0
      ? { host: value, port: undefined }
      : { host: value.slice(0, separator), port: value.slice(separator + 1) };
  };

  const requireLoopbackRequest = (request: DashboardRequest): void => {
    const hostHeader = request.headers.host;
    if (hostHeader === undefined || hostHeader === "") {
      throw forbidden(HOST_REJECTED);
    }
    const { host, port } = splitHostHeader(hostHeader);
    // `isLoopbackHost("")` is true, because an omitted host in a *listen
    // address* (`--listen :8787`) is a documented spelling for loopback. An
    // omitted host in a `Host` *header* (`Host: :8787`) is a malformed
    // authority, and letting the two share the allowance would let a colon walk
    // straight past the empty-header check above.
    if (host === "" || !isLoopbackHost(host) || !portMatches(port)) {
      throw forbidden(HOST_REJECTED);
    }

    // A present `Origin` must be a loopback origin — including the opaque value
    // `null`, which is what a sandboxed iframe, a `data:`/`srcdoc` document or a
    // cross-origin redirect sends, and which is therefore attacker-reachable
    // content rather than an absent header. It falls into the parse below and is
    // refused there.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== "") {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw forbidden(HOST_REJECTED);
      }
      if (
        parsed.protocol !== "http:" ||
        !isLoopbackHost(parsed.hostname) ||
        !portMatches(parsed.port)
      ) {
        throw forbidden(HOST_REJECTED);
      }
    }

    const fetchSite = request.headers["sec-fetch-site"];
    if (
      fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none"
    ) {
      throw forbidden(HOST_REJECTED);
    }
  };

  const requireToken = (request: DashboardRequest): void => {
    const presented = request.headers[DASHBOARD_TOKEN_HEADER.toLowerCase()];
    if (presented === undefined) {
      throw forbidden(TOKEN_REJECTED);
    }
    const candidate = Buffer.from(presented, "utf8");
    // A length mismatch is rejected without comparing: `timingSafeEqual`
    // throws on unequal lengths, and padding to compare would leak the length.
    if (
      candidate.byteLength !== tokenBuffer.byteLength ||
      !timingSafeEqual(candidate, tokenBuffer)
    ) {
      throw forbidden(TOKEN_REJECTED);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Dispatch                                                                */
  /* ---------------------------------------------------------------------- */

  const errorResponse = (
    request: DashboardRequest,
    error: unknown,
  ): DashboardResponse => {
    const cliError = asCliError(error);
    const status = isBodyTooLarge(cliError)
      ? 413
      : httpStatusFor(cliError.code);
    dependencies.onDiagnostic?.("dashboard", {
      method: request.method,
      path: request.path,
      code: cliError.code,
      status,
    });
    // A page path answers with a page: an operator who followed a link should
    // see the error, not a JSON blob. The code and message have already been
    // through `failureEnvelope`'s redaction on the JSON path; here they are the
    // only two things rendered, and both are escaped by the template.
    if (pageForPath(request.path) !== undefined) {
      return htmlResponse(
        html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Novamira HQ</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><main class="main"><section class="page"><h1>Something went wrong</h1><p>${cliError.code}</p><p>${cliError.message}</p></section></main></body>
</html>
`,
        status,
      );
    }
    return jsonFailure(cliError, status);
  };

  const dispatch = async (
    request: DashboardRequest,
  ): Promise<DashboardResponse> => {
    try {
      requireLoopbackRequest(request);
    } catch (error) {
      return jsonFailure(asCliError(error), 403);
    }

    const match = matchRoute(table, request.method, request.path);
    if (match === undefined) {
      return jsonFailure(
        new CliError("not_found", "No such dashboard route."),
        404,
      );
    }
    if ("allow" in match) {
      return jsonFailure(
        new CliError("usage_error", "That method is not allowed here."),
        405,
        { Allow: match.allow.join(", ") },
      );
    }
    if (match.route.auth === "token") {
      try {
        requireToken(request);
      } catch (error) {
        return jsonFailure(asCliError(error), 403);
      }
    }
    try {
      return await match.route.handler(request);
    } catch (error) {
      return errorResponse(request, error);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* The node:http adapter                                                   */
  /* ---------------------------------------------------------------------- */

  const writeResponse = (
    response: ServerResponse,
    result: DashboardResponse,
  ): void => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    switch (result.kind) {
      case "html": {
        const body = Buffer.from(renderHtml(result.body), "utf8");
        response.setHeader("Content-Type", HTML_CONTENT_TYPE);
        response.setHeader("Cache-Control", HTML_CACHE_CONTROL);
        response.setHeader("Content-Length", body.byteLength);
        response.writeHead(result.status);
        response.end(body);
        return;
      }
      case "json": {
        const body = Buffer.from(
          `${JSON.stringify(result.envelope)}\n`,
          "utf8",
        );
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          response.setHeader(name, value);
        }
        response.setHeader("Content-Type", JSON_CONTENT_TYPE);
        response.setHeader("Cache-Control", HTML_CACHE_CONTROL);
        response.setHeader("Content-Length", body.byteLength);
        response.writeHead(result.status);
        response.end(body);
        return;
      }
      case "text": {
        const body = Buffer.from(result.body, "utf8");
        response.setHeader("Content-Type", result.contentType);
        response.setHeader("Cache-Control", HTML_CACHE_CONTROL);
        response.setHeader("Content-Length", body.byteLength);
        response.writeHead(result.status);
        response.end(body);
        return;
      }
      case "asset": {
        if (result.contentDisposition)
          response.setHeader("Content-Disposition", result.contentDisposition);
        response.setHeader("Content-Type", result.contentType);
        response.setHeader("Cache-Control", result.cacheControl);
        response.setHeader("ETag", result.etag);
        response.setHeader("Content-Length", result.contentLength);
        response.writeHead(result.status);
        if (result.body === undefined) {
          response.end();
        } else {
          response.end(Buffer.from(result.body));
        }
        return;
      }
      case "sse":
        // Handled by `respond`, which owns the IncomingMessage the SDK needs.
        response.writeHead(500);
        response.end();
        return;
      default: {
        const unexpected: never = result;
        throw new CliError(
          "internal_error",
          `Unhandled dashboard response kind: ${String(unexpected)}.`,
        );
      }
    }
  };

  /**
   * Discard whatever is left of a request body the handler did not read.
   *
   * A refused body (413) is the case that matters: the response has been written
   * by the time this runs, and destroying the socket instead would replace the
   * documented status with a connection reset — the client would never see the
   * `413` at all. Node would drain the remainder itself (`req._dump()`), without
   * a limit; this does the same thing with one, so a sender that keeps pushing
   * after being refused loses its connection rather than a byte budget.
   */
  const drainRemainder = (message: IncomingMessage): void => {
    if (message.complete) {
      return;
    }
    let drained = 0;
    message.on("data", (chunk: Buffer | string) => {
      drained += Buffer.byteLength(chunk);
      if (drained > MAX_DISCARDED_BODY_BYTES) {
        message.destroy();
      }
    });
    message.resume();
  };

  const respond = async (
    message: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const request = dashboardRequestFrom(message, response);
    const result = await dispatch(request);
    if (result.kind === "sse") {
      await streamSse(message, response, (stream) => result.run(stream));
      return;
    }
    writeResponse(response, result);
    drainRemainder(message);
  };

  const handler = (
    message: IncomingMessage,
    response: ServerResponse,
  ): void => {
    void respond(message, response).catch((error: unknown) => {
      // The dispatcher already turns every handler failure into a response, so
      // reaching here means the socket itself failed. Nothing can be written to
      // it; record the shape and drop the connection.
      dependencies.onDiagnostic?.("dashboard", {
        code: asCliError(error).code,
      });
      response.destroy();
    });
  };

  /* ---------------------------------------------------------------------- */
  /* Listening                                                               */
  /* ---------------------------------------------------------------------- */

  const listen = async (address: ListenAddress): Promise<BoundAddress> => {
    if (shutdown !== undefined) {
      throw new CliError("conflict", "The dashboard server has been closed.");
    }
    // Before any socket exists: a non-loopback bind never opens a listener.
    requireLoopbackHost(address.hostname);
    const server = createServer(handler);
    httpServer = server;
    stopped = new Promise<void>((resolve) => {
      server.once("close", resolve);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener("listening", onListening);
        reject(listenFailure(error));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address.port, address.hostname);
    });

    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      server.close();
      throw new CliError(
        "internal_error",
        "The dashboard listener reported no address.",
      );
    }
    // The second check, on what the kernel actually gave us. Go did the same in
    // `ServeListener`; an invariant that broke here is a bug, not a usage error.
    if (!isLoopbackHost(bound.address)) {
      server.close();
      throw new CliError(
        "internal_error",
        "The dashboard listener bound to a non-loopback address.",
      );
    }
    boundPort = bound.port;
    return {
      hostname: bound.address,
      port: bound.port,
      url: formatUrl(bound.address, bound.port),
    };
  };

  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown !== undefined) return shutdown;
    shutdown = (async () => {
      const jobsStopped = setupJobs.shutdown();
      const pushesStopped = pushExecution.shutdown();
      const server = httpServer;
      if (server !== undefined) {
        // Keep-alive sockets would otherwise hold `close` open until timeout.
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        });
      }
      await jobsStopped;
      await pushesStopped;
    })();
    return shutdown;
  };

  return {
    token,
    handler,
    dispatch,
    listen,
    close,
    closed: () => shutdown ?? stopped ?? Promise.resolve(),
  };
}

function listenFailure(error: NodeJS.ErrnoException): CliError {
  if (error.code === "EADDRINUSE") {
    return new CliError(
      "conflict",
      "That dashboard listen address is already in use.",
      { details: { flag: LISTEN_FLAG }, cause: error },
    );
  }
  if (error.code === "EACCES") {
    return new CliError(
      "usage_error",
      "That dashboard listen address may not be bound; choose a port above 1023.",
      { details: { flag: LISTEN_FLAG }, cause: error },
    );
  }
  return new CliError(
    "internal_error",
    "The dashboard listener could not start.",
    { cause: error },
  );
}

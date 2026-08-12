// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The **Connect** action: `novamira auth login <url>`, spawned as a child.
 *
 * **What the Go did.** Nothing — there was no Connect action. Go's dashboard
 * "connected" a site by posting a WordPress URL and an Application Password to
 * `/_dashboard/sites/save`, creating the password over the site's REST API and
 * writing the credential into its own config as a `site_profiles` entry. Every
 * one of those steps is deleted under the boundary rule, and none of it is
 * ported: HQ holds no site token and makes no request to a configured site.
 *
 * **What HQ does instead** (plan §8, decision 3). It spawns the site CLI and
 * gets out of the way. The child owns the browser launch, the OAuth callback and
 * the credential write; HQ observes only whether the child's v1 envelope said
 * `ok`. That is why this module lives in `src/integration/` and not in
 * `src/web/`: `CLAUDE.md` makes this package "the **only** place HQ runs
 * `novamira`", and a Connect button in a view calling `spawn` would put a child
 * process behind a renderer.
 *
 * **The rules, all load-bearing.**
 *
 * - `shell: false` and an argv array — inherited from {@link SpawnChild}, which
 *   has no other mode. The **non-secret site URL is the only argument**; there
 *   is deliberately no `--name`, because profile naming belongs to the site CLI
 *   and inventing one here would be HQ holding site state.
 * - Its own timeout and its own `AbortSignal`. {@link AUTH_LOGIN_TIMEOUT_MS} is
 *   five minutes rather than the ten seconds a query gets: this is an
 *   interactive OAuth flow with a human in it, and killing it at ten seconds
 *   would make Connect look broken on every first use.
 * - Child output is parsed for the envelope's `ok` and then **discarded**. It is
 *   never persisted, never logged, never rendered, and never attached to an
 *   error. A failure surfaces as the fixed `unavailableHint(reason)` sentence,
 *   which is why {@link ConnectOutcome}'s failure arm carries a reason enum and
 *   has nowhere to put a string.
 * - It resolves for every failure and never throws, exactly as
 *   `connectionStates` does. Integration failure is a state.
 *
 * **Hand-off.** 6b-2's `/_dashboard/connect` handler validates `?url=` with
 * `normalizeSiteUrl` from `src/provisioning/site-url.ts` *before* the value
 * reaches {@link authLoginArgs}, refreshes connection state on success, and
 * patches a toast carrying `unavailableHint(reason)` — never child text — on
 * failure.
 */

import type { ConnectOutcome, UnavailableReason } from "../connection-state.js";
import { CliError } from "../errors.js";
import { isSiteProfileName } from "../site-profiles.js";
import { interpretChildOutcome } from "./classify.js";
import { siteCliChildEnv } from "./site-cli.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";
import type { ResolveSiteCli, SiteCliResolution } from "./resolve.js";

export type { ConnectOutcome } from "../connection-state.js";

/**
 * Five minutes. An interactive OAuth flow, not a query: the operator has to
 * reach a browser, authenticate, and approve. `connectionStates`' ten-second
 * per-child timeout would abort a healthy login.
 */
export const AUTH_LOGIN_TIMEOUT_MS = 300_000;

/**
 * `novamira --json --quiet auth login <url>`.
 *
 * Globals first, as the CLI's grammar specifies. No `--timeout`: the CLI's own
 * request budget must not cut short a flow that waits on a human, and HQ's
 * bound is the child timeout plus the abort signal below. No `--name`, and no
 * second argument of any kind.
 */
export function authLoginArgs(
  siteUrl: string,
  name?: string,
): readonly string[] {
  return [
    "--json",
    "--quiet",
    "auth",
    "login",
    siteUrl,
    ...(name === undefined ? [] : ["--name", name]),
  ];
}

export interface ConnectActionOptions {
  readonly spawn: SpawnChild;
  readonly resolve: ResolveSiteCli;
  /** The injected process environment, passed through to the child. */
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

const CONNECTED: ConnectOutcome = Object.freeze({ kind: "connected" as const });

function failed(reason: UnavailableReason): ConnectOutcome {
  return { kind: "failed", reason };
}

/**
 * Build the action. It is a factory rather than a method so `connection.ts` can
 * compose it into `SiteCliIntegration` without either sibling importing the
 * other's implementation.
 */
export function createConnectAction(
  options: ConnectActionOptions,
): (siteUrl: string, name?: string) => Promise<ConnectOutcome> {
  const timeoutMs = options.timeoutMs ?? AUTH_LOGIN_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  return async (siteUrl: string, name?: string): Promise<ConnectOutcome> => {
    if (name !== undefined && !isSiteProfileName(name)) {
      throw new CliError(
        "usage_error",
        "A Novamira site profile name must start with a letter or digit and may contain only letters, digits, '.', '_' and '-'.",
      );
    }
    let resolution: SiteCliResolution | undefined;
    try {
      resolution = await options.resolve();
    } catch {
      // A probe that throws is a failed probe, not an absent CLI.
      return failed("cli_failed");
    }
    if (resolution === undefined) return failed("cli_absent");

    // One login, one deadline. `AbortSignal.timeout` is the same mechanism the
    // refresh uses; the child timer is the belt to its braces.
    const signal = AbortSignal.timeout(timeoutMs + 1_000);
    const outcome = await options.spawn({
      command: resolution.command,
      args: [...resolution.prefixArgs, ...authLoginArgs(siteUrl, name)],
      env: siteCliChildEnv(options.environment),
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      signal,
    });

    const result = interpretChildOutcome(outcome);
    switch (result.kind) {
      case "data":
        // The payload is deliberately not inspected. `ok: true` from
        // `auth login` is the CLI saying the credential is written; anything
        // HQ read out of it would be site state HQ must not hold.
        return CONNECTED;
      case "site_missing":
        // `site_not_found` from a command that creates the profile means the
        // installed CLI does not mean what HQ means by `auth login <url>`.
        return failed("cli_incompatible");
      case "failure":
        return failed(result.reason);
    }
  };
}

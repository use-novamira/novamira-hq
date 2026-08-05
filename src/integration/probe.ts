// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Is `novamira` installed, and is it a version HQ can work with?" — one child,
 * one answer, never an exception.
 *
 * **What the Go did.** `doctor.binaryOnPath` (`internal/doctor/doctor.go:189-212`)
 * split `PATH` on a hand-picked `":"`/`";"`, joined `"novamira"` (or
 * `"novamira.exe"`) onto each entry, and `os.Stat`ed it. It reported a boolean:
 * no version, no distinction between "absent" and "there but too old", and no
 * handling of the Windows shim layout that `src/integration/resolve.ts` exists
 * for — a global npm install writes `novamira.cmd`, which that check would find
 * and Node cannot spawn.
 *
 * **Why this lives in `src/integration/` and not in `src/doctor/`.**
 * `CLAUDE.md`: `src/integration/` is the **only** place HQ runs `novamira`.
 * The doctor needs the answer, not a second spawn seam, so the probe is declared
 * here beside the resolver and the child seam it reuses, and `src/doctor/` takes
 * a {@link ProbeSiteCli} function on its dependency record. Two spawners would be
 * two sets of timeouts, two environments and two ways to leak child output.
 *
 * **The invariant.** Every branch below is a *state*. The probe never throws and
 * never rejects, and the doctor check built on it is a `warn` at worst —
 * `@novamira/cli` is an optional integration, and a fresh install of HQ with no
 * site CLI is a working install, not a broken one. Child stdout is parsed for
 * one field and dropped: nothing is logged, nothing is persisted, and the only
 * thing that reaches the report is the version string the child printed.
 *
 * **Why `--version` and not something richer.** `novamira --json --quiet
 * --version` is part of the site CLI's frozen v1 grammar and answers
 * `{"ok":true,"data":{"version":"…"}}` without touching the network, the
 * operator's profiles or their credential store. It is the cheapest question
 * that distinguishes the four outcomes, and it is the only one HQ asks here.
 *
 * **The reason tables are `classify.ts`'s.** `OUTCOME_REASONS` and the envelope
 * mapping already exist for `connectionStates` and `connect`; reusing them is
 * what keeps "the CLI timed out" the same answer whichever of the three asked.
 */

import type { UnavailableReason } from "../connection-state.js";
import { asRecord } from "../json.js";
import { interpretChildOutcome } from "./classify.js";
import { SITE_CLI_INSTALL_HINT, type ResolveSiteCli } from "./resolve.js";
import { siteCliChildEnv } from "./site-cli.js";
import {
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type SpawnChild,
} from "./spawn.js";

/**
 * The oldest `@novamira/cli` whose v1 grammar and JSON payloads HQ's integration
 * is written against — `sites list`, `auth status`, `auth login`, and the
 * envelope. Below it, connected-state detection may report `malformed_output`
 * for a CLI that is merely old, which is a worse answer than "update it".
 */
export const MINIMUM_SITE_CLI_VERSION = "1.0.0";

export type SiteCliProbeStatus =
  "available" | "absent" | "incompatible" | "unreadable";

export interface SiteCliProbe {
  readonly status: SiteCliProbeStatus;
  /** The resolved executable path. Non-secret, and never a command line. */
  readonly command?: string;
  /** Whatever the child reported, when it reported something parseable. */
  readonly version?: string;
  readonly minimum: string;
  /** Why the answer is not `available`; absent for `available`. */
  readonly reason?: UnavailableReason;
  /** A fixed operator-facing sentence; present for `absent`. */
  readonly hint?: string;
}

export type ProbeSiteCli = () => Promise<SiteCliProbe>;

export interface SiteCliProbeOptions {
  readonly resolve: ResolveSiteCli;
  readonly spawn: SpawnChild;
  /** The injected process environment; nothing here reads `process.env`. */
  readonly environment: NodeJS.ProcessEnv;
  /** Per-child budget. Five seconds: `--version` does no I/O of its own. */
  readonly timeoutMs?: number;
}

/** `novamira --json --quiet --version`. Globals first, as the grammar spells it. */
export function versionArgs(): readonly string[] {
  return ["--json", "--quiet", "--version"];
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

const NUMERIC = /^\d+$/;

/**
 * A total, three-field comparison of two dotted versions.
 *
 * Deliberately not a SemVer implementation: HQ's own SemVer machinery lives in
 * `src/provisioning/compatibility.ts` and `src/update/` will lift it into a leaf
 * module (Phase 7's second batch). Importing `src/provisioning/` from
 * `src/integration/` to compare "1.0.3" against "1.0.0" would couple two peer
 * layers for four lines of arithmetic. A prerelease suffix is ignored rather
 * than ordered: `1.0.0-rc.1` counts as satisfying a `1.0.0` floor, which is the
 * lenient direction, and this check may only ever produce a warning anyway.
 */
function atLeast(candidate: string, minimum: string): boolean {
  const parts = (value: string): readonly number[] =>
    value
      .split("-")[0]
      ?.split(".")
      .map((part) => (NUMERIC.test(part) ? Number(part) : Number.NaN)) ?? [];
  const left = parts(candidate);
  const right = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (Number.isNaN(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
}

/** `data.version`, when the child answered with one. */
function versionOf(data: unknown): string | undefined {
  const value: unknown = asRecord(data)?.version;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function createSiteCliProbe(options: SiteCliProbeOptions): ProbeSiteCli {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return async (): Promise<SiteCliProbe> => {
    let resolution;
    try {
      resolution = await options.resolve();
    } catch {
      // A probe that throws is a failed probe, not an absent CLI — the same
      // distinction `connect.ts` makes.
      return {
        status: "unreadable",
        minimum: MINIMUM_SITE_CLI_VERSION,
        reason: "cli_failed",
      };
    }
    if (resolution === undefined) {
      // `resolve.ts` deliberately does not cache a negative answer, so
      // installing the CLI is picked up without restarting anything. Nothing is
      // spawned on this path.
      return {
        status: "absent",
        minimum: MINIMUM_SITE_CLI_VERSION,
        reason: "cli_absent",
        hint: SITE_CLI_INSTALL_HINT,
      };
    }

    const outcome = await options.spawn({
      command: resolution.command,
      args: [...resolution.prefixArgs, ...versionArgs()],
      env: siteCliChildEnv(options.environment),
      timeoutMs,
      maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: DEFAULT_MAX_STDERR_BYTES,
      signal: AbortSignal.timeout(timeoutMs + 1_000),
    });

    const command = resolution.command;
    const result = interpretChildOutcome(outcome);
    switch (result.kind) {
      case "failure":
        return {
          status: "unreadable",
          command,
          minimum: MINIMUM_SITE_CLI_VERSION,
          reason: result.reason,
        };
      case "site_missing":
        // `site_not_found` from `--version` is not a thing any coherent CLI
        // says; treat it the way `connect.ts` does — the installed program does
        // not mean what HQ means.
        return {
          status: "incompatible",
          command,
          minimum: MINIMUM_SITE_CLI_VERSION,
          reason: "cli_incompatible",
        };
      case "data": {
        const version = versionOf(result.data);
        if (version === undefined) {
          return {
            status: "unreadable",
            command,
            minimum: MINIMUM_SITE_CLI_VERSION,
            reason: "malformed_output",
          };
        }
        if (!atLeast(version, MINIMUM_SITE_CLI_VERSION)) {
          return {
            status: "incompatible",
            command,
            version,
            minimum: MINIMUM_SITE_CLI_VERSION,
            reason: "cli_incompatible",
          };
        }
        return {
          status: "available",
          command,
          version,
          minimum: MINIMUM_SITE_CLI_VERSION,
        };
      }
    }
  };
}

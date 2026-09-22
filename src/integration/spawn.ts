// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one child-process seam the site CLI integration runs through.
 *
 * **What the Go did.** `internal/dashboard` shelled out to `novamira` through
 * `exec.CommandContext` at each call site, read `CombinedOutput()` into an
 * unbounded buffer, and folded every failure into "not linked". A killed child
 * and a child that ran to completion arrived at the same place, so a five-second
 * hang and a genuine "no such profile" were indistinguishable.
 *
 * **What HQ does instead.** One `SpawnChild` function type, injected everywhere,
 * with a total {@link ChildOutcome} union that names *why* a child produced no
 * usable stdout. `connection.ts` maps each kind to exactly one
 * `UnavailableReason`, so "the CLI is not installed", "the CLI timed out" and
 * "the CLI printed something HQ cannot read" stay three different answers all
 * the way to the dashboard. Every contract test injects its own `SpawnChild`;
 * no test ever starts a real `novamira`.
 *
 * **The lesson carried over verbatim from `SpawnCommandExecutor`**
 * (`src/credentials/keychain-backends.ts:88-99`): *a killed child MUST NOT look
 * like a normal exit status.* There it mattered because a timed-out
 * `secret-tool lookup` reported as status 1 reads as "no such secret" and lets a
 * rollback delete a credential that exists. Here it matters because a timed-out
 * `novamira auth status` reported as a non-zero exit would be classified from
 * its (absent) error envelope as `malformed_output` instead of `cli_timeout`.
 * So a killed child always resolves with `code: null` and a kind that is never
 * `"exited"`. This module deliberately does **not** reuse
 * `SpawnCommandExecutor`: its messages are credential-flavoured, it discards
 * stderr, its cap is 1 MiB, and it *rejects* on spawn failure.
 *
 * **Invariants this file exists to guarantee.**
 *
 * - Never a shell. `spawn(command, args, { shell: false })`, an argv array, no
 *   string command line anywhere — the rule that makes an operator-controlled
 *   profile name harmless.
 * - stdin is `"ignore"` for probes and profile actions; bounded JSON input for
 *   WordPress operations uses a pipe that is closed after writing. Every invocation passes `--json`, which guarantees the
 *   child never prompts; an inherited stdin could otherwise let a child block on
 *   a terminal the dashboard does not own.
 * - Bounded output. stdout and stderr are capped and the child is killed on
 *   overflow, so a runaway child cannot grow the dashboard's heap.
 * - Bounded time, twice: a per-child timer and a shared {@link AbortSignal} that
 *   carries the whole refresh's deadline.
 * - Killing a child owns its whole process tree. The child starts as a POSIX
 *   process-group leader (or a Windows new-process-group), and termination is
 *   delivered to the group, negatively on Unix and through `taskkill /T` on
 *   Windows, so descendants neither survive the deadline nor keep the promise
 *   open through inherited pipes.
 * - It never throws and never rejects. Every failure, including a synchronous
 *   `spawn` throw, is a `ChildOutcome`.
 * - Captured output lives in memory for the duration of the call and no longer.
 *   It is never written to disk, logged, rendered in the dashboard or attached to
 *   an error. WordPress MCP operations may return parsed, redacted data.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";

export interface ChildInvocation {
  /** An executable path or a bare name resolved from `PATH`. Never a command line. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Shared across every child of one refresh: the overall deadline. */
  readonly signal: AbortSignal;
  /** Bounded JSON input for a non-interactive site operation; never inherited. */
  readonly input?: string;
  /** Public terminal forwarding: inherit all streams without buffering output. */
  readonly inheritStdio?: boolean;
}

/**
 * Why the child stopped.
 *
 * `"exited"` is the *only* kind whose `code` may be read, and even then nothing
 * in `connection.ts` reads it: the JSON envelope on stdout is authoritative.
 */
export type ChildOutcomeKind =
  | "exited"
  | "timed_out"
  | "aborted"
  | "truncated"
  | "not_found"
  | "spawn_failed";

export interface ChildOutcome {
  readonly kind: ChildOutcomeKind;
  /** The exit status, and `null` for every kind other than `"exited"`. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SpawnChild = (invocation: ChildInvocation) => Promise<ChildOutcome>;

/** Defaults shared by the invocation builder and the integration options. */
export const DEFAULT_MAX_STDOUT_BYTES = 262_144;
export const DEFAULT_MAX_STDERR_BYTES = 32_768;

/**
 * How long a terminated child is given to exit on `SIGTERM` before `SIGKILL`.
 * Node's own `child_process` timeout has no escalation at all; a child ignoring
 * `SIGTERM` would otherwise hold the promise open past the refresh deadline.
 */
const KILL_GRACE_MS = 2_000;

const NO_OUTPUT = { stdout: "", stderr: "" } as const;

/** The `code` property of an `ErrnoException`, without an `any` in sight. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** ENOENT is "the CLI is not installed"; everything else is a failed start. */
function startFailureKind(error: unknown): ChildOutcomeKind {
  return errnoCode(error) === "ENOENT" ? "not_found" : "spawn_failed";
}

/**
 * Run one child and resolve with its outcome.
 *
 * The promise executor below never rejects, so `only-throw-error` and the
 * "integration failure is a state, not an exception" rule hold structurally
 * rather than by convention.
 */
export const nodeSpawnChild: SpawnChild = (invocation) =>
  new Promise<ChildOutcome>((resolve) => {
    // The deadline may already have passed while an earlier child ran. Starting
    // a process only to kill it is pure cost, so report `aborted` and spawn
    // nothing at all.
    if (invocation.signal.aborted) {
      resolve({ kind: "aborted", code: null, ...NO_OUTPUT });
      return;
    }

    let child: ChildProcess;
    try {
      // The child leads its own process group (POSIX) or new process group
      // (Windows) so `terminate` can signal its whole tree, never just the
      // direct child. `detached` affects process-group membership, never
      // stdio. The child is deliberately kept referenced: an unref'd child
      // plus unref'd timers lets Node exit while this promise is still
      // pending, so the outcome can never settle (see the invariants above).
      child = spawn(invocation.command, [...invocation.args], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: invocation.inheritStdio
          ? "inherit"
          : [
              invocation.input === undefined ? "ignore" : "pipe",
              "pipe",
              "pipe",
            ],
        env: invocation.env,
      });
    } catch (error: unknown) {
      // `spawn` throws synchronously for an invalid argument shape; an ENOENT
      // arrives asynchronously on `error`. Both are the same answer here.
      resolve({ kind: startFailureKind(error), code: null, ...NO_OUTPUT });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    /** Set the moment we decide to kill; it outranks whatever exit follows. */
    let terminationKind: ChildOutcomeKind | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    /**
     * Signal the child's whole tree, not just the direct child. POSIX: the
     * negative pid addresses the process group the child was created as the
     * leader of. Windows: `taskkill /T` walks the process tree rooted at the
     * child (`/F` because `taskkill` has no graceful variant). Either call can
     * race the tree's own exit, and the outcome is the child's to report, so a
     * failure here is absorbed. A direct `child.kill()` remains the fallback:
     * if the group id ever differs from the child's pid, killing at least the
     * direct child is better than killing nothing.
     */
    const killTree = (signal: "SIGTERM" | "SIGKILL"): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        execFile(
          "taskkill",
          ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
          { windowsHide: true, timeout: KILL_GRACE_MS },
          () => undefined,
        );
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child is already gone; the `close` event settles the outcome.
        }
      }
    };

    const terminate = (kind: ChildOutcomeKind): void => {
      terminationKind ??= kind;
      if (killTimer !== undefined) return;
      killTree("SIGTERM");
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
      }, KILL_GRACE_MS);
      // Referenced: this escalation is what reaps a descendant that ignores
      // SIGTERM and holds no pipe, so Node must stay alive until it fires.
    };

    const timer = setTimeout(() => {
      terminate("timed_out");
    }, invocation.timeoutMs);
    // Referenced: `finish` clears it on settlement, so it never outlives the
    // promise. Unref'ing it would let Node exit while the child is still
    // running, with the outcome never settling (see `child.unref()` removal).

    const onAbort = (): void => {
      terminate("aborted");
    };
    invocation.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (kind: ChildOutcomeKind, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The outcome settles the moment the direct child's pipes flush, but a
      // descendant that ignores SIGTERM and holds no pipe can outlive that. The
      // SIGKILL escalation is therefore left armed — referenced, so Node stays
      // alive until it fires — rather than cleared on settlement. It reaches the
      // whole process group, so it reaps such descendants after the grace period
      // even though this promise has already resolved. On a normal exit no
      // escalation was ever scheduled (`killTimer` is set only inside
      // `terminate`), so there is nothing to clear here.
      invocation.signal.removeEventListener("abort", onAbort);
      resolve({
        kind,
        // A killed child MUST NOT look like a normal exit status.
        code: kind === "exited" ? code : null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };

    if (child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(invocation.input);
    }
    if (child.stdout !== null) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= invocation.maxStdoutBytes) stdoutChunks.push(chunk);
        else terminate("truncated");
      });
      // A pipe that errors after the child was killed is the child's outcome to
      // report, not an unhandled exception that takes the dashboard down.
      child.stdout.on("error", () => undefined);
    }
    if (child.stderr !== null) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= invocation.maxStderrBytes) stderrChunks.push(chunk);
        else terminate("truncated");
      });
      child.stderr.on("error", () => undefined);
    }

    child.once("error", (error: unknown) => {
      finish(startFailureKind(error), null);
    });
    // `close` rather than `exit`: both pipes have flushed by then, so a child
    // that writes its envelope and exits immediately cannot lose it. `close`
    // also guarantees the promise settles after a kill: termination is
    // delivered to the whole tree, and a pipe can only stay open while a tree
    // member still lives — so the forced-kill escalation always ends in a
    // `close`, never in a promise held open by orphaned descendants.
    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          terminationKind ?? "exited",
          code ?? (signal === null ? null : 128 + constants.signals[signal]),
        );
      },
    );
  });

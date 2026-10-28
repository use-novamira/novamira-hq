// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

type Listener = (value?: unknown) => void;

/**
 * Runs an AI client's CLI (`claude`, `codex`, `code`) for MCP configuration.
 *
 * Deno's `node:child_process` treats any argument equal to `Deno.execPath()`
 * as a re-launch of Deno and rewrites the arguments after it as Node flags, so
 * `claude mcp add ... -- <HQ executable> --mcp` registered `--v8-flags=--mcp`.
 * `Deno.Command` passes the argv through unchanged. Only the subset the
 * connector uses is implemented: no shell, a replaced environment, ignored
 * stdio, `error`/`close` events and `kill`.
 */
export function connectorSpawn(
  command: string,
  args: readonly string[],
  options: { readonly env?: Record<string, string | undefined> },
): {
  on(event: "error" | "close", listener: Listener): void;
  kill(signal?: Deno.Signal): void;
} {
  const listeners = { error: [] as Listener[], close: [] as Listener[] };
  const emit = (event: "error" | "close", value?: unknown) =>
    queueMicrotask(() => {
      for (const listener of listeners[event]) listener(value);
    });
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(command, {
      args: [...args],
      clearEnv: true,
      env: Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    child.status.then(
      (status) => emit("close", status.code),
      (error) => emit("error", error),
    );
  } catch (error) {
    emit("error", error);
  }
  return {
    on(event, listener) {
      listeners[event].push(listener);
    },
    kill(signal = "SIGKILL") {
      try {
        child?.kill(signal);
      } catch { /* exited */ }
    },
  };
}

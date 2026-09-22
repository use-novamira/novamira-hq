// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Novamira HQ as a desktop application: the local dashboard inside a native
 * window, hosted by Deno with the `@webview/webview` backend.
 *
 * **Two processes, one executable.** `Webview.run()` is a blocking FFI call
 * that owns the thread until the window closes, so the dashboard's HTTP server
 * cannot share its event loop. The executable therefore runs in one of two
 * roles: launched plainly it is the *window*, which re-spawns itself in the
 * *server* role (`--serve`), reads the one JSON envelope `novamira-hq dashboard
 * --json` prints, and navigates the window to the bound URL. The server role is
 * nothing but `main(["dashboard", "--json", "--listen", "127.0.0.1:0"])` from
 * HQ's own composition root, executed under Deno's Node compatibility layer —
 * no second copy of the CLI, no second server, no second output contract.
 *
 * **Port 0, always.** A desktop window is not `--open`: it must never attach to
 * a dashboard some other process is running, because its lifetime is the
 * window's and closing it kills the server it started — and only that one.
 *
 * **Nothing the CLI forbids becomes allowed here.** The server is a loopback
 * listener with the CLI's per-process mutation token; the window is a browser
 * pointed at it. The boundary rule, the storage namespace and the site-CLI
 * integration are untouched because the code that enforces them is the code
 * that runs.
 */

import {
  DESKTOP_RELEASE_SCRIPT,
  MCP_DOWNLOAD_SCRIPT,
  openDesktopRelease,
  openMcpDownload,
  prepareBundledWebview,
  prepareCommandPath,
} from "./runtime.ts";
import { installMacMenus } from "./macos-menu.ts";
import process from "node:process";
import {
  commandRegistration,
  isCommandLauncher,
  launchCommand,
  mcpLaunch,
} from "./command-registration.ts";

const SERVE_FLAG = "--serve";
const WINDOW_TITLE = "Novamira HQ";
const STARTUP_TIMEOUT_MS = 30_000;

interface DashboardEnvelope {
  readonly ok: boolean;
  readonly data?: { readonly url?: unknown };
  readonly error?: { readonly message?: unknown };
}

function siteCliLaunch() {
  return {
    command: Deno.execPath(),
    prefixArgs: [...serverArgs(), "--site-cli"],
  };
}

if (isCommandLauncher) {
  Deno.exit(await launchCommand());
} else if (Deno.args[0] === "--command-registration") {
  try {
    const registration = await commandRegistration();
    const action = Deno.args[1] ?? "status";
    if (!["status", "enable", "repair", "remove"].includes(action)) {
      throw new Error("Expected status, enable, repair or remove.");
    }
    const result = await registration
      [action as "status" | "enable" | "repair" | "remove"]();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(String(error));
    Deno.exit(1);
  }
} else if (Deno.args[0] === "--skill-registrar") {
  const { registrar } = await import("./registrar.ts");
  await registrar(Deno.args.slice(1));
} else if (Deno.args[0] === "--site-cli") {
  const { main } = await import("@novamira/cli/entry");
  Deno.exit(
    await main(Deno.args.slice(1), undefined, undefined, {
      managed: {
        updateHint: "Update Novamira HQ to update its bundled site CLI.",
        commandPrefix: "novamira-hq site-cli",
      },
    }),
  );
} else if (Deno.args[0] === "--mcp") {
  await prepareCommandPath();
  const specifier = new URL("../dist/mcp/main.js", import.meta.url).href;
  const { mcpMain } = (await import(specifier)) as {
    mcpMain(
      argv: readonly string[],
      streams: undefined,
      environment: undefined,
      overrides: {
        siteCliLaunch: ReturnType<typeof siteCliLaunch>;
        distribution: "desktop";
        mcpLaunch: { command: string; args: string[] };
      },
    ): Promise<void>;
  };
  await mcpMain(Deno.args.slice(1), undefined, undefined, {
    siteCliLaunch: siteCliLaunch(),
    distribution: "desktop",
    mcpLaunch: await mcpLaunch({
      command: Deno.execPath(),
      args: [...serverArgs(), "--mcp"],
    }),
  });
} else if (Deno.args[0] === "--cli") {
  // Signed terminal entry point: same commands and credential backend as the
  // dashboard, without opening a window or exposing a raw-secret bridge.
  await prepareCommandPath();
  const specifier = new URL("../dist/main.js", import.meta.url).href;
  const { main } = (await import(specifier)) as typeof import("./hq.d.ts");
  // Drain integration's referenced process-tree kill escalation before exit.
  process.exitCode = await main(Deno.args.slice(1), undefined, undefined, {
    distribution: "desktop",
    siteCliLaunch: siteCliLaunch(),
    mcpLaunch: await mcpLaunch({
      command: Deno.execPath(),
      args: [...serverArgs(), "--mcp"],
    }),
  });
} else if (Deno.args[0] === SERVE_FLAG) {
  await serve();
} else {
  Deno.exit(await window());
}

/** The server role: HQ's own `dashboard` command, in this process. */
async function serve(): Promise<void> {
  watchParent();
  await prepareCommandPath();
  // Built at runtime, not written as a literal: the shell's own module graph
  // must stop here. `dist/` is HQ's Node build, type-checked by `tsc` against
  // `@types/node`, and Deno's checker must not be asked to re-check it through
  // `dist/main.d.ts`. The `--include ../dist` in the compile task is what makes
  // the specifier resolvable inside a compiled executable.
  const specifier = new URL("../dist/main.js", import.meta.url).href;
  const { main } = (await import(specifier)) as typeof import("./hq.d.ts");
  const setupSpecifier =
    new URL("../dist/agent-setup/service.js", import.meta.url).href;
  const { createAgentSetup } = await import(setupSpecifier);
  let dashboard;
  try {
    dashboard = {
      agentSetup: createAgentSetup({
        command: Deno.execPath(),
        prefixArgs: serverArgs(),
        registration: await commandRegistration(),
      }),
    };
  } catch { /* Development runtime has no installed executable to register. */ }
  const code = await main(
    ["dashboard", "--json", "--listen", "127.0.0.1:0"],
    undefined,
    undefined,
    {
      distribution: "desktop",
      siteCliLaunch: siteCliLaunch(),
      ...(dashboard ? { dashboard } : {}),
      mcpLaunch: await mcpLaunch({
        command: Deno.execPath(),
        args: [...serverArgs(), "--mcp"],
      }),
    },
  );
  Deno.exit(code);
}

/**
 * Stop when the window is gone, however it went.
 *
 * `Webview.run()` blocks the window process's only JavaScript thread, so a
 * signal delivered to the window while it is showing — a `kill`, a session
 * logout, a crash — can never reach a handler that would stop the server. The
 * server therefore watches the one thing the operating system closes for it
 * unconditionally: its stdin, a pipe the window holds and never writes. EOF
 * means the window is dead, and `stopServer` below ends this process the way
 * the `dashboard` command already ends.
 */
function watchParent(): void {
  void (async () => {
    const buffer = new Uint8Array(64);
    for (;;) {
      let read: number | null;
      try {
        read = await Deno.stdin.read(buffer);
      } catch {
        read = null;
      }
      if (read === null) break;
    }
    stopServer();
  })();
}

/**
 * Stop this process the way the `dashboard` command already stops.
 *
 * On POSIX that is `SIGTERM`, one of the two signals the command installs a
 * handler for, so the listener closes exactly as it closes on Ctrl-C. Windows
 * has no signal a process can usefully raise against itself, and Node delivers
 * no `SIGTERM` to a handler there whatever tries to send one; if `Deno.kill`
 * refuses it, exiting is the honest fallback. Either way the window is already
 * gone, so there is nobody left for a graceful close to be graceful towards,
 * and the operating system closes the loopback listener with the process.
 */
function stopServer(): void {
  try {
    Deno.kill(Deno.pid, "SIGTERM");
  } catch {
    Deno.exit(0);
  }
}

/** The window role: spawn the server, wait for its URL, show it, reap it. */
async function window(): Promise<number> {
  // A moved copy explicitly opened by the user becomes the selected app.
  // Registration conflicts must never prevent the dashboard from starting.
  try {
    await (await commandRegistration()).refresh();
  } catch (error) {
    console.error(`Command access needs repair: ${String(error)}`);
  }
  const server = new Deno.Command(Deno.execPath(), {
    args: [...serverArgs(), SERVE_FLAG],
    // Piped and never written to: the pipe is the server's lifeline. See
    // `watchParent`.
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  let url: string;
  try {
    url = await Promise.race([
      readDashboardUrl(server.stdout),
      timeout(STARTUP_TIMEOUT_MS),
    ]);
  } catch (error) {
    await stop(server);
    console.error(`novamira-hq-desktop: ${describe(error)}`);
    return 1;
  }

  // Loaded here and not at the top: `@webview/webview` opens the native
  // library the moment it is imported, and the server role has no window to
  // show and no FFI permission to show it with.
  try {
    prepareBundledWebview();
    const { SizeHint, Webview } = await import("@webview/webview");
    const view = new Webview(true);
    view.title = WINDOW_TITLE;
    view.size = { width: 1280, height: 860, hint: SizeHint.NONE };
    view.bind("novamiraOpenRelease", (target: unknown) => {
      openDesktopRelease(target);
      return true;
    });
    view.init(DESKTOP_RELEASE_SCRIPT);
    if (Deno.build.os === "darwin") {
      installMacMenus();
      view.bind("novamiraDownloadMcp", () => {
        openMcpDownload(url);
        return true;
      });
      view.init(MCP_DOWNLOAD_SCRIPT);
    }
    view.navigate(url);
    view.run();
  } catch (error) {
    console.error(`novamira-hq-desktop: ${describe(error)}`);
    return 1;
  } finally {
    await stop(server);
  }
  return 0;
}

/**
 * The server's lifetime is the window's. SIGTERM is one of the two signals the
 * `dashboard` command stops on; `main` then resolves and the child exits by
 * itself. A child that already exited throws on `kill`, and that is not news.
 */
async function stop(server: Deno.ChildProcess): Promise<void> {
  try {
    server.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  await server.status;
}

/**
 * How this executable re-launches itself. A compiled binary carries its own
 * permissions and takes no runtime flags; `deno run main.ts` has to repeat the
 * script path and the permissions it was granted.
 */
function serverArgs(): readonly string[] {
  const compiled = !Deno.execPath().endsWith("deno") &&
    !Deno.execPath().endsWith("deno.exe");
  if (compiled) return [];
  return [
    "run",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-run",
    "--allow-sys",
    Deno.mainModule,
  ];
}

/**
 * The first line on the child's stdout is the envelope; nothing else is printed
 * for the rest of the run. The reader is released afterwards so the pipe is
 * still drained (by nobody — the server writes nothing more) and the child is
 * never blocked on a full pipe.
 */
async function readDashboardUrl(
  stdout: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: true });
      }
      const newline = buffer.indexOf("\n");
      if (newline !== -1) return parseEnvelope(buffer.slice(0, newline));
      if (done) {
        throw new Error(
          buffer.trim().length > 0
            ? parseEnvelopeMessage(buffer)
            : "the dashboard server exited before printing its address",
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEnvelope(line: string): string {
  const envelope = JSON.parse(line) as DashboardEnvelope;
  if (envelope.ok && typeof envelope.data?.url === "string") {
    return envelope.data.url;
  }
  throw new Error(parseEnvelopeMessage(line));
}

function parseEnvelopeMessage(text: string): string {
  try {
    const envelope = JSON.parse(text.trim()) as DashboardEnvelope;
    const message = envelope.error?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not an envelope; fall through.
  }
  return "the dashboard server did not start";
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    Deno.unrefTimer(
      setTimeout(
        () =>
          reject(
            new Error(`the dashboard server did not start within ${ms} ms`),
          ),
        ms,
      ),
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

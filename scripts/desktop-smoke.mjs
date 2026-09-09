// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Prove a compiled desktop executable still serves the dashboard.
//
//   node scripts/desktop-smoke.mjs dist-desktop/novamira-hq-desktop-linux-x86_64
//
// The server role only: headless, loopback, no window, no WebKit, no registry
// read. The window role needs a display and the native webview library, neither
// of which a release runner has, and neither of which is what a re-signed or
// re-packaged executable puts at risk — the embedded `dist/` is.
//
// Node rather than three copies of shell, for one reason that is not taste:
// the server watches its stdin and stops when it reaches EOF, so a smoke test
// that backgrounds it from a shell hands it `/dev/null`, and it stops before
// the first request. The pipe has to be held open by whatever is watching, and
// the same script then runs on the Windows runner unchanged.
//
// Closing that pipe at the end is half the test: it is exactly how the window's
// death reaches the server, and a server that does not exit from it is one that
// would outlive its window.

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv, env, exit, platform, stderr, stdout } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

const STARTUP_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;
/** Two assets: one from the packaged static tree, one rendered page. */
const PATHS = ["/assets/app.css", "/"];

/** Defaults to what `scripts/desktop-build.mjs` just wrote. */
const executable =
  argv[2] ??
  fileURLToPath(
    new URL(
      `../dist-desktop/novamira-hq-desktop${platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );

const home = await mkdtemp(join(tmpdir(), "novamira-hq-smoke-"));
let child;
let mcpChild;
try {
  child = spawn(resolve(executable), ["--serve"], {
    // Piped and never written to, exactly as the window holds it.
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...env,
      NOVAMIRA_HQ_HOME: home,
      // A smoke test must not reach the npm registry, and the dashboard command
      // already suppresses the check; this says so twice.
      NOVAMIRA_HQ_UPDATE_CHECK: "0",
    },
  });

  const url = await withTimeout(
    firstLine(child.stdout).then(envelopeUrl),
    STARTUP_TIMEOUT_MS,
    "the dashboard server did not print its address",
  );
  stdout.write(`desktop-smoke: serving at ${url}\n`);

  for (const path of PATHS) {
    const status = await withTimeout(
      request(new URL(path, url)),
      STARTUP_TIMEOUT_MS,
      `GET ${path} did not answer`,
    );
    if (status !== 200) throw new Error(`GET ${path} answered ${status}`);
    stdout.write(`desktop-smoke: GET ${path} -> ${status}\n`);
  }

  child.stdin.end();
  const code = await withTimeout(
    exited(child),
    SHUTDOWN_TIMEOUT_MS,
    "the dashboard server did not stop when its stdin closed",
  );
  stdout.write(`desktop-smoke: stopped with ${describeExit(code)}\n`);
  mcpChild = spawn(resolve(executable), ["--mcp"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...env, NOVAMIRA_HQ_HOME: home, NOVAMIRA_HQ_UPDATE_CHECK: "0" },
  });
  const mcpCheck = verifyMcp(mcpChild);
  mcpChild.stdin.end(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "desktop-smoke", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  const tools = await withTimeout(
    mcpCheck,
    STARTUP_TIMEOUT_MS,
    "the headless MCP role did not initialize",
  );
  stdout.write(`desktop-smoke: headless MCP initialized with ${tools} tools\n`);
} catch (error) {
  child?.kill("SIGKILL");
  mcpChild?.kill("SIGKILL");
  stderr.write(`desktop-smoke: ${error.message}\n`);
  exit(1);
} finally {
  await rm(home, { recursive: true, force: true });
}

stdout.write("desktop-smoke: ok\n");

/** Only initialize and tools/list; no provider tool is called. */
function verifyMcp(process_) {
  return new Promise((resolve_, reject) => {
    let buffer = "";
    process_.on("error", reject);
    process_.stdin.on("error", reject);
    process_.stdout.setEncoding("utf8");
    process_.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 262144) {
        process_.kill("SIGKILL");
        reject(new Error("MCP output exceeded the smoke-test limit"));
      }
    });
    process_.on("close", (code) => {
      try {
        if (code !== 0) throw new Error("The MCP role exited unsuccessfully");
        const replies = buffer
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const initialized = replies.find((reply) => reply.id === 1)?.result;
        const listed = replies.find((reply) => reply.id === 2)?.result;
        if (
          !initialized?.serverInfo ||
          !Array.isArray(listed?.tools) ||
          listed.tools.length === 0
        )
          throw new Error(
            "The MCP role did not complete initialization and tool listing",
          );
        resolve_(listed.tools.length);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Loopback only, and the body is drained so the connection closes. */
function request(url) {
  return new Promise((resolve_, reject) => {
    get(url, (response) => {
      response.resume();
      response.on("end", () => resolve_(response.statusCode));
      response.on("error", reject);
    }).on("error", reject);
  });
}

/** The envelope is the first line, and nothing else is printed after it. */
function firstLine(stream) {
  return new Promise((resolve_, reject) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) resolve_(buffer.slice(0, newline));
    });
    stream.on("end", () => {
      reject(
        new Error(
          buffer.trim().length > 0
            ? `the server exited printing ${buffer.trim()}`
            : "the server exited before printing its address",
        ),
      );
    });
    stream.on("error", reject);
  });
}

function envelopeUrl(line) {
  const envelope = JSON.parse(line);
  if (envelope.ok !== true || typeof envelope.data?.url !== "string") {
    throw new Error(`the server answered ${line}`);
  }
  return envelope.data.url;
}

function exited(process_) {
  return new Promise((resolve_) => {
    process_.on("exit", (code, signal) => resolve_(code ?? signal));
  });
}

function describeExit(code) {
  return typeof code === "number" ? `exit code ${code}` : `signal ${code}`;
}

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${message} within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Test-only compiled executable, never included in release archives. Exercises
// the production integration seam under the same embedded runtime as desktop.
import process from "node:process";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const mode = Deno.args[0];
if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(4096));
  setInterval(() => {}, 1000);
} else if (mode === "input") {
  process.stdin.pipe(process.stdout);
} else if (mode === "descendant") {
  const child = spawn(Deno.execPath(), ["stubborn", Deno.args[1]], {
    stdio: "ignore",
    shell: false,
  });
  child.unref();
  setInterval(() => {}, 1000);
} else if (mode === "stubborn") {
  if (Deno.build.os !== "windows") {
    process.on("SIGTERM", () => {});
  }
  await Deno.writeTextFile(Deno.args[1], String(Deno.pid));
  setInterval(() => {}, 1000);
} else {
  const specifier =
    new URL("../dist/integration/spawn.js", import.meta.url).href;
  const { nodeSpawnChild } = await import(specifier);
  const invoke = (args: string[], extra: Record<string, unknown> = {}) =>
    nodeSpawnChild({
      command: Deno.execPath(),
      args,
      env: process.env,
      timeoutMs: 3000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      signal: new AbortController().signal,
      ...extra,
    });
  const expect = (value: boolean, description: string) => {
    if (!value) throw new Error(description);
  };
  const input = await invoke(["input"], { input: "bounded input" });
  expect(
    input.kind === "exited" && input.stdout === "bounded input",
    "stdin round trip",
  );
  const timeout = await invoke(["wait"], { timeoutMs: 100 });
  expect(
    timeout.kind === "timed_out" && timeout.code === null,
    "timeout classification",
  );
  const flood = await invoke(["flood"]);
  expect(
    flood.kind === "truncated" && flood.stdout.length <= 1024,
    "bounded capture",
  );
  const already = AbortSignal.abort();
  expect(
    (await invoke(["wait"], { signal: already })).kind === "aborted",
    "pre-aborted child",
  );
  const temporary = await Deno.makeTempDir();
  try {
    const pidFile = `${temporary}/pid`;
    const controller = new AbortController();
    const outcome = invoke(["descendant", pidFile], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    let pid = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        pid = Number(await Deno.readTextFile(pidFile));
      } catch { /* not ready */ }
      if (pid > 0) break;
      await delay(25);
    }
    expect(pid > 0, "descendant started");
    controller.abort();
    expect((await outcome).kind === "aborted", "cancellation classification");
    await delay(2500);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    // A reparented zombie has already stopped executing; its host init owns reaping.
    if (alive && Deno.build.os === "linux") {
      const status = await Deno.readTextFile(`/proc/${pid}/stat`);
      alive = !status.slice(status.lastIndexOf(")") + 2).startsWith("Z ");
    }
    if (alive) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    expect(!alive, "descendant survived cancellation");
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
  console.log(
    "embedded spawn: input, timeout, bounds, cancellation, and descendant cleanup passed",
  );
}

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { createCommandRegistration } from "../dist/agent-setup/command-registration.js";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "hq-command-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const executable = join(home, "App ' & space");
  await writeFile(executable, "native app", { mode: 0o700 });
  const options = {
    executable,
    stateDir: join(home, "state"),
    platform: "linux",
    path: "",
  };
  return {
    home,
    executable,
    options,
    service: createCommandRegistration(options),
  };
}

test("registration is explicit, repeatable, survives updates, and removes owned artifacts", async (t) => {
  const { executable, service } = await fixture(t);
  assert.equal((await service.refresh()).state, "disabled");
  assert.equal((await service.enable()).state, "enabled");
  assert.equal((await service.enable()).onPath, false);
  assert.equal(await service.resolve(), executable);
  await writeFile(executable, "updated native app");
  assert.equal(await service.resolve(), executable);
  assert.equal((await service.repair()).state, "enabled");
  assert.equal((await service.remove()).state, "disabled");
  assert.equal((await service.remove()).state, "disabled");
});

test("standalone launcher source is installed and refreshed while the app remains the target", async (t) => {
  const { options, executable, home } = await fixture(t);
  const launcherSource = join(home, "standalone-launcher");
  await writeFile(launcherSource, "standalone signature", { mode: 0o700 });
  const service = createCommandRegistration({ ...options, launcherSource });
  await service.enable();
  assert.equal(
    await readFile(service.launcher, "utf8"),
    "standalone signature",
  );
  assert.equal(await service.resolve(), executable);
  await writeFile(launcherSource, "updated standalone signature");
  await service.refresh();
  assert.equal(
    await readFile(service.launcher, "utf8"),
    "updated standalone signature",
  );
  await rm(launcherSource);
  await assert.rejects(service.repair(), /ENOENT/);
  assert.equal(
    await readFile(service.launcher, "utf8"),
    "updated standalone signature",
  );
});

test("missing app fails closed; opening moved or explicitly selected copy refreshes target", async (t) => {
  const { executable, options, service, home } = await fixture(t);
  await service.enable();
  const moved = join(home, "Moved ! app");
  await rename(executable, moved);
  assert.equal((await service.status()).state, "missing-app");
  await assert.rejects(service.resolve(), /missing/);
  await createCommandRegistration({ ...options, executable: moved }).refresh();
  assert.equal(await service.resolve(), moved);
  await writeFile(executable, "second copy", { mode: 0o700 });
  assert.equal(await service.resolve(), moved);
  await service.repair();
  assert.equal(await service.resolve(), executable);
});

test("foreign commands and user-modified owned commands are preserved", async (t) => {
  const { service } = await fixture(t);
  await mkdir(join(service.launcher, ".."), { recursive: true });
  await writeFile(service.launcher, "user command");
  await assert.rejects(service.enable(), /conflict/);
  await assert.rejects(service.remove(), /conflict/);
  assert.equal(await readFile(service.launcher, "utf8"), "user command");
  await rm(service.launcher);
  await service.enable();
  await writeFile(service.launcher, "edited command");
  assert.equal((await service.status()).state, "conflict");
  await assert.rejects(service.repair(), /conflict/);
  await assert.rejects(service.remove(), /conflict/);
});

test(
  "symlink conflicts and malformed records are never adopted",
  { skip: process.platform === "win32" },
  async (t) => {
    const { service, executable } = await fixture(t);
    await mkdir(join(service.launcher, ".."), { recursive: true });
    await symlink(executable, service.launcher);
    await assert.rejects(service.enable(), /conflict/);
    await rm(service.launcher);
    await service.enable();
    await writeFile(join(service.launcher, "..", "registration.json"), "{}");
    await assert.rejects(service.remove(), /Invalid/);
    assert.equal(await readFile(service.launcher, "utf8"), "native app");
  },
);

test("repair restores a missing launcher; PATH conflicts are reported without edits", async (t) => {
  const { service, options, home } = await fixture(t);
  await service.enable();
  await rm(service.launcher);
  assert.equal((await service.status()).state, "disabled");
  assert.equal((await service.repair()).state, "enabled");
  const foreign = join(home, "user-bin");
  await mkdir(foreign);
  await writeFile(join(foreign, "novamira-hq"), "user command");
  const status = await createCommandRegistration({
    ...options,
    path: [foreign, dirname(service.launcher)].join(delimiter),
  }).status();
  assert.equal(status.onPath, true);
  assert.equal(status.shadowed, true);
  assert.equal(
    await readFile(join(foreign, "novamira-hq"), "utf8"),
    "user command",
  );
});

test("concurrent registration calls serialize ownership writes", async (t) => {
  const { service, options } = await fixture(t);
  const results = await Promise.all([
    service.enable(),
    createCommandRegistration(options).enable(),
  ]);
  assert.deepEqual(
    results.map((value) => value.state),
    ["enabled", "enabled"],
  );
});

test(
  "macOS discovery rejects unrelated bundles and refuses ambiguous copies",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { home } = await fixture(t);
    async function app(name, id = "ai.novamira.hq.desktop") {
      const contents = join(home, name, "Contents");
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await writeFile(
        join(contents, "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`,
      );
      const executable = join(contents, "MacOS", "novamira-hq-desktop");
      await writeFile(executable, "native app", { mode: 0o700 });
      return executable;
    }
    const original = await app("Original.app");
    const discovered = [];
    const service = createCommandRegistration({
      executable: original,
      stateDir: join(home, "state"),
      home,
      platform: "darwin",
      discover: async () => discovered,
    });
    await service.enable();
    const moved = await app("Moved.app");
    discovered.push(moved, await app("Unrelated.app", "other.app"));
    assert.equal(await service.resolve(), original);
    await rm(original);
    assert.equal(await service.resolve(), await realpath(moved));
    discovered.push(await app("Second.app"));
    await assert.rejects(service.resolve(), /Multiple/);
  },
);

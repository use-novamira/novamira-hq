// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { siteCliEnvironment } from "../dist/integration/environment.js";
import { createSiteCliResolver } from "../dist/integration/resolve.js";
import { envelopeReason } from "../dist/integration/classify.js";

test("HQ's HTTP opt-in reaches site CLI children without changing the parent", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const environment = { NOVAMIRA_HQ_ALLOW_INSECURE_HTTP: "1" };
    const child = siteCliEnvironment(environment, platform);
    assert.equal(child.NOVAMIRA_ALLOW_INSECURE_HTTP, "1");
    assert.deepEqual(environment, { NOVAMIRA_HQ_ALLOW_INSECURE_HTTP: "1" });
    for (const value of [undefined, "0", "true", ""]) {
      assert.equal(
        siteCliEnvironment({ NOVAMIRA_HQ_ALLOW_INSECURE_HTTP: value }, platform)
          .NOVAMIRA_ALLOW_INSECURE_HTTP,
        undefined,
      );
    }
    assert.equal(
      siteCliEnvironment({ NOVAMIRA_ALLOW_INSECURE_HTTP: "1" }, platform)
        .NOVAMIRA_ALLOW_INSECURE_HTTP,
      "1",
    );
  }
});

test("Finder PATH supports explicit script overrides without global CLI discovery", async () => {
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const resolve = createSiteCliResolver({
    environment,
    platform: "darwin",
    isFile: async (path) => path === "/usr/local/bin/novamira",
  });
  assert.equal(await resolve(), undefined);
  const child = siteCliEnvironment(environment, "darwin");
  assert.ok(child.PATH.split(":").includes("/usr/local/bin"));
  assert.ok(child.PATH.split(":").includes("/opt/homebrew/bin"));
  assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.deepEqual(siteCliEnvironment(child, "darwin"), child);
});

test("system CA support preserves overrides and never disables certificate validation", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const env = {
      PATH: "existing-path",
      NODE_OPTIONS: "--max-old-space-size=512",
    };
    const child = siteCliEnvironment(env, platform);
    assert.equal(child.NODE_USE_SYSTEM_CA, "1");
    assert.equal(child.NODE_OPTIONS, env.NODE_OPTIONS);
    assert.equal(child.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    if (platform !== "darwin") assert.equal(child.PATH, env.PATH);
    assert.equal(
      siteCliEnvironment({ NODE_USE_SYSTEM_CA: "0" }, platform)
        .NODE_USE_SYSTEM_CA,
      "0",
    );
  }
  assert.equal(envelopeReason("network_error"), "site_unreachable");
});

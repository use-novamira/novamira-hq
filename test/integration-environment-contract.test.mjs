// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { siteCliEnvironment } from "../dist/integration/environment.js";
import { createSiteCliResolver } from "../dist/integration/resolve.js";
import { envelopeReason } from "../dist/integration/classify.js";

test("Finder PATH resolves the CLI and supplies the same directories for env node", async () => {
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const resolve = createSiteCliResolver({
    environment,
    platform: "darwin",
    isFile: async (path) => path === "/usr/local/bin/novamira",
  });
  assert.deepEqual(await resolve(), {
    command: "/usr/local/bin/novamira",
    prefixArgs: [],
  });
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

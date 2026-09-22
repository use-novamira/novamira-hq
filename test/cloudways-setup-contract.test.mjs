// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  setupCloudwaysNovamira,
  cloudwaysPlugins,
} from "../dist/hosting/providers/cloudways-setup.js";
import { provisionNovamira } from "../dist/provisioning/index.js";
import { inspectExistingNovamira } from "../dist/provisioning/existing.js";

function fixture(options = {}) {
  const calls = [];
  let installed = options.installed ?? false;
  let active = options.active ?? false;
  const plugin = () => ({
    success: true,
    data: installed
      ? [
          {
            slug: "novamira",
            version: options.version ?? "1.12.4",
            status: active ? "active" : "inactive",
          },
        ]
      : [],
  });
  const http = {
    async json(request) {
      request.signal?.throwIfAborted();
      calls.push(request);
      if (request.method === "POST") {
        assert.equal(request.body.kind, "form");
        assert.equal(request.body.value.server_id, "123");
        assert.equal(request.body.value.app_id, "456");
        assert.equal(request.query, undefined);
        if (options.reject) return { success: false };
        if (request.path === "/plugins/upload") installed = true;
        else if (request.path === "/plugins/activate") active = true;
        else assert.fail(request.path);
        return { success: true, operation_id: "fake-operation" };
      }
      switch (request.path) {
        case "/server":
          return {
            servers: [
              {
                id: 123,
                apps: [
                  {
                    id: options.appId ?? 456,
                    cname: options.domain ?? "example.test",
                  },
                ],
              },
            ],
          };
        case "/server/manage/settings":
          return {
            settings: { package_versions: { php: options.php ?? "8.3" } },
          };
        case "/wpsite/coreinfo/123/456":
          return { success: true, data: { core_version: options.wp ?? "6.9" } };
        case "/plugins/123/456":
          return options.inventory ?? plugin();
        default:
          assert.fail(request.path);
      }
    },
    async poll(request, polling) {
      if (options.timeout)
        throw Object.assign(new Error("unconfirmed"), { code: "timeout" });
      // Acceptance alone is not completion: an empty inventory cannot finish a poll.
      assert.equal(
        polling.isComplete({ data: { success: true, data: [] } }),
        false,
      );
      const data = await this.json(request);
      assert.equal(polling.isComplete({ data }), true);
      return { data };
    },
  };
  return { http, calls };
}

test("Cloudways uploads the official ZIP, verifies inventory, activates and verifies again", async () => {
  const { http, calls } = fixture();
  const result = await setupCloudwaysNovamira(http, "123:456");
  assert.equal(result.raw.siteUrl, "https://example.test");
  assert.equal(result.raw.aiEnabled, null);
  const writes = calls.filter((call) => call.method === "POST");
  assert.deepEqual(
    writes.map((call) => call.path),
    ["/plugins/upload", "/plugins/activate"],
  );
  assert.equal(
    writes[0].body.value.plugin_file_url,
    "https://license.dynamic.ooo/api/novamira/download",
  );
  assert.equal(writes[0].body.value.override_lock, undefined);
  assert.equal(writes[1].body.value.filename, "novamira/novamira.php");
  assert.equal(calls.at(-1).path, "/plugins/123/456");
});

for (const active of [true, false])
  test(`Cloudways preserves existing plugin, active=${active}`, async () => {
    const { http, calls } = fixture({ installed: true, active });
    await setupCloudwaysNovamira(http, "123:456");
    assert.deepEqual(
      calls.filter((call) => call.method === "POST").map((call) => call.path),
      active ? [] : ["/plugins/activate"],
    );
  });

for (const options of [
  { php: "7.4" },
  { php: "unknown" },
  { wp: "6.8" },
  { wp: "unknown" },
  { appId: 789 },
  { domain: "https://example.test/subdirectory" },
  { installed: true, version: "1.0.0" },
  { installed: true, version: "unknown" },
  { inventory: { success: false, data: [] } },
  { inventory: {} },
])
  test(`Cloudways fails closed before mutation: ${JSON.stringify(options)}`, async () => {
    const { http, calls } = fixture(options);
    await assert.rejects(setupCloudwaysNovamira(http, "123:456"));
    assert.equal(
      calls.some((call) => call.method === "POST"),
      false,
    );
  });

test("Cloudways rejects invalid IDs and cancellation without requests", async () => {
  const { http, calls } = fixture();
  for (const id of ["123", "123:456/other", "123:0", "../:456"])
    await assert.rejects(setupCloudwaysNovamira(http, id), {
      code: "usage_error",
    });
  await assert.rejects(
    setupCloudwaysNovamira(http, "123:456", AbortSignal.abort()),
  );
  assert.equal(calls.length, 0);
});

for (const options of [{ reject: true }, { timeout: true }])
  test(`Cloudways never repeats an uncertain write: ${JSON.stringify(options)}`, async () => {
    const { http, calls } = fixture(options);
    await assert.rejects(setupCloudwaysNovamira(http, "123:456"));
    assert.deepEqual(
      calls.filter((call) => call.method === "POST").map((call) => call.path),
      ["/plugins/upload"],
    );
  });

test("Cloudways existing-plugin inspection uses inventory, never WP-CLI", async () => {
  const existing = await inspectExistingNovamira(
    {
      provider: "cloudways",
      read: async (request) => {
        assert.equal(request.kind, "plugins");
        return cloudwaysPlugins({
          success: true,
          data: [{ slug: "novamira", version: "1.12.4", status: "active" }],
        });
      },
    },
    "123:456",
    {},
  );
  assert.equal(existing.active, true);
  assert.equal(existing.aiEnabled, false);
});

test("Cloudways setup never claims AI enabled without metadata; explains manual step", async () => {
  const dependencies = {
    hostingProfile: "test",
    environment: {},
    client: {
      provider: "cloudways",
      action: async () => ({
        status: 200,
        raw: {
          siteUrl: "https://example.test",
          version: "1.12.4",
          aiEnabled: null,
          warnings: [],
        },
      }),
    },
    fetch: async () => {
      throw new Error("offline");
    },
  };
  const result = await provisionNovamira(dependencies, {
    envId: "123:456",
    compatCheck: false,
  });
  assert.equal(result.ready, null);
  assert.equal(result.aiAbilities.enabled, false);
  await assert.rejects(
    provisionNovamira(dependencies, { envId: "123:456" }),
    (error) => {
      assert.equal(error.code, "server_unsupported");
      assert.match(error.message, /enable AI Abilities/);
      return true;
    },
  );
});

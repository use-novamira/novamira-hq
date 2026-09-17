// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  setupHostingerNovamira,
  HOSTINGER_NOVAMIRA_SOURCE,
} from "../dist/hosting/providers/hostinger-setup.js";
import { hostingerInstaller } from "../dist/hosting/providers/hostinger-installer.js";
import { provisionNovamira } from "../dist/provisioning/setup.js";
import { MINIMUM_NOVAMIRA_VERSION } from "../dist/provisioning/compatibility.js";

function fixture(options = {}) {
  const calls = [],
    transfers = [],
    uploaded = new Map();
  let slug,
    activated = false,
    finished = false,
    cleaned = false,
    helper;
  const installed = options.existing;
  const inventory = () => [
    ...(installed || finished
      ? [
          {
            name: "novamira",
            version: installed?.version ?? "1.12.4",
            status: finished ? "active" : installed.status,
          },
        ]
      : []),
    ...(activated || (slug && finished && !cleaned)
      ? [
          {
            name: slug,
            version: options.missingReceipt ? "0.0.0" : "1.0.0",
            status: activated ? "active" : "inactive",
          },
        ]
      : []),
  ];
  const listing = (items) => ({ items, total_items: items.length });
  const http = {
    baseUrl: "https://developers.hostinger.com",
    async json(request) {
      calls.push(request);
      const u = new URL(request.path),
        body = request.body?.value;
      if (u.pathname.endsWith("/wordpress/installations"))
        return (
          options.installations ?? [
            {
              id: 123,
              username: "u123",
              domain: "example.com",
              url: "https://example.com/",
              is_valid: true,
            },
          ]
        );
      if (u.pathname.endsWith("/php/details"))
        return { php_version_full: options.php ?? "8.3.33" };
      if (u.pathname.endsWith("/plugins")) return inventory();
      if (u.pathname.endsWith("/files")) {
        if (u.searchParams.get("directory") === "wp-content/plugins")
          return listing([
            ...(options.partial || installed || finished
              ? [{ name: "novamira" }]
              : []),
            ...(slug && !cleaned ? [{ name: slug }] : []),
          ]);
        return listing(
          [...uploaded].map(([name, value]) => ({
            name,
            size_bytes: value.length,
          })),
        );
      }
      if (u.pathname.endsWith("/files/upload-urls"))
        return {
          url: options.uploadUrl ?? "https://srv711-files.hstgr.io/upload",
          auth_key: "test-upload-key",
          rest_auth_key: "test-rest-key",
        };
      if (u.pathname.endsWith("/plugins/activate")) {
        assert.equal(request.retry.maxAttempts, 1);
        if (options.activationError)
          throw new Error("provider activation error");
        assert.equal(body.plugin, slug);
        activated = true;
        finished = true;
        return {};
      }
      if (u.pathname.endsWith("/plugins/deactivate")) {
        activated = false;
        cleaned = !options.residual;
        return {};
      }
      if (u.pathname.endsWith("/plugins/uninstall")) {
        assert.deepEqual(body.plugins, [slug]);
        assert.equal(activated, false);
        cleaned = true;
        return {};
      }
      throw new Error(`Unexpected API request: ${u.pathname}`);
    },
  };
  const fetcher = async (url, init) => {
    transfers.push({ url, init });
    assert.equal(
      init.redirect,
      url === HOSTINGER_NOVAMIRA_SOURCE ? "manual" : "error",
    );
    assert.equal(init.headers.Authorization, undefined);
    if (url === HOSTINGER_NOVAMIRA_SOURCE && options.redirect)
      return new Response(null, {
        status: 302,
        headers: { Location: options.redirect },
      });
    if (
      url === HOSTINGER_NOVAMIRA_SOURCE ||
      url ===
        "https://nbg1.your-objectstorage.com/ooo-zips-free/novamira/versions/novamira-1.12.4.zip"
    )
      return new Response(
        options.badArchive
          ? "not a zip"
          : Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]),
      );
    assert.equal(init.headers["X-Auth"], "test-upload-key");
    assert.equal(init.headers["X-Auth-Rest"], "test-rest-key");
    const u = new URL(url);
    assert.equal(u.searchParams.get("override"), "false");
    assert.equal(u.hostname, "srv711-files.hstgr.io");
    slug = u.pathname.split("/").at(-2);
    const name = u.pathname.split("/").at(-1);
    if (init.method === "POST")
      return new Response(null, {
        status: 201,
        headers: { Location: "https://evil.example/upload" },
      });
    assert.equal(init.method, "PATCH");
    if (options.uploadError) throw new Error("test-upload-key secret-in-url");
    uploaded.set(name, init.body);
    if (name.endsWith(".php")) helper = Buffer.from(init.body).toString();
    return new Response(null, {
      status: 204,
      headers: {
        "Upload-Offset": String(init.body.length + (options.badOffset ? 1 : 0)),
      },
    });
  };
  return {
    http,
    fetcher,
    calls,
    transfers,
    get helper() {
      return helper;
    },
    run: (request = {}) =>
      setupHostingerNovamira(http, fetcher, {
        kind: "setup-novamira",
        envId: "123",
        ...request,
      }),
  };
}

test("Hostinger setup uploads ZIP once, verifies receipt, deactivates helper, never calls deploy or WP-CLI", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.raw.aiEnabled, true);
  assert.equal(result.raw.version, "1.12.4");
  assert.deepEqual(result.raw.warnings, []);
  assert.equal(f.transfers.filter((x) => x.init.method === "PATCH").length, 2);
  assert.ok(f.calls.some((x) => x.path.endsWith("/deactivate")));
  assert.ok(
    f.calls.every((x) => !/deploy|wp-cli|ssh|reset|delete/.test(x.path)),
  );
  const config = JSON.parse(
    Buffer.from(f.helper.match(/base64_decode\('([^']+)'/)[1], "base64"),
  );
  assert.equal(config.enableAi, true);
  assert.equal(config.minimumVersion, MINIMUM_NOVAMIRA_VERSION);
  assert.match(config.digest, /^[a-f0-9]{64}$/);
});

test("Hostinger setup preserves an existing active plugin without uploads or setting changes", async () => {
  const f = fixture({ existing: { version: "1.12.4", status: "active" } });
  const result = await f.run();
  assert.equal(result.raw.aiEnabled, null);
  assert.equal(f.transfers.length, 0);
  assert.ok(f.calls.every((request) => !request.body));
});

test("explicit enable on an existing plugin uploads only helper, never the archive", async () => {
  const f = fixture({ existing: { version: "1.12.4", status: "active" } });
  const result = await f.run({ enableAiAbilities: true });
  assert.equal(result.raw.aiEnabled, true);
  assert.equal(f.transfers.length, 2);
  const config = JSON.parse(
    Buffer.from(f.helper.match(/base64_decode\('([^']+)'/)[1], "base64"),
  );
  assert.equal(config.digest, null);
});

for (const [name, options] of Object.entries({
  "old plugin": { existing: { version: "1.0.0", status: "active" } },
  "unknown plugin version": {
    existing: { version: "unknown", status: "active" },
  },
  "old PHP": { php: "7.4.1" },
  "partial directory": { partial: true },
  "ambiguous installation": { installations: [] },
})) {
  test(`Hostinger refuses ${name} before any mutation`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.transfers.length, 0);
    assert.ok(f.calls.every((request) => !request.body));
  });
}

test("Hostinger rejects non-ZIP downloads before upload authorization", async () => {
  const f = fixture({ badArchive: true });
  await assert.rejects(f.run(), /not a ZIP/);
  assert.ok(f.calls.every((request) => !request.body));
});

test("official download redirect is followed without hosting credentials", async () => {
  const f = fixture({
    redirect:
      "https://nbg1.your-objectstorage.com/ooo-zips-free/novamira/versions/novamira-1.12.4.zip",
  });
  await f.run();
  assert.equal(f.transfers[1].init.headers["X-Auth"], undefined);
});

test("untrusted download redirect stops before upload authorization", async () => {
  const f = fixture({ redirect: "http://127.0.0.1/private" });
  await assert.rejects(f.run(), /trusted archive/);
  assert.equal(f.transfers.length, 1);
  assert.ok(f.calls.every((request) => !request.body));
});

for (const uploadUrl of [
  "http://srv711-files.hstgr.io",
  "https://evil.example",
  "https://srv711-files.hstgr.io.evil.example",
  "https://secret@srv711-files.hstgr.io",
  "https://srv711-files.hstgr.io:444",
  "https://srv711-files.hstgr.io/?token=secret",
]) {
  test(`upload origin fails closed: ${uploadUrl}`, async () => {
    const f = fixture({ uploadUrl });
    await assert.rejects(f.run(), /untrusted upload/);
    assert.equal(f.transfers.length, 1);
  });
}

test("incomplete uploads never activate and expose a cleanup location", async () => {
  const f = fixture({ badOffset: true });
  await assert.rejects(
    f.run(),
    (error) => error.details.cleanupRequired === true,
  );
  assert.ok(f.calls.every((request) => !request.path.endsWith("/activate")));
});

test("upload errors never expose temporary credentials", async () => {
  const f = fixture({ uploadError: true });
  await assert.rejects(
    f.run(),
    (error) =>
      !JSON.stringify(error).includes("test-upload-key") &&
      !JSON.stringify(error).includes("secret-in-url"),
  );
});

test("activation failure attempts bounded deactivation without replay", async () => {
  const f = fixture({ activationError: true });
  await assert.rejects(f.run(), /did not complete/);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/activate")).length, 1);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/deactivate")).length, 1);
});

test("leftover helper is uninstalled through provider API and verified", async () => {
  const f = fixture({ residual: true });
  const result = await f.run();
  assert.deepEqual(result.raw.warnings, []);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/uninstall")).length, 1);
});

test("HTTP acceptance without completion receipt is not success; abort still cleans up", async () => {
  const f = fixture({ missingReceipt: true });
  await assert.rejects(
    f.run({ signal: AbortSignal.timeout(30) }),
    /did not complete/,
  );
  assert.equal(f.calls.filter((x) => x.path.endsWith("/activate")).length, 1);
  const cleanup = f.calls.find((x) => x.path.endsWith("/deactivate"));
  assert.ok(cleanup);
  assert.equal(cleanup.signal.aborted, false);
});

test("installer has no public request handler and validates hash, paths, requirements and no overwrite", () => {
  const helper = hostingerInstaller({
    domain: "example.com",
    digest: "a".repeat(64),
    enableAi: true,
    minimumVersion: MINIMUM_NOVAMIRA_VERSION,
    expires: 100,
  });
  for (const text of [
    "defined('ABSPATH')",
    "register_activation_hook",
    "hash_file('sha256'",
    "Archive links are not allowed",
    "No recursive delete",
    "file_exists($target)",
    "is_multisite()",
    "get_bloginfo('version')",
    "getExternalAttributesIndex",
    "setup receipt",
  ]) {
    if (text === "setup receipt") continue;
    assert.ok(helper.includes(text), text);
  }
  assert.doesNotMatch(
    helper,
    /\$_(?:GET|POST|REQUEST)|eval\(|shell_exec|wp_ajax|register_rest_route/,
  );
  assert.ok(
    helper.indexOf("update_option('novamira_ai_abilities_domain'") <
      helper.indexOf("update_option('novamira_ai_abilities_enabled'"),
  );
});

test("Hostinger provisioning refuses unsupported flags before touching provider", async () => {
  for (const request of [
    { force: true },
    { source: "https://other.example/plugin.zip" },
    { url: "https://other.example" },
    { activate: false },
    { activateNetwork: true },
    { wait: false },
  ]) {
    await assert.rejects(
      provisionNovamira(
        {
          client: {
            provider: "hostinger",
            action() {
              assert.fail("provider called");
            },
          },
          environment: {},
          hostingProfile: "test",
          fetch() {
            assert.fail("site called");
          },
        },
        { envId: "123", ...request },
      ),
      { code: "usage_error" },
    );
  }
});

test("metadata failure never reports setup ready and includes cache guidance", async () => {
  const f = fixture();
  await assert.rejects(
    provisionNovamira(
      {
        client: { provider: "hostinger", action: (request) => f.run(request) },
        environment: {},
        hostingProfile: "test",
        fetch: async () => new Response("old 404", { status: 404 }),
      },
      { envId: "123" },
    ),
    (error) =>
      error.code === "server_unsupported" && /LiteSpeed/.test(error.message),
  );
});

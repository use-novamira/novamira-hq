// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProService } from "../dist/pro/service.js";
import { PRO_PREFLIGHT } from "../dist/pro/php.js";
import { platformPaths, proLicenseMetadataPath } from "../dist/config/paths.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { renderPro, renderProPage } from "../dist/web/views/pro.js";
import { renderHtml } from "../dist/web/html.js";
import { renderSettingsPage } from "../dist/web/views/settings.js";

const KEY = "test-license-secret-1234";
test("Pro separates app settings from site installation", () => {
  const fullSettings = renderHtml(
    renderSettingsPage({ configFile: "/example/config.json" }, "general", {
      last4: "1234",
    }),
  );
  assert.ok(fullSettings.includes("Configuration file"));
  assert.ok(!fullSettings.includes("Novamira Pro plugin license"));
  const proTab = renderHtml(
    renderSettingsPage({ configFile: "/example/config.json" }, "pro", {
      last4: "1234",
    }),
  );
  assert.ok(proTab.includes("Novamira Pro plugin license"));
  assert.ok(!proTab.includes("Configuration file"));
  const settings = renderHtml(renderPro({ last4: "1234" }));
  assert.match(settings, /Novamira HQ does not require a license/);
  assert.match(settings, /class="panel-head"/);
  assert.match(settings, /class="ui-secret-editor"/);
  assert.match(settings, /placeholder="••••••••1234"/);
  assert.ok(!settings.includes("Saved license:"));
  assert.ok(!settings.includes('value="••••••••1234"'));
  assert.ok(!settings.includes("Review installation"));
  const page = renderHtml(renderProPage({ site: "example", last4: "1234" }));
  assert.match(page, /Check site/);
  assert.doesNotMatch(page, /Do not close|Check the site before reviewing/);
  assert.match(page, /Back to Sites/);
  assert.ok(!page.includes('href="/settings'));
  const completed = renderHtml(
    renderProPage({
      site: "example",
      last4: "1234",
      message: "Pro is installed.",
    }),
  );
  assert.match(completed, /Installation complete/);
  assert.ok(!completed.includes("Review installation"));
});
async function fixture(t, code = "s100") {
  const root = await mkdtemp(join(tmpdir(), "hq-pro-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  let saved;
  let now = 1000;
  const requests = [];
  const commands = [];
  const state = {
    url: "https://example.com",
    connected: true,
    phpError: null,
    download: 302,
  };
  const service = createProService({
    paths,
    security: defaultFileSecurity(),
    now: () => now,
    credentials: async () => ({
      replace: async (_id, value) => {
        const prior = saved;
        saved = value;
        return prior;
      },
      delete: async () => {
        const prior = saved;
        saved = undefined;
        return prior;
      },
      restore: async (prior) => {
        saved = prior;
      },
      require: async () => {
        if (!saved) throw new Error("missing");
        return { reveal: () => saved };
      },
    }),
    profiles: async () => ({
      cliAvailable: true,
      profiles: [
        {
          name: "example",
          siteUrl: "https://example.com",
          state: state.connected ? "connected" : "reconnect_required",
        },
      ],
    }),
    operations: {
      execute: async (command) => {
        commands.push(command);
        const preflight = command.input.code === PRO_PREFLIGHT;
        return {
          data: {
            success: true,
            return_value: preflight
              ? { code: "ready", url: state.url, existing: false }
              : {
                  code:
                    state.phpError ??
                    (command.input.code.includes("Plugin_Upgrader")
                      ? "installed"
                      : "configured"),
                },
          },
        };
      },
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(init.redirect, "manual");
      if (String(url).endsWith("/check"))
        return new Response(
          JSON.stringify([{ status_code: code, message: KEY }]),
        );
      return new Response(null, {
        status: state.download,
        headers:
          state.download === 302
            ? {
                location:
                  "https://downloads.example.com/pro.zip?signature=secret",
              }
            : {},
      });
    },
  });
  return {
    service,
    paths,
    requests,
    commands,
    state,
    advance: () => {
      now += 300001;
    },
  };
}

test("Pro save stores only the last four characters locally and does not activate", async (t) => {
  const f = await fixture(t);
  await f.service.save(KEY);
  assert.deepEqual(await f.service.view(), { last4: "1234" });
  assert.equal(
    (await readFile(proLicenseMetadataPath(f.paths), "utf8")).includes(KEY),
    false,
  );
  const html = renderHtml(renderPro(await f.service.view()));
  assert.ok(html.includes("1234"));
  assert.ok(!html.includes(KEY));
  await f.service.remove();
  assert.deepEqual(await f.service.view(), {});
  assert.equal(f.requests.length, 0);
});

for (const code of ["s100", "s101"])
  test(`Pro ${code}: activation, signed ZIP install, configuration in order`, async (t) => {
    const f = await fixture(t, code);
    await f.service.save(KEY);
    const review = await f.service.plan("example");
    assert.equal(f.requests.length, 0);
    assert.match(
      await f.service.install(review.id),
      /installed, active and licensed/,
    );
    assert.equal(f.requests.length, 2);
    const form = f.requests[0].init.body;
    assert.equal(form.get("licence_key"), KEY);
    assert.equal(form.get("domain"), "example.com");
    assert.equal(form.get("woo_sl_action"), "activate");
    assert.equal(form.get("product_unique_id"), "WP-NVP-1");
    assert.equal(new URL(f.requests[1].url).searchParams.get("license"), KEY);
    assert.equal(f.commands.length, 4);
    assert.ok(
      f.commands.every(
        (c) => c.site === "example" && c.ability === "novamira/execute-php",
      ),
    );
    assert.ok(
      f.commands[2].input.code.includes(
        Buffer.from(
          "https://downloads.example.com/pro.zip?signature=secret",
        ).toString("base64"),
      ),
    );
    assert.ok(
      f.commands[3].input.code.includes(Buffer.from(KEY).toString("base64")),
    );
    await assert.rejects(f.service.install(review.id), /already used/);
    assert.equal(f.requests.length, 2);
  });

test("Pro e112 stops before download and does not echo the server message", async (t) => {
  const f = await fixture(t, "e112");
  await f.service.save(KEY);
  const review = await f.service.plan("example");
  await assert.rejects(
    f.service.install(review.id),
    (error) => error.message.includes("e112") && !error.message.includes(KEY),
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.commands.length, 2);
});

test("Pro confirmation expires and destination changes block activation", async (t) => {
  const f = await fixture(t);
  await f.service.save(KEY);
  const expired = await f.service.plan("example");
  f.advance();
  await assert.rejects(f.service.install(expired.id), /expired/);
  const changed = await f.service.plan("example");
  f.state.url = "https://example.com/other";
  await assert.rejects(f.service.install(changed.id), /does not match/);
  assert.equal(f.requests.length, 0);
});

test("Pro download failure reports the already activated license", async (t) => {
  const f = await fixture(t);
  await f.service.save(KEY);
  const review = await f.service.plan("example");
  f.state.download = 403;
  await assert.rejects(
    f.service.install(review.id),
    /HTTP 403.*already activated/,
  );
  assert.equal(f.commands.length, 2);
});

test("Pro configuration failure preserves partial outcome without exposing the key", async (t) => {
  const f = await fixture(t);
  await f.service.save(KEY);
  const review = await f.service.plan("example");
  f.state.phpError = "license_configuration_failed";
  await assert.rejects(
    f.service.install(review.id),
    (error) =>
      /already activated/.test(error.message) && !error.message.includes(KEY),
  );
});

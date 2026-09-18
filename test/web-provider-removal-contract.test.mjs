// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createProviderRemoveHandler } from "../dist/web/handlers/providers.js";
import { renderHtml } from "../dist/web/html.js";

function fixture({ verified = true, changed = false, fail = false } = {}) {
  const calls = [];
  const site = { name: "manual-original", siteUrl: "https://site.test" };
  const handler = createProviderRemoveHandler({
    token: "token",
    loadConfigView: async () => ({ profiles: [], pushes: [], version: "test" }),
    providers: {
      remove: async (name) => {
        calls.push(`hosting:${name}`);
        return { name };
      },
    },
    integration: {
      listProfiles: async () => ({
        cliAvailable: true,
        profiles: changed
          ? [{ ...site, siteUrl: "https://other.test" }]
          : [site, { name: "unrelated", siteUrl: "https://unrelated.test" }],
      }),
      removeProfile: async (name) => {
        calls.push(`site:${name}`);
        return { kind: fail ? "failed" : "done" };
      },
    },
    sites: {
      list: async () => ({
        groups: [{ profile: "hosting" }],
        connections: {
          cliAvailable: verified,
          byKey: new Map([["env", { profiles: [site.name] }]]),
        },
        siteProfiles: { cliAvailable: verified, profiles: [site] },
      }),
    },
  });
  const invoke = async (query) => {
    let markup = "";
    const response = handler({
      query: new URLSearchParams(query),
      body: async () => "{}",
      signal: new AbortController().signal,
    });
    await response.run({
      patchSignals() {},
      patchElements: (html, options) => {
        if (options.selectorId === "main") markup = renderHtml(html);
      },
      close() {},
    });
    return markup;
  };
  const review = async () => {
    const markup = await invoke("profile=hosting");
    assert.deepEqual(calls, []);
    return { markup, id: markup.match(/confirmation=([a-f0-9-]+)/)?.[1] };
  };
  return { calls, invoke, review };
}

test("hosting removal previews linked sites and can preserve all site access", async () => {
  const f = fixture();
  const { markup, id } = await f.review();
  assert.ok(markup.includes("manual-original"));
  assert.ok(
    markup.includes("Your websites and installed plugins will not be deleted."),
  );
  await f.invoke(`profile=hosting&confirmation=${id}&remove_sites=false`);
  assert.deepEqual(f.calls, ["hosting:hosting"]);
});

test("confirmed removal removes only reviewed site connections before the account, once", async () => {
  const f = fixture();
  const { id } = await f.review();
  const query = `profile=hosting&confirmation=${id}&remove_sites=true`;
  await f.invoke(query);
  await f.invoke(query);
  assert.deepEqual(f.calls, ["site:manual-original", "hosting:hosting"]);
});

test("unverified or changed sites cannot be bulk removed", async () => {
  for (const options of [{ verified: false }, { changed: true }]) {
    const f = fixture(options);
    const { id } = await f.review();
    await f.invoke(`profile=hosting&confirmation=${id}&remove_sites=true`);
    assert.deepEqual(f.calls, []);
  }
});

test("a failed site removal keeps the hosting account", async () => {
  const f = fixture({ fail: true });
  const { id } = await f.review();
  const markup = await f.invoke(
    `profile=hosting&confirmation=${id}&remove_sites=true`,
  );
  assert.deepEqual(f.calls, ["site:manual-original"]);
  assert.ok(markup.includes("The hosting account was kept"));
});

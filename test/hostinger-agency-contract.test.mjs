// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  listAgencySites,
  getAgencySite,
} from "../dist/hosting/providers/hostinger-agency.js";
import { createHostingerClient } from "../dist/hosting/providers/hostinger.js";
import { SecretValue } from "../dist/credentials/resolve.js";

const row = (id, details = {}, state = "active", platform = "h5g") => ({
  id,
  platform,
  state,
  details: { domains: [{ fqdn: `${id}.example.com` }], ...details },
});
const page = (data, current_page = 1, per_page = 50, total = data.length) => ({
  data,
  meta: { current_page, per_page, total },
});
function mock(responses) {
  const calls = [];
  return {
    calls,
    baseUrl: "https://developers.hostinger.com",
    async json(request) {
      calls.push(request);
      assert.ok(responses.length, "unexpected HTTP request");
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return value;
    },
  };
}
function client(http) {
  return createHostingerClient({
    secret: new SecretValue("test-placeholder", "env", "env:TEST"),
    baseUrl: http.baseUrl,
    credentialSource: "env:TEST",
    createHttpClient: () => http,
  });
}

test("Agency-only account returns sites and correct endpoint", async () => {
  const http = mock([page([]), page([row("one")])]);
  const sites = await client(http).listSites({ includeEnvironments: true });
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, "agency:one");
  assert.equal(sites[0].primaryDomain, "one.example.com");
  assert.equal(sites[0].environments[0].id, "agency:one");
  assert.equal(sites[0].environments[0].isBlocked, false);
  assert.equal(
    http.calls[1].path,
    "https://developers.hostinger.com/api/agency-hosting/v1/websites",
  );
});

test("mixed accounts preserve classic and Agency identity even for the same domain", async () => {
  const http = mock([
    page([{ domain: "one.example.com", username: "u1", is_enabled: true }]),
    page([row("one")]),
  ]);
  const sites = await client(http).listSites();
  assert.deepEqual(
    sites.map((s) => s.id),
    ["one.example.com", "agency:one"],
  );
  assert.equal(sites[1].environments, undefined);
});

test("Agency pagination requests every page", async () => {
  const http = mock([page([row("one")], 1, 1, 2), page([row("two")], 2, 1, 2)]);
  const sites = await listAgencySites(http, false);
  assert.equal(sites.length, 2);
  assert.deepEqual(http.calls[1].query, [
    ["page", "2"],
    ["per_page", "50"],
  ]);
});

test("Builder and preview-only sites map domains; suspended sites stay blocked", async () => {
  const sites = await listAgencySites(
    mock([
      page([
        row("preview", {
          domains: [],
          preview_domain: { fqdn: "preview.hostingersite.com" },
        }),
        row(
          "builder",
          { domains: [], vhost: "builder.example.com" },
          "suspended",
          "builder",
        ),
      ]),
    ]),
    true,
  );
  assert.equal(sites[0].primaryDomain, "preview.hostingersite.com");
  assert.equal(sites[1].primaryDomain, "builder.example.com");
  assert.equal(sites[1].environments[0].isBlocked, true);
});

test("Agency site and environment lookup use exact IDs", async () => {
  const http = mock([page([row("one"), row("two")]), page([row("one")])]);
  assert.equal((await client(http).getSite("agency:two")).id, "agency:two");
  assert.equal(
    (await client(http).listEnvironments("agency:one"))[0].id,
    "agency:one",
  );
  await assert.rejects(
    getAgencySite(mock([page([row("one")])]), "agency:missing"),
    /not found/,
  );
});

test("Agency API failure never becomes an empty successful inventory", async () => {
  await assert.rejects(
    client(mock([page([]), new Error("provider rejected access")])).listSites(),
    /rejected access/,
  );
});

test("malformed Agency responses fail explicitly", async () => {
  for (const response of [
    {},
    page([{}]),
    page([], 0),
    page([], 1, 0),
    page([], 1, 50, 51),
  ]) {
    await assert.rejects(listAgencySites(mock([response]), true), /inventory/);
  }
});

test("repeated Agency pages cannot silently truncate or duplicate inventory", async () => {
  await assert.rejects(
    listAgencySites(
      mock([page([row("one")], 1, 1, 2), page([row("one")], 2, 1, 2)]),
      true,
    ),
    /duplicate/,
  );
  await assert.rejects(
    listAgencySites(
      mock([page([row("one")], 1, 1, 2), page([row("two")], 1, 1, 2)]),
      true,
    ),
    /pagination/,
  );
});

test("Agency targets cannot enter classic provisioning or plugin endpoints", async () => {
  const http = mock([]);
  await assert.rejects(
    client(http).action({
      kind: "setup-novamira",
      envId: "agency:one",
      enableAiAbilities: true,
    }),
    /not implemented/,
  );
  await assert.rejects(
    client(http).read({ kind: "plugins", envId: "agency:one" }),
    /not implemented/,
  );
  assert.equal(http.calls.length, 0);
});

test("classic account scope never requests Agency inventory", async () => {
  for (const scope of ["profile", "request"]) {
    const http = mock([
      page([
        { domain: "classic.example.com", username: "u1", is_enabled: true },
      ]),
    ]);
    const scoped = createHostingerClient({
      secret: new SecretValue("test-placeholder", "env", "env:TEST"),
      baseUrl: http.baseUrl,
      credentialSource: "env:TEST",
      companyId: scope === "profile" ? "u1" : undefined,
      createHttpClient: () => http,
    });
    const sites = await scoped.listSites(
      scope === "request" ? { companyId: "u1" } : undefined,
    );
    assert.deepEqual(
      sites.map((s) => s.id),
      ["classic.example.com"],
    );
    assert.equal(http.calls.length, 1);
    assert.ok(http.calls[0].path.endsWith("/api/hosting/v1/websites"));
    assert.deepEqual(http.calls[0].query.at(-1), ["username", "u1"]);
  }
});

test("missing domain remains unconnectable; invalid URLs cannot become site origins", async () => {
  for (const domain of [
    "",
    "https://example.com",
    "user:pass@example.com",
    "example.com/path",
    "<script>",
  ]) {
    const [site] = await listAgencySites(
      mock([
        page([
          row("empty", {
            domains: [{ fqdn: domain }],
            description: "Awaiting a domain",
          }),
        ]),
      ]),
      true,
    );
    assert.equal(site.primaryDomain, undefined);
    assert.equal(site.environments[0].primaryDomain, undefined);
    assert.equal(site.name, "Awaiting a domain");
  }
});

test("Agency metadata chooses a public domain before preview; Horizons and string domains are mapped", async () => {
  const sites = await listAgencySites(
    mock([
      page([
        row("custom", {
          domains: [{ fqdn: "custom.example.com" }],
          preview_domain: { fqdn: "preview.example.com" },
        }),
        row("horizons", { domains: ["app.example.com"] }, "active", "u4s"),
        row("preview", {
          domains: [],
          preview_domain: { fqdn: "preview.example.com" },
        }),
        row("building", { domains: [] }, "creating"),
      ]),
    ]),
    true,
  );
  assert.deepEqual(
    sites.map((s) => s.primaryDomain),
    ["custom.example.com", "app.example.com", "preview.example.com", undefined],
  );
  assert.equal(sites[3].environments[0].isBlocked, true);
});

test("short final pages and inconsistent totals never produce partial successful inventory", async () => {
  for (const responses of [
    [page([], 1, 50, 1)],
    [page([row("one")], 1, 50, 2)],
    [page([row("one")], 1, 50, 0)],
    [page([row("one")], 1, 1, 2), page([], 2, 1, 2)],
    [page([row("one")], 1, 1, 2), page([row("two")], 2, 1, 3)],
    [page([row("one")], 1, 1, 2), page([row("two")], 2, 2, 2)],
  ]) {
    await assert.rejects(listAgencySites(mock(responses), false), {
      code: "provider_error",
    });
  }
});

test("pagination metadata requires safe nonnegative integer counts", async () => {
  for (const overrides of [
    { current_page: "1" },
    { per_page: "50" },
    { per_page: -1 },
    { per_page: 1.5 },
    { total: -1 },
    { total: "0" },
    { total: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const response = page([]);
    Object.assign(response.meta, overrides);
    await assert.rejects(listAgencySites(mock([response]), false), {
      code: "provider_error",
    });
  }
});

test("pagination is bounded even when the API keeps returning new records", async () => {
  let calls = 0;
  const http = {
    baseUrl: "https://developers.hostinger.com",
    async json() {
      calls++;
      return page([row(`site-${calls}`)], calls, 1, 2501);
    },
  };
  await assert.rejects(
    listAgencySites(http, false),
    /pagination limit exceeded/,
  );
  assert.equal(calls, 2500);
});

test("Agency targets cannot reach classic domain writes or environment creation", async () => {
  const http = mock([]);
  for (const request of [
    {
      kind: "add-domain",
      envId: "agency:one",
      body: { username: "u1", domain: "example.com" },
    },
    {
      kind: "create-environment",
      siteId: "agency:one",
      mode: "wordpress",
      body: { username: "u1" },
    },
  ])
    await assert.rejects(client(http).action(request), {
      code: "provider_unsupported",
    });
  await assert.rejects(
    client(http).read({ kind: "site-domains", envId: "agency:one" }),
    { code: "provider_unsupported" },
  );
  assert.equal(http.calls.length, 0);
});

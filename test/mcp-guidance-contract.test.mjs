// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { listAllSites } from "../dist/mcp/inventory.js";
import { MCP_GUIDE, MCP_INSTRUCTIONS } from "../dist/mcp/guidance.js";

function dependencies({
  siteAbsent = false,
  hostingFails = false,
  noHosting = false,
} = {}) {
  const calls = [];
  return {
    calls,
    store: {
      listHostingProfiles: async () =>
        noHosting
          ? []
          : ["first", "second"].map((name) => ({
              name,
              profile: { provider: "kinsta" },
            })),
    },
    ...(siteAbsent
      ? {}
      : {
          siteOperations: {
            execute: async (operation) => {
              calls.push(operation);
              return [{ name: "same", siteUrl: "https://direct.example" }];
            },
          },
        }),
    hosting: {
      clientFromProfile: async (account) => {
        if (hostingFails && account === "first")
          throw Error("secret provider error");
        return {
          listSites: async (options) => {
            calls.push({ account, ...options });
            return [
              {
                name: "same",
                url: "https://hosting.example",
                environments: [],
              },
            ];
          },
        };
      },
    },
  };
}

test("integrated MCP guidance routes inventory and does not depend on a terminal skill", () => {
  assert.match(MCP_INSTRUCTIONS, /novamira_hq_guide/);
  assert.match(MCP_INSTRUCTIONS, /novamira_hq_sites_list/);
  assert.match(MCP_GUIDE, /Claude Desktop, Claude Code/);
  assert.match(MCP_GUIDE, /do not need a terminal/);
  assert.match(MCP_GUIDE, /untrusted/);
  assert.match(MCP_GUIDE, /plan, user review/);
});

test("complete inventory retains WordPress and all hosting accounts without name-based merging", async () => {
  const deps = dependencies();
  const result = await listAllSites(deps);
  assert.equal(result.complete, true);
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0].data[0].siteUrl, "https://direct.example");
  assert.deepEqual(
    result.sources.slice(1).map((source) => source.account),
    ["first", "second"],
  );
  assert.deepEqual(deps.calls, [
    { kind: "list" },
    { account: "first", includeEnvironments: true },
    { account: "second", includeEnvironments: true },
  ]);
});

test("a failed hosting account does not hide connected profiles or other accounts", async () => {
  const result = await listAllSites(dependencies({ hostingFails: true }));
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.sources.map((source) => source.status),
    ["ok", "unavailable", "ok"],
  );
  assert.doesNotMatch(JSON.stringify(result), /secret provider error/);
});

test("missing site integration leaves hosting available and cannot look like a complete inventory", async () => {
  const result = await listAllSites(dependencies({ siteAbsent: true }));
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].status, "unavailable");
  assert.equal(result.sources[1].status, "ok");
});

test("sites connected by URL remain visible without a hosting account", async () => {
  const result = await listAllSites(dependencies({ noHosting: true }));
  assert.equal(result.complete, true);
  assert.equal(result.sources[0].data.length, 1);
  assert.deepEqual(result.sources[1].data, []);
});

test("hosting configuration failure does not discard WordPress results", async () => {
  const deps = dependencies();
  deps.store.listHostingProfiles = async () => {
    throw Error("private path");
  };
  const result = await listAllSites(deps);
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /private path/);
});

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { renderHtml } from "../dist/web/html.js";
import { renderPushesPage } from "../dist/web/views/pushes.js";

const environments = [
  { id: "live", name: "Live", primaryDomain: "example.test" },
  { id: "test", name: "Test", primaryDomain: "test.example.test" },
];
const group = {
  profile: "account",
  provider: "kinsta",
  sites: [{ id: "site", name: "Site", environments }],
};
const view = {
  profiles: [{ name: "account", provider: "kinsta" }],
  pushes: [],
};
const push = (source, target) => ({
  name: `${source}-to-${target}`,
  hostingProfile: "account",
  siteId: "site",
  siteLabel: "Site",
  sourceEnvId: source,
  targetEnvId: target,
  sourceEnvName: source,
  targetEnvName: target,
  sourceEnvDomain: "example.test",
  targetEnvDomain: "test.example.test",
  pushDb: true,
  supported: true,
});
const render = (
  pushes = [],
  groups = [group],
  cacheWarm = true,
  profiles = view.profiles,
) =>
  renderHtml(
    renderPushesPage({ ...view, profiles, pushes }, {}, { groups, cacheWarm }),
  );

test("saved forward direction leaves the reverse available, then both exhaust the inventory", () => {
  const forward = push("live", "test");
  const markup = render([forward]);
  assert.ok(markup.includes("source=test&amp;target=live"));
  assert.ok(!markup.includes("source=live&amp;target=test"));
  assert.ok(markup.includes("From: test.example.test → To: example.test"));
  assert.ok(!markup.includes('href="/sites">Set up a push'));
  const full = render([forward, push("test", "live")]);
  assert.ok(full.includes("All directions are already configured"));
  assert.ok(!full.includes("Set up a push</a>"));
  assert.ok(full.includes("Review and run"));
});

test("cold, failed and incomplete inventory never claim all directions are configured", () => {
  for (const markup of [
    render([], [], false),
    render([], [{ ...group, error: "unavailable" }]),
    render([], [{ ...group, stale: true }]),
    render([], []),
    render([], [{ ...group, sites: [{ id: "site" }] }]),
  ]) {
    assert.ok(!markup.includes("All directions are already configured"));
    assert.ok(markup.includes("Open Sites"));
  }
});

test("unsupported providers and insufficient environments have different explanations", () => {
  assert.ok(
    render([], [], true, [{ name: "plain", provider: "pantheon" }]).includes(
      "Push is not available",
    ),
  );
  assert.ok(
    render(
      [],
      [
        {
          ...group,
          sites: [
            { ...group.sites[0], environments: environments.slice(0, 1) },
          ],
        },
      ],
    ).includes("At least two environments are needed"),
  );
});

test("three environments expose all six ordered directions and match saves by account and site", () => {
  const groups = [
    {
      ...group,
      sites: [
        {
          ...group.sites[0],
          environments: [...environments, { id: "third", name: "Third" }],
        },
      ],
    },
  ];
  const markup = render(
    [{ ...push("live", "test"), hostingProfile: "other" }],
    groups,
  );
  assert.equal((markup.match(/Set up a push<\/a>/g) ?? []).length, 6);
});

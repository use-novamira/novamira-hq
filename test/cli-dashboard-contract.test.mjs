// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { createDashboardHandlers } from "../dist/cli/dashboard.js";
import { CliError } from "../dist/errors.js";

test("dashboard --open reopens a verified running dashboard", async () => {
  const successes = [];
  const warnings = [];
  const opened = [];
  const probes = [];
  const renderer = {
    success(data, options) {
      successes.push({ data, options });
    },
    warn(message) {
      warnings.push(message);
    },
  };
  const dependencies = {
    store: { configFile: "/test/config.json" },
    rendererFor: () => renderer,
  };
  const handlers = createDashboardHandlers(dependencies, {
    probeDashboard: async (target) => {
      probes.push(target);
      return true;
    },
    openBrowser: async (target) => {
      opened.push(target);
    },
  });

  await handlers.dashboard({ listen: "127.0.0.1:8787", open: true }, {});

  assert.deepEqual(probes, ["http://127.0.0.1:8787"]);
  assert.deepEqual(opened, ["http://127.0.0.1:8787"]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(successes, [
    {
      data: {
        url: "http://127.0.0.1:8787",
        host: "127.0.0.1",
        port: 8787,
        configFile: "/test/config.json",
      },
      options: {
        human:
          "Novamira HQ dashboard: http://127.0.0.1:8787\nConfig: /test/config.json",
      },
    },
  ]);
});

test("implicit dashboard --open finds HQ on a fallback port", async () => {
  const opened = [];
  const probes = [];
  const successes = [];
  const dependencies = {
    store: { configFile: "/test/config.json" },
    rendererFor: () => ({
      success(data) {
        successes.push(data);
      },
      warn() {},
    }),
  };
  const handlers = createDashboardHandlers(dependencies, {
    probeDashboard: async (target) => {
      probes.push(target);
      return target === "http://127.0.0.1:8789";
    },
    openBrowser: async (target) => {
      opened.push(target);
    },
  });

  await handlers.dashboard({ open: true }, {});

  assert.deepEqual(
    probes,
    Array.from(
      { length: 10 },
      (_, offset) => `http://127.0.0.1:${8787 + offset}`,
    ),
  );
  assert.deepEqual(opened, ["http://127.0.0.1:8789"]);
  assert.equal(successes[0].port, 8789);
});

test("implicit dashboard startup skips occupied ports", async () => {
  const attempts = [];
  const opened = [];
  const successes = [];
  const dependencies = {
    store: { configFile: "/test/config.json" },
    io: { env: {}, stdin: undefined },
    rendererFor: () => ({
      success(data) {
        successes.push(data);
      },
      diagnostic() {},
    }),
  };
  const handlers = createDashboardHandlers(dependencies, {
    integration: {},
    doctor: async () => ({}),
    updates: {},
    probeDashboard: async () => false,
    openBrowser: async (target) => {
      opened.push(target);
    },
    createServer: () => ({
      token: "test",
      handler() {},
      async dispatch() {},
      async listen(address) {
        attempts.push(address.port);
        if (address.port < 8789) {
          throw new CliError("conflict", "occupied");
        }
        return {
          ...address,
          url: `http://${address.hostname}:${address.port}`,
        };
      },
      async close() {},
      async closed() {},
    }),
  });

  await handlers.dashboard({ open: true }, {});

  assert.deepEqual(attempts, [8787, 8788, 8789]);
  assert.deepEqual(opened, ["http://127.0.0.1:8789"]);
  assert.equal(successes[0].port, 8789);
});

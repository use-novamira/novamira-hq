// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createMcpConnectHandler } from "../dist/web/handlers/mcp.js";
import { createMcpConnectionService } from "../dist/mcp/configuration.js";
import { renderHtml } from "../dist/web/html.js";
import { renderAcknowledgement } from "../dist/web/views/acknowledgement.js";
import { CliError } from "../dist/errors.js";

async function connect({
  outcome = "configured",
  failed = false,
  client = "claude-code",
} = {}) {
  const events = [];
  const pages = [];
  const toasts = [];
  let closed = false;
  const handler = createMcpConnectHandler({
    token: "a".repeat(64),
    loadConfigView: async () => ({ profiles: [], pushes: [] }),
    mcpConnection: {
      configuration: () =>
        createMcpConnectionService(
          { command: "novamira-hq", args: ["mcp"] },
          {},
        ).configuration(),
      verify: async () => {
        events.push("verify");
        if (failed)
          throw new CliError(
            "integration_unavailable",
            "HQ is unavailable. Try again.",
          );
        return { toolCount: 12 };
      },
      connect: async () => {
        events.push("register");
        return outcome;
      },
    },
  });
  await handler({ query: new URLSearchParams({ client }) }).run({
    patchElements(value, options) {
      if (options.selectorId === "main") pages.push(renderHtml(value));
      if (options.selectorId === "toast") toasts.push(renderHtml(value));
    },
    close() {
      closed = true;
    },
  });
  return { events, pages, toasts, closed };
}

test("AI setup verifies HQ first and replaces the form with a dedicated outcome", async () => {
  const result = await connect();
  assert.deepEqual(result.events, ["verify", "register"]);
  assert.match(result.pages[0], /Checking Novamira HQ/);
  assert.match(result.pages[1], /Configuring Claude Code CLI/);
  assert.match(result.pages[2], /Claude Code CLI is configured/);
  assert.match(result.pages[2], /Back to AI clients/);
  assert.match(result.pages[2], /has not yet been verified/);
  assert.doesNotMatch(result.pages[2], /_dashboard\/mcp\/connect/);
  assert.ok(result.toasts.every((markup) => !markup.includes("show")));
  assert.equal(result.closed, true);
});

test("failed preflight preserves a readable setup page and never registers the client", async () => {
  const result = await connect({ failed: true });
  assert.deepEqual(result.events, ["verify"]);
  assert.match(result.pages.at(-1), /role="alert"/);
  assert.match(result.pages.at(-1), /HQ is unavailable/);
  assert.match(result.pages.at(-1), /Configure Claude Code CLI/);
  assert.equal(result.closed, true);
});

test("existing registrations and VS Code handoff are not called verified connections", async () => {
  assert.match(
    (await connect({ outcome: "existing" })).pages.at(-1),
    /Configuration already exists/,
  );
  assert.match(
    (await connect({ outcome: "existing" })).pages.at(-1),
    /not been changed or verified/,
  );
  assert.match(
    (await connect({ outcome: "sent", client: "vscode" })).pages.at(-1),
    /Continue in VS Code/,
  );
});

test("initial notice explains actual risks, scoped approval and recoverable backups", () => {
  const page = renderHtml(renderAcknowledgement());
  assert.match(page, /including existing installations/);
  assert.match(page, /Connecting a site by URL does not enable AI Abilities/);
  assert.match(page, /Push and restore operations can overwrite/);
  assert.match(
    page,
    /up-to-date backup in a safe location, separate from the site/,
  );
  assert.match(page, /know how to restore it/);
  assert.match(page, /does not authorize operations/);
  assert.doesNotMatch(
    page,
    /SSH|SFTP|without asking you again|does not expose/,
  );
});

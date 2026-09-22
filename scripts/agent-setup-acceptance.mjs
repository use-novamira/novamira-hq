// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

const { fetch, AbortSignal } = globalThis;

/** Real compiled dashboard routes, token guard and Datastar patch output. */
export async function verifyAgentSetup(url, home) {
  const initial = await (await fetch(url)).text();
  const token = /&quot;token&quot;:&quot;([^&]+)&quot;/.exec(initial)?.[1];
  assert.ok(token, "dashboard must provide its mutation token");
  const call = async (path, method = "POST") => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: { "X-Novamira-Dashboard-Token": token, Origin: url },
      signal: AbortSignal.timeout(120_000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  const forbidden = await fetch(
    new URL("/_dashboard/agents/install?agent=claude-code", url),
    { method: "POST" },
  );
  assert.equal(forbidden.status, 403);
  const onboarding = await call("/_dashboard/app/acknowledge");
  assert.doesNotMatch(
    onboarding,
    /Connect your agents|Install for Claude Code/,
  );
  for (const action of [
    "install",
    "repair",
    "remove",
    "cancel",
    "dismiss",
    "command",
  ]) {
    assert.match(
      await call(
        `/_dashboard/agents/${action}?agent=claude-code&operation=enable`,
      ),
      /temporarily unavailable/,
    );
  }
  for (const [directory, name] of [
    [".claude/skills", "novamira-hq"],
    [".codeium/windsurf/skills", "novamira-site"],
  ]) {
    await assert.rejects(access(join(home, directory, name, "SKILL.md")), {
      code: "ENOENT",
    });
  }
  assert.doesNotMatch(
    await (await fetch(url)).text(),
    /<h2>Connect your agents<\/h2>/,
  );
  assert.doesNotMatch(
    await (await fetch(new URL("/settings?tab=agents", url))).text(),
    /<h2>Connect your agents<\/h2>/,
  );
  assert.match(
    await call("/_dashboard/agents/status", "GET"),
    /temporarily unavailable/,
  );
  assert.match(
    await (await fetch(new URL("/configure-ai", url))).text(),
    /Claude Desktop/,
  );
}

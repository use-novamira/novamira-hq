// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(onboarding, /<h2>Connect your agents<\/h2>/);
  assert.match(onboarding, /Install for Claude Code/);
  assert.match(onboarding, /Use the MCP setup guide/);
  assert.match(
    await call("/_dashboard/agents/command?operation=repair"),
    /Command access: enabled/,
  );
  for (const agent of ["claude-code", "windsurf"]) {
    const installed = await call(`/_dashboard/agents/install?agent=${agent}`);
    assert.match(installed, /Setting up entry points/);
    assert.match(installed, /novamira-site: Success/);
    assert.match(installed, /novamira-hq: Success/);
    assert.match(
      await call(`/_dashboard/agents/repair?agent=${agent}`),
      /Already installed and current/,
    );
  }
  for (const [directory, name] of [
    [".claude/skills", "novamira-hq"],
    [".codeium/windsurf/skills", "novamira-site"],
  ]) {
    assert.match(
      await readFile(join(home, directory, name, "SKILL.md"), "utf8"),
      /novamira-hq/,
    );
  }
  assert.match(
    await call("/_dashboard/agents/remove?agent=windsurf"),
    /Removed HQ-owned entry point/,
  );
  await call("/_dashboard/agents/dismiss");
  assert.doesNotMatch(
    await (await fetch(url)).text(),
    /<h2>Connect your agents<\/h2>/,
  );
  assert.match(
    await (await fetch(new URL("/settings?tab=agents", url))).text(),
    /<h2>Connect your agents<\/h2>/,
  );
  assert.match(await call("/_dashboard/agents/status", "GET"), /novamira-site/);
}

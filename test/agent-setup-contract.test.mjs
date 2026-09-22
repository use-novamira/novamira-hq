// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
  rm,
  unlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnedSkills } from "../dist/agent-setup/owned-skills.js";
import { createAgentSetup } from "../dist/agent-setup/service.js";
import { renderAgentSetup } from "../dist/web/views/agent-setup.js";
import { renderHtml } from "../dist/web/html.js";
import { createAgentSetupHandler } from "../dist/web/handlers/agent-setup.js";

test("entry digest upgrades require repair; added files and corrupt ownership records are preserved", async () =>
  fixture(async ({ home, skills, target }) => {
    const signal = new AbortController().signal;
    const path = target("claude-code", "novamira-site");
    const hash = (text) => createHash("sha256").update(text).digest("hex");
    await skills.apply("claude-code", "novamira-site", "install", signal);
    const record = join(home, "hq/state/agent-skills", hash(path) + ".json");
    const old = "Previous HQ-owned entry point";
    await writeFile(join(path, "SKILL.md"), old);
    await writeFile(
      record,
      JSON.stringify({ version: 1, path, digest: hash(old) }),
    );
    assert.equal(
      (await skills.status("claude-code", "novamira-site")).state,
      "outdated",
    );
    await assert.rejects(
      skills.apply("claude-code", "novamira-site", "install", signal),
      /Use Repair/,
    );
    await skills.apply("claude-code", "novamira-site", "repair", signal);
    assert.equal(
      (await skills.status("claude-code", "novamira-site")).state,
      "installed",
    );
    await writeFile(join(path, "personal.md"), "keep me");
    await assert.rejects(
      skills.apply("claude-code", "novamira-site", "remove", signal),
      /preserved/,
    );
    assert.equal(await readFile(join(path, "personal.md"), "utf8"), "keep me");
    await writeFile(record, "{}");
    await assert.rejects(
      skills.apply("claude-code", "novamira-site", "repair", signal),
      /ownership record/,
    );
  }));

async function fixture(run) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hq-agents-")));
  const env = {
    HOME: home,
    USERPROFILE: home,
    NOVAMIRA_HQ_HOME: join(home, "hq"),
  };
  const target = (env, agent, skill) => join(env.HOME, agent, skill);
  let calls = 0;
  const spawn = async ({ args, env, signal }) => {
    if (signal.aborted) return { kind: "aborted" };
    const [, operation, agent, source, skill] = args;
    let value;
    if (operation === "target") value = target(env, agent, source);
    if (operation === "list") {
      value = [];
      for (const name of ["novamira-hq", "novamira-site"]) {
        const path = target(env, agent, name);
        if (await readFile(join(path, "SKILL.md")).catch(() => false))
          value.push({
            name,
            path,
            agents: [agent === "claude-code" ? "Claude Code" : "Windsurf"],
          });
      }
    }
    if (operation === "install") {
      calls++;
      assert.notEqual(
        env.HOME,
        home,
        "registrar must never write to the real agent home",
      );
      const path = target(env, agent, skill);
      await mkdir(path, { recursive: true });
      await copyFile(join(source, "SKILL.md"), join(path, "SKILL.md"));
      value = "";
    }
    return {
      kind: "exited",
      code: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    };
  };
  const options = { command: "desktop", env, spawn };
  const skills = createOwnedSkills(options);
  try {
    await run({
      home,
      env,
      options,
      skills,
      target: (agent, skill) => target(env, agent, skill),
      calls: () => calls,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("owned skills: both entries, repeat, additional agent, missing-file repair and owned removal", async () =>
  fixture(async ({ home, skills, target, calls }) => {
    const signal = new AbortController().signal;
    for (const agent of ["claude-code", "windsurf"]) {
      for (const skill of ["novamira-hq", "novamira-site"]) {
        await skills.apply(agent, skill, "install", signal);
        assert.equal((await skills.status(agent, skill)).state, "installed");
        assert.match(
          await readFile(join(target(agent, skill), "SKILL.md"), "utf8"),
          /novamira-hq/,
        );
        await skills.apply(agent, skill, "install", signal);
      }
    }
    assert.equal(calls(), 4);
    await unlink(join(target("claude-code", "novamira-site"), "SKILL.md"));
    await skills.apply("claude-code", "novamira-site", "repair", signal);
    assert.equal(
      (await skills.status("claude-code", "novamira-site")).state,
      "installed",
    );
    await skills.apply("claude-code", "novamira-site", "remove", signal);
    assert.equal(
      (await skills.status("claude-code", "novamira-site")).state,
      "missing",
    );
    assert.equal(
      (await skills.status("windsurf", "novamira-site")).state,
      "installed",
    );
    assert.deepEqual(await readdir(join(home, "hq/cache")), []);
  }));

test("manual, malformed, edited and extra files are preserved; concurrent installs serialize", async () =>
  fixture(async ({ skills, target }) => {
    const path = target("claude-code", "novamira-hq");
    const signal = new AbortController().signal;
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "manual malformed instructions");
    assert.equal(
      (await skills.status("claude-code", "novamira-hq")).state,
      "conflict",
    );
    for (const action of ["install", "repair", "remove"])
      await assert.rejects(
        skills.apply("claude-code", "novamira-hq", action, signal),
        /preserved/,
      );
    assert.equal(
      await readFile(join(path, "SKILL.md"), "utf8"),
      "manual malformed instructions",
    );
    await rm(path, { recursive: true });
    await Promise.all([
      skills.apply("claude-code", "novamira-hq", "install", signal),
      skills.apply("claude-code", "novamira-hq", "install", signal),
    ]);
    await writeFile(join(path, "SKILL.md"), "user edited");
    await assert.rejects(
      skills.apply("claude-code", "novamira-hq", "repair", signal),
      /preserved/,
    );
    await assert.rejects(
      skills.apply("claude-code", "novamira-hq", "remove", signal),
      /preserved/,
    );
  }));

test("setup jobs preserve partial success, retry, explicit selection and cancellation; onboarding is revisitable", async () =>
  fixture(async ({ options, skills }) => {
    let fail = true;
    let abortMode = false;
    const registration = {
      status: async () => ({
        state: "disabled",
        launcher: "/HQ path/novamira-hq",
        onPath: false,
      }),
      enable: async () => {},
      repair: async () => {},
      remove: async () => {},
    };
    const service = createAgentSetup({
      ...options,
      registration,
      skills: {
        ...skills,
        apply: async (...args) => {
          if (abortMode) {
            await new Promise((resolve) =>
              args[3].addEventListener("abort", resolve, { once: true }),
            );
            args[3].throwIfAborted();
          }
          if (fail && args[1] === "novamira-site")
            throw new Error("Directory permission denied; retry");
          return skills.apply(...args);
        },
      },
    });
    assert.equal((await service.view()).firstRun, true);
    assert.throws(
      () => service.start("unreviewed-agent", "install"),
      /supported/,
    );
    service.start("claude-code", "install");
    assert.throws(
      () => service.start("windsurf", "install"),
      /already running/,
    );
    await service.wait();
    assert.deepEqual(
      (await service.view()).results.map((r) => r.ok),
      [true, false],
    );
    fail = false;
    service.start("claude-code", "repair");
    await service.wait();
    assert.ok((await service.view()).results.every((r) => r.ok));
    abortMode = true;
    service.start("windsurf", "install");
    service.cancel();
    await service.wait();
    assert.ok(
      (await service.view()).results.every(
        (r) => !r.ok && /Cancel/.test(r.message),
      ),
    );
    await service.dismiss();
    const view = await service.view();
    assert.equal(view.firstRun, false);
    const markup = renderHtml(renderAgentSetup(view));
    assert.match(markup, /Install for Claude Code/);
    assert.match(markup, /novamira-site/);
    assert.match(markup, /MCP setup guide/);
    assert.match(markup, /Restart your agent/);
  }));

test("setup SSE failures are notice patches, with no unhandled rejection", async () => {
  const patches = [];
  const response = createAgentSetupHandler(
    {},
    "install",
  )({ query: new URLSearchParams() });
  await response.run({
    patchElements: (markup, target) =>
      patches.push([renderHtml(markup), target.selectorId]),
    close() {},
  });
  assert.equal(patches[0][1], "toast");
  assert.match(patches[0][0], /installed desktop application/);
});

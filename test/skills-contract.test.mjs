// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bundled agent skills: the store, the shipped markdown, and the `skills`
 * command group.
 *
 * The point of this suite is the **boundary rule as prose**. Two of the three
 * shipped files are instructions an agent will read and act on, so a sentence in
 * them that says "create an Application Password" or "run `novamira site exec`"
 * is not a documentation bug, it is HQ telling an agent to cross the boundary.
 * The assertions below scan both bundles for every spelling of the deleted
 * site surface, and check that the hosting bundle routes WordPress-level work to
 * `novamira` — the separate CLI — rather than to `novamira-hq`.
 *
 * It also pins the two deletions the Go had and HQ does not: there is no `site`
 * bundle, and no command anywhere writes an agent skill to disk.
 *
 * Fully offline. It reads files out of the repository's own `skills/` directory
 * and runs `main` against captured streams under a temporary `NOVAMIRA_HQ_HOME`.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProgram } from "../dist/cli/program.js";
import { CliError } from "../dist/errors.js";
import { main } from "../dist/main.js";
import {
  SkillStore,
  AGENT_SKILL_DIRECTORY,
  DEFAULT_SKILL,
  SKILL_NAMES,
} from "../dist/skills/index.js";

const SKILLS_ROOT = fileURLToPath(new URL("../skills/", import.meta.url));

/** Run `main` against captured streams and an isolated HQ root. */
async function run(argv) {
  const root = await mkdtemp(join(tmpdir(), "novamira-hq-skills-"));
  const out = [];
  const err = [];
  try {
    const code = await main(
      argv,
      {
        stdout: { write: (chunk) => out.push(chunk) },
        stderr: { write: (chunk) => err.push(chunk) },
      },
      // No `PATH`: the site-CLI resolver finds nothing and spawns nothing.
      { NOVAMIRA_HQ_HOME: root },
    );
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function bundles() {
  const store = new SkillStore();
  const core = await store.get("core");
  const hosting = await store.get("hosting");
  const stub = await readFile(
    join(SKILLS_ROOT, AGENT_SKILL_DIRECTORY, "SKILL.md"),
    "utf8",
  );
  return { core, hosting, stub };
}

/* -------------------------------------------------------------------------- */
/* 1-4: the store                                                             */
/* -------------------------------------------------------------------------- */

test("1: two bundles, no site bundle, and core is the default", () => {
  assert.deepEqual([...SKILL_NAMES], ["core", "hosting"]);
  assert.equal(DEFAULT_SKILL, "core");
  assert.equal(AGENT_SKILL_DIRECTORY, "novamira-hq");

  const summaries = new SkillStore().list();
  assert.deepEqual(
    summaries.map((skill) => skill.name),
    ["core", "hosting"],
  );
  for (const skill of summaries) assert.ok(skill.description.length > 10);
});

test("2: get and path resolve real files, and default to core", async () => {
  const store = new SkillStore();
  for (const name of ["core", "hosting"]) {
    const document = await store.get(name);
    assert.equal(document.name, name);
    assert.ok(document.content.startsWith("---\n"), name);
    assert.ok(document.content.length > 200, name);
    assert.equal(document.path, join(SKILLS_ROOT, name, "SKILL.md"));
    // Go returned the string `embedded:skills/<name>/SKILL.md`, which nothing
    // could open. The path HQ prints is a file that exists.
    assert.equal(await readFile(document.path, "utf8"), document.content);
  }
  assert.equal((await store.get("")).name, "core");
  assert.equal(store.path(""), join(SKILLS_ROOT, "core", "SKILL.md"));
});

test("3: an unknown name — including site — is usage_error with the known set", async () => {
  const store = new SkillStore();
  for (const name of ["site", "nope", "SITE"]) {
    await assert.rejects(
      () => store.get(name),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "usage_error");
        assert.deepEqual([...error.details.known], ["core", "hosting"]);
        assert.equal(error.details.skill, name);
        return true;
      },
      name,
    );
    assert.throws(() => store.path(name), CliError, name);
  }
});

test("4: readable() reports the shipped tree intact, and a broken one honestly", async () => {
  const intact = await new SkillStore().readable();
  assert.deepEqual(intact, {
    core: true,
    hosting: true,
    agentStub: true,
    missing: [],
  });

  const root = await mkdtemp(join(tmpdir(), "novamira-hq-skills-root-"));
  try {
    // A tree with core present, hosting truncated to lose its cross-reference,
    // and the agent stub missing entirely: the three failure modes at once.
    await mkdir(join(root, "core"), { recursive: true });
    await mkdir(join(root, "hosting"), { recursive: true });
    await writeFile(
      join(root, "core", "SKILL.md"),
      "novamira-hq skills get hosting\n",
    );
    await writeFile(join(root, "hosting", "SKILL.md"), "# nothing useful\n");
    const broken = await new SkillStore(root).readable();
    assert.deepEqual(broken, {
      core: true,
      hosting: false,
      agentStub: false,
      missing: ["hosting", "novamira-hq"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* 5-8: what the shipped markdown may and may not say                         */
/* -------------------------------------------------------------------------- */

test("5: neither bundle describes the deleted site surface", async () => {
  const { core, hosting, stub } = await bundles();
  const documents = {
    core: core.content,
    hosting: hosting.content,
    stub,
  };
  const forbidden = [
    /novamira site /,
    /application[-_ ]?password/i,
    /site_profiles/,
    /--site-profile/,
    /--replace-profile/,
    /novamiraLinkedToEnv/,
    // The deleted command surface: HQ installs no agent stub and has no
    // `setup` command.
    /skills install/,
    /novamira-hq setup/,
  ];
  for (const [label, text] of Object.entries(documents))
    for (const pattern of forbidden)
      assert.ok(!pattern.test(text), `${label}: ${String(pattern)}`);

  // `sites delete` may only appear as the sentence saying it does not exist,
  // so an agent does not go looking for a command HQ deliberately withholds.
  assert.ok(hosting.content.includes("`hosting sites delete` does not exist."));
  assert.ok(!/novamira-hq[^\n]*hosting sites delete/.test(hosting.content));
});

test("6: the hosting bundle hands off to @novamira/cli and nothing else runs novamira", async () => {
  const { hosting } = await bundles();
  assert.ok(
    hosting.content.includes("novamira auth login https://example.com"),
  );
  assert.ok(hosting.content.includes("@novamira/cli"));
  assert.ok(hosting.content.includes("npm install -g @novamira/cli"));

  // Every command line in a fenced block is HQ's, except the one handoff line.
  const fenced = [
    ...hosting.content.matchAll(/```bash\n([\s\S]*?)```/g),
  ].flatMap((match) => match[1].split("\n"));
  assert.ok(fenced.length > 20, "the hosting bundle still carries examples");
  for (const line of fenced) {
    if (!line.startsWith("novamira")) continue;
    assert.ok(
      line.startsWith("novamira-hq ") || line.startsWith("novamira auth login"),
      line,
    );
  }
});

test("7: the router routes WordPress work away from HQ", async () => {
  const { core } = await bundles();
  // The literal the doctor check greps for.
  assert.ok(core.content.includes("novamira-hq skills get hosting"));
  assert.ok(core.content.includes("novamira-hq skills list"));
  assert.ok(core.content.includes("novamira auth login <site-url>"));
  assert.match(core.content, /never talks to a WordPress site/i);
  assert.match(core.content, /allowed-tools: Bash\(novamira-hq:\*\)/);
  // `Bash(novamira:*)` would authorize the *site* CLI, which HQ may not grant.
  assert.ok(!/allowed-tools:.*Bash\(novamira:\*\)/.test(core.content));
});

test("8: the installable stub loads the router and grants only novamira-hq", async () => {
  const { stub } = await bundles();
  assert.match(stub, /^---\nname: novamira-hq\n/);
  assert.match(stub, /allowed-tools: Bash\(novamira-hq:\*\)/);
  assert.ok(stub.includes("novamira-hq skills get core"));
  assert.ok(!/allowed-tools:.*Bash\(novamira:\*\)/.test(stub));
});

/* -------------------------------------------------------------------------- */
/* 9-11: the command group                                                    */
/* -------------------------------------------------------------------------- */

test("9: skills list and get emit the documented envelopes", async () => {
  const list = await run(["skills", "list", "--json"]);
  assert.equal(list.code, 0);
  const listed = JSON.parse(list.stdout);
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.data.skills.map((skill) => skill.name),
    ["core", "hosting"],
  );

  // No name means core, and `data` carries the name, the path and the content.
  const fallback = await run(["skills", "get", "--json"]);
  assert.equal(fallback.code, 0);
  const document = JSON.parse(fallback.stdout).data;
  assert.equal(document.name, "core");
  assert.ok(document.content.startsWith("---\n"));
  assert.equal(document.path, join(SKILLS_ROOT, "core", "SKILL.md"));

  const path = await run(["skills", "path", "hosting", "--json"]);
  assert.deepEqual(JSON.parse(path.stdout).data, {
    name: "hosting",
    path: join(SKILLS_ROOT, "hosting", "SKILL.md"),
  });
});

test("10: human mode prints the raw markdown, and an unknown name exits 2", async () => {
  const human = await run(["skills", "get", "hosting"]);
  assert.equal(human.code, 0);
  assert.ok(human.stdout.startsWith("---\nname: novamira-hq-hosting\n"));
  assert.equal(human.stderr, "");

  const unknown = await run(["skills", "get", "site", "--json"]);
  assert.equal(unknown.code, 2);
  const envelope = JSON.parse(unknown.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "usage_error");
});

test("11: the packaged layout is what the store resolves", async () => {
  // `SkillStore` resolves `../../skills/` from `dist/skills/store.js`, which is
  // `<package root>/skills/`. The tarball has to carry that directory or every
  // `skills get` on an installed copy is `internal_error`.
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.ok(manifest.files.includes("skills"), "package.json ships skills/");
  assert.ok(manifest.files.includes("dist"));
  for (const directory of ["novamira-hq", "core", "hosting"])
    assert.ok(
      (await readFile(join(SKILLS_ROOT, directory, "SKILL.md"), "utf8"))
        .length > 0,
      directory,
    );
});

test("12: no command writes an agent skill, and there is no setup command", () => {
  const program = createProgram("test", {});
  const names = program.commands.map((command) => command.name());
  assert.ok(names.includes("skills"));
  assert.ok(!names.includes("setup"));

  const skills = program.commands.find(
    (command) => command.name() === "skills",
  );
  assert.deepEqual(skills.commands.map((command) => command.name()).sort(), [
    "get",
    "list",
    "path",
  ]);
  // No options at all, so nothing here can shadow a reserved global.
  for (const child of skills.commands) assert.deepEqual(child.options, []);
});

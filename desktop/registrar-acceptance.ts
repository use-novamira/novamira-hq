// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Compiled adapter acceptance: the asset must come from the embedded filesystem.
const specifier =
  new URL("../dist/agent-setup/registrar.js", import.meta.url).href;
const { createSkillRegistrar } = await import(specifier);
const registrar = createSkillRegistrar({ command: Deno.args[0] });
for (const agent of registrar.agents) {
  const result = await registrar.installHosting(
    agent,
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(`${agent}: ${JSON.stringify(result)}`);
  const text = await Deno.readTextFile(`${result.path}/SKILL.md`);
  if (!text.includes("novamira-hq skills get core")) {
    throw new Error("Installed skill is unreadable after staging cleanup");
  }
  const repeat = await registrar.installHosting(
    agent,
    new AbortController().signal,
  );
  if (repeat.ok || repeat.reason !== "conflict") {
    throw new Error("Repeat installation must report a conflict");
  }
  if (
    result.path !==
      await registrar.target(agent, "novamira-hq", new AbortController().signal)
  ) {
    throw new Error("Pinned agent registry path differs from upstream");
  }
  await Deno.remove(result.path, { recursive: true });
}
const ownedSpecifier =
  new URL("../dist/agent-setup/owned-skills.js", import.meta.url).href;
const { createOwnedSkills } = await import(ownedSpecifier);
const owned = createOwnedSkills({ command: Deno.args[0] });
for (const agent of registrar.agents) {
  for (const skill of ["novamira-hq", "novamira-site"]) {
    await owned.apply(agent, skill, "install", new AbortController().signal);
    const status = await owned.status(agent, skill);
    if (status.state !== "installed") {
      throw new Error("Owned entry installation failed");
    }
    const text = await Deno.readTextFile(`${status.path}/SKILL.md`);
    if (
      !text.includes(
        skill === "novamira-site"
          ? "novamira-hq site-cli guide get core"
          : "novamira-hq skills get core",
      )
    ) throw new Error("Entry guidance missing");
    await owned.apply(agent, skill, "repair", new AbortController().signal);
  }
}
for (
  const args of [["skills", "get", "core"], [
    "site-cli",
    "guide",
    "get",
    "core",
    "--full",
  ]]
) {
  const result = await new Deno.Command(Deno.args[0], {
    args: ["--cli", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(result.stdout);
  if (!result.success || !text.includes("novamira-hq")) {
    throw new Error("Installed entry point guidance failed");
  }
  if (
    args[0] === "site-cli" &&
    (/(?<=`|^|\| )novamira(?= |`)/m.test(text) || text.includes("npm install"))
  ) throw new Error("Standalone site guidance leaked");
}
await owned.apply(
  "claude-code",
  "novamira-site",
  "remove",
  new AbortController().signal,
);
await owned.apply(
  "claude-code",
  "novamira-site",
  "repair",
  new AbortController().signal,
);
const missing = createSkillRegistrar({ command: `${Deno.args[0]}.missing` });
const failure = await missing.installHosting(
  "claude-code",
  new AbortController().signal,
);
if (failure.ok || !failure.message.includes("permissions")) {
  throw new Error("Registrar failure must be actionable");
}
console.log(
  "registrar acceptance: both entries, two agents, exact paths, owned repair/removal, offline guidance and conflicts passed",
);

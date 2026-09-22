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
}
const missing = createSkillRegistrar({ command: `${Deno.args[0]}.missing` });
const failure = await missing.installHosting(
  "claude-code",
  new AbortController().signal,
);
if (failure.ok || !failure.message.includes("permissions")) {
  throw new Error("Registrar failure must be actionable");
}
console.log(
  "registrar acceptance: two agents, copies survive cleanup, conflicts and startup failure passed",
);

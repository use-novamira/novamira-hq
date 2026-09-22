// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The bundled-skills surface.
 *
 * `src/skills/` is a leaf layer: it reads two markdown bundles and an agent stub
 * out of the installed package and hands them to whoever asked. `src/cli/` calls
 * it for the `skills` command group and `src/doctor/` calls it for the
 * `skills.bundled` check; it calls neither back, and it writes nothing anywhere.
 *
 * There is no `install`, no `setup`, and no `site` bundle — see `store.ts`'s
 * header for what each of those was in the Go and why it is gone.
 */

export {
  SkillStore,
  AGENT_SKILL_DIRECTORY,
  DEFAULT_SKILL,
  SKILL_NAMES,
  type SkillDocument,
  type SkillName,
  type SkillReadability,
  type SkillSummary,
} from "./store.js";

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The doctor's public surface, and the one call both consumers make.
 *
 * `src/doctor/` may import `src/config/`, `src/credentials/`, `src/skills/`,
 * `src/integration/` and — since Phase 7-2's ninth check — `src/update/`. The
 * dependency points that way and never back: `src/update/` knows nothing about
 * the doctor. It must **not**
 * import `src/cli/` or `src/web/`: it is a service both of them call, not a
 * command and not a view. `src/cli/doctor.ts` renders the report through
 * `src/output/`, and `src/cli/dashboard.ts` hands {@link runDoctor} to the
 * dashboard as a structurally-typed function so that `src/web/` never imports
 * this package either.
 */

import {
  doctorDefinitions,
  type DoctorCheckOptions,
  type DoctorDependencies,
} from "./checks.js";
import { runDoctorChecks, type DoctorReport } from "./engine.js";

export {
  overallStatus,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorCheckDefinition,
  type DoctorReport,
  type DoctorRunOptions,
  type DoctorStatus,
} from "./engine.js";

export {
  doctorDefinitions,
  DOCTOR_CHECK_IDS,
  MINIMUM_NODE_MAJOR,
  OFFLINE_DOCTOR_CHECK_IDS,
  UPDATE_CHECK_DOCTOR_TIMEOUT_MS,
  type DoctorCheckId,
  type DoctorCheckOptions,
  type DoctorDependencies,
} from "./checks.js";

/**
 * Build the definitions and run them. The whole doctor, in one call.
 *
 * It resolves for every input and never rejects: a check that throws is isolated
 * by the engine, so "produce a report" and "the report is clean" stay two
 * different things. The caller exits 0 on a produced report whatever its status.
 */
export async function runDoctor(
  dependencies: DoctorDependencies,
  options: DoctorCheckOptions,
): Promise<DoctorReport> {
  return runDoctorChecks(doctorDefinitions(dependencies, options), {
    offline: options.offline,
    fix: options.fix,
  });
}

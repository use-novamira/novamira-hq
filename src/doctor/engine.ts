// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The doctor's report shape and its runner.
 *
 * **What the Go did.** `internal/doctor/doctor.go` (213 lines) built a flat
 * `Report` struct — `version`, `binary_on_path`, `config_path`, `config_exists`,
 * `hosting_profiles`, `site_profiles`, `codex_skill`, `bundled_skills_readable`
 * — and a `FormatHuman` that printed it line by line. It had **no severity
 * model**: every field was a value and the operator had to know which values
 * were bad. It had no check identity, so nothing could be referenced in a bug
 * report or asserted on in a script. It had no repair. And half of it —
 * `site_profiles`, `codex_skill` — described features HQ deleted under the
 * boundary rule or with the agent-stub writer.
 *
 * **What HQ does instead, and why not a port.** HQ adopts the check engine shape
 * that `@novamira/cli` already froze in its own v1 contract: an ordered list of
 * `{id, status, summary, evidence}` records with a `pass`/`warn`/`fail` union
 * and a worst-of-members overall status. The point is not novelty, it is that an
 * operator (or an agent) reading `novamira doctor` and `novamira-hq doctor`
 * reads **one vocabulary** across the two tools, and the first four check ids
 * below are deliberately spelled exactly as the site CLI spells them.
 *
 * **Three rules this module exists to guarantee.**
 *
 * 1. *Definitions run sequentially, never concurrently.* Several checks reach
 *    the same `ProfileLockManager` key, and that manager rejects re-entrant
 *    acquisition of a key it already holds — so overlapping them would fail
 *    intermittently rather than run faster. It is the same reason the site CLI's
 *    engine is sequential.
 * 2. *A check that throws is isolated, never fatal.* It becomes a `fail` record
 *    with `evidence: {error: "check_threw"}` and the following checks still run.
 *    The thrown error's **message never reaches the evidence**: it can carry an
 *    absolute path, a provider response or a credential reference, and evidence
 *    is rendered verbatim.
 * 3. *A completed report is a successful invocation.* Exit 0 and `ok: true` even
 *    when the overall status is `warn` or `fail`. Only a failure to *produce* a
 *    report uses the normal typed nonzero contract. This is what makes
 *    `novamira-hq doctor --offline` usable as an installer smoke test on a fresh
 *    machine, where "no profiles configured" and "no site CLI installed" are both
 *    warnings and both entirely normal.
 */

/** Worst first when they are compared; `pass` is the only clean state. */
export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** A frozen, stable identifier. It is part of the contract, not a label. */
  readonly id: string;
  readonly status: DoctorStatus;
  /** One stable sentence. Never interpolates a secret, a path or a message. */
  readonly summary: string;
  /** Output-safe structured detail; rendered verbatim in JSON mode. */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Set by a check that `--fix` actually repaired. */
  readonly fixed?: boolean;
}

export interface DoctorReport {
  readonly version: 1;
  readonly offline: boolean;
  readonly fix: boolean;
  /** The worst member of {@link checks}. */
  readonly status: DoctorStatus;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorCheckDefinition {
  readonly id: string;
  run(): Promise<Omit<DoctorCheck, "id">>;
}

export interface DoctorRunOptions {
  readonly offline: boolean;
  readonly fix: boolean;
}

/**
 * Run every definition in order and assemble the report.
 *
 * Sequential on purpose (see this module's header). It never rejects: a
 * definition that throws produces a failed record and the run continues, so the
 * report an operator gets is always complete.
 */
export async function runDoctorChecks(
  definitions: readonly DoctorCheckDefinition[],
  options: DoctorRunOptions,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  for (const definition of definitions) {
    try {
      checks.push({ id: definition.id, ...(await definition.run()) });
    } catch {
      checks.push({
        id: definition.id,
        status: "fail",
        summary: "The check could not be completed.",
        // Deliberately not the thrown message: it can carry a path, a provider
        // body or a credential reference, and evidence is rendered verbatim.
        evidence: { error: "check_threw" },
      });
    }
  }
  return {
    version: 1,
    offline: options.offline,
    fix: options.fix,
    status: overallStatus(checks),
    checks,
  };
}

export function overallStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

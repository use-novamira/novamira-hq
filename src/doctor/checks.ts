// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The checks themselves: frozen ids, frozen order, output-safe evidence.
 *
 * **What survived from the Go, and what did not.** `internal/doctor/doctor.go`'s
 * `BuildReport` produced eight fields. Four of them are here in a different
 * shape, and four are deleted outright:
 *
 * - `binary_on_path` (doctor.go:189-212) split `PATH` on a hardcoded `":"`/`";"`
 *   looking for `novamira`. **Deleted.** HQ knows its own executable without
 *   searching for it, and the interesting question — "is the *other* CLI usable?"
 *   — is `integration.site_cli` below, answered by `src/integration/`'s real
 *   resolver, which also handles the Windows shim layout a `PATH` walk gets
 *   wrong.
 * - `site_profiles` (doctor.go:41-49, 92-103) went with the schema that fed it.
 *   HQ has no site profiles.
 * - `codex_skill` (doctor.go:51-56, 115-119) went with the agent-stub writer.
 *   `skills.bundled` is the surviving half, and it inspects the **shipped**
 *   bundles rather than a copy in the operator's home.
 * - `config_path` / `config_exists` / `hosting_profiles` /
 *   `bundled_skills_readable` become `config.schema`, `profile.credentials` and
 *   `skills.bundled`, each with a severity instead of a bare value.
 *
 * **The first four ids are the site CLI's, spelled identically.**
 * `runtime.node`, `storage.permissions`, `storage.atomic`, `credential.backend`
 * mean the same thing in both tools, so an operator comparing two reports reads
 * one vocabulary. Order is contractual: the list below is the order the report
 * renders, and a contract test pins it.
 *
 * **Two checks can never be `fail`, and that is a product decision, not a
 * leniency.**
 *
 * - `profile.credentials` warns. One profile whose `env:` variable is not
 *   exported in this shell must not condemn the installation — every other
 *   profile still works, and `--fix` has nothing to do about it.
 * - `integration.site_cli` warns. `@novamira/cli` is an **optional** integration
 *   (`CLAUDE.md`): hosting inventory, actions, provisioning and plugin-installed
 *   status all work without it, and only connected-state detection degrades. A
 *   fresh `npm install -g @novamira/hq` has neither profiles nor the site CLI,
 *   and the installers run `novamira-hq doctor --offline` as their smoke test —
 *   so a `fail` on either would make every first install look broken.
 *
 * **Evidence is output-safe by construction.** `profile.credentials` renders
 * `credentialSource(ref)` — `env:NAME` / `file:PATH` / `stored:ID` — and a
 * boolean; the resolved {@link SecretValue} is discarded on the line that
 * produces it and never enters a record. `storage.permissions` renders *labels*,
 * never directory contents. No check puts a caught error's message anywhere.
 *
 * **`--fix` is deliberately tiny.** It repairs owner-only permissions on HQ's
 * own private paths and creates the state directory. It writes no credential,
 * removes no profile, edits no configuration and calls no provider. Anything
 * larger belongs to an explicit command, not to a diagnostic.
 *
 * **The ninth check landed in 7-2.** `update.available` is last in the list and
 * is the reason `src/doctor/` may import `src/update/` and not the reverse. It
 * is **skipped entirely** under `--offline` — not run and reported "unknown",
 * *absent from `checks`*, because `--offline` promises no network operation and
 * a record of a check that did not happen is noise. It warns and never fails,
 * both when a newer version exists (an out-of-date install still works) and when
 * the registry cannot be reached (an offline laptop is not a broken
 * installation).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { probeAtomicWrite } from "../config/atomic-write.js";
import {
  secureDirectory,
  type VerifiedFileSecurity,
} from "../config/file-security.js";
import type { PlatformPaths } from "../config/paths.js";
import type { ConfigStore } from "../config/profiles.js";
import {
  credentialSource,
  type ConfigDocument,
  type HostingProfile,
} from "../config/schema.js";
import { resolveCredential } from "../credentials/resolve.js";
import type { CredentialStore } from "../credentials/store.js";
import type { ProbeSiteCli } from "../integration/index.js";
import type { SkillStore } from "../skills/index.js";
import type { UpdateChecker } from "../update/index.js";
import type { DoctorCheck, DoctorCheckDefinition } from "./engine.js";

/** The lowest Node major HQ supports; `package.json`'s `engines` in one number. */
export const MINIMUM_NODE_MAJOR = 22;

/** Every check id, in report order. Frozen: these are contract, not labels. */
export const DOCTOR_CHECK_IDS = [
  "runtime.node",
  "storage.permissions",
  "storage.atomic",
  "credential.backend",
  "config.schema",
  "profile.credentials",
  "skills.bundled",
  "integration.site_cli",
  "update.available",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/**
 * The subset that runs under `--offline`: everything but the ninth.
 *
 * Spelled as a derivation rather than a second literal list, so adding a check
 * to {@link DOCTOR_CHECK_IDS} cannot leave this one silently stale.
 */
export const OFFLINE_DOCTOR_CHECK_IDS: readonly DoctorCheckId[] = Object.freeze(
  DOCTOR_CHECK_IDS.filter((id) => id !== "update.available"),
);

/** How long `update.available` waits for the registry. */
export const UPDATE_CHECK_DOCTOR_TIMEOUT_MS = 3_000;

export interface DoctorDependencies {
  readonly paths: PlatformPaths;
  readonly security: VerifiedFileSecurity;
  readonly store: ConfigStore;
  /**
   * Lazy, and only ever called by `credential.backend`. Constructing the store
   * probes the OS keychain, which is a subprocess; the other seven checks must
   * not pay for it.
   */
  readonly credentials: () => Promise<CredentialStore>;
  readonly skills: SkillStore;
  /** `src/integration/`'s probe. The only place HQ runs `novamira`. */
  readonly probeSiteCli: ProbeSiteCli;
  /**
   * Builds `update.available`'s checker, bound to a request deadline.
   *
   * Optional, and its absence is a state rather than a hole: a caller that
   * cannot build one — a contract test, or any future embedder — simply gets
   * the eight-check report, exactly as `--offline` does. It is never called
   * when `options.offline` is true.
   */
  readonly createUpdateChecker?: (timeoutMs: number) => UpdateChecker;
  /** The injected process environment; nothing here reads `process.env`. */
  readonly environment: NodeJS.ProcessEnv;
  /** Injected so a contract test can assert the Node floor without a runtime. */
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface DoctorCheckOptions {
  readonly fix: boolean;
  /** `--offline`: no check may perform a network operation. */
  readonly offline: boolean;
  /** `--profile`: narrows `profile.credentials` to one profile. */
  readonly profile?: string;
}

type CheckResult = Omit<DoctorCheck, "id">;

/* -------------------------------------------------------------------------- */
/* The definition list                                                        */
/* -------------------------------------------------------------------------- */

export function doctorDefinitions(
  dependencies: DoctorDependencies,
  options: DoctorCheckOptions,
): readonly DoctorCheckDefinition[] {
  // One config read for the two checks that need it, memoized as a *settled*
  // outcome rather than a promise so that a parse failure is reported by
  // `config.schema` and merely narrows `profile.credentials` instead of
  // throwing it into the engine's `check_threw` arm twice.
  // Captured once so the ninth definition's closure keeps the narrowing that
  // decided whether to append it at all.
  const updateFactory = dependencies.createUpdateChecker;

  let loaded: Promise<ConfigOutcome> | undefined;
  const configuration = (): Promise<ConfigOutcome> => {
    loaded ??= loadConfig(dependencies.store, dependencies.paths.configFile);
    return loaded;
  };

  return [
    {
      id: "runtime.node",
      run: () =>
        Promise.resolve(
          runtimeCheck(
            dependencies.nodeVersion ?? process.versions.node,
            dependencies.platform ?? process.platform,
            dependencies.arch ?? process.arch,
          ),
        ),
    },
    {
      id: "storage.permissions",
      run: () => permissionCheck(dependencies, options.fix),
    },
    { id: "storage.atomic", run: () => atomicCheck(dependencies, options.fix) },
    {
      id: "credential.backend",
      run: () => credentialBackendCheck(dependencies),
    },
    { id: "config.schema", run: () => schemaCheck(configuration) },
    {
      id: "profile.credentials",
      run: () => profileCredentialCheck(dependencies, options, configuration),
    },
    { id: "skills.bundled", run: () => skillsCheck(dependencies) },
    { id: "integration.site_cli", run: () => siteCliCheck(dependencies) },
    // The ninth is appended, not disabled: under `--offline`, or with no
    // checker factory to build one from, the definition is simply absent and
    // the report has eight rows. A ninth row saying "not checked" would be a
    // record of something that did not happen.
    ...(options.offline || updateFactory === undefined
      ? []
      : [
          {
            id: "update.available",
            run: () => updateCheck(updateFactory),
          } satisfies DoctorCheckDefinition,
        ]),
  ];
}

/* -------------------------------------------------------------------------- */
/* 1: runtime.node                                                            */
/* -------------------------------------------------------------------------- */

function runtimeCheck(
  node: string,
  platform: NodeJS.Platform,
  arch: string,
): CheckResult {
  const evidence = { node, platform, arch, minimumMajor: MINIMUM_NODE_MAJOR };
  const major = Number(node.split(".")[0]);
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE_MAJOR) {
    return {
      status: "fail",
      summary: `Node.js ${String(MINIMUM_NODE_MAJOR)} or newer is required.`,
      evidence,
    };
  }
  return {
    status: "pass",
    summary: "The Node.js runtime is supported.",
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* 2: storage.permissions                                                     */
/* -------------------------------------------------------------------------- */

type TargetKind = "directory" | "file";

interface PermissionTarget {
  readonly label: string;
  readonly kind: TargetKind;
  readonly path: string;
}

interface InspectedTarget {
  readonly label: string;
  readonly kind: TargetKind;
  readonly exists: boolean;
  readonly safe: boolean;
}

/**
 * HQ's own private paths, in a fixed order.
 *
 * `credentials/v1` is enumerated only when it exists, and its records are
 * inspected individually: the fallback backend refuses to read a record whose
 * mode does not verify, so a world-readable one is a real, silent breakage.
 */
async function permissionTargets(
  paths: PlatformPaths,
): Promise<readonly PermissionTarget[]> {
  const fixed: readonly PermissionTarget[] = [
    { label: "config.directory", kind: "directory", path: paths.configDir },
    { label: "config.file", kind: "file", path: paths.configFile },
    { label: "state.directory", kind: "directory", path: paths.stateDir },
    { label: "locks.directory", kind: "directory", path: paths.locksDir },
    {
      label: "credentials.directory",
      kind: "directory",
      path: paths.credentialsDir,
    },
    {
      label: "credentials.v1.directory",
      kind: "directory",
      path: join(paths.credentialsDir, "v1"),
    },
  ];
  const recordsDir = join(paths.credentialsDir, "v1");
  let names: readonly string[];
  try {
    names = await readdir(recordsDir);
  } catch {
    return fixed;
  }
  const records = [...names]
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name): PermissionTarget => ({
      label: "credentials.file",
      kind: "file",
      path: join(recordsDir, name),
    }));
  return [...fixed, ...records];
}

async function inspect(
  target: PermissionTarget,
  security: VerifiedFileSecurity,
): Promise<InspectedTarget> {
  let info;
  try {
    info = await stat(target.path);
  } catch {
    // Not created yet. That is a `warn` for the whole check, never a `fail`: a
    // fresh install has none of these until the first write.
    return {
      label: target.label,
      kind: target.kind,
      exists: false,
      safe: true,
    };
  }
  const typeMatches =
    target.kind === "directory" ? info.isDirectory() : info.isFile();
  if (!typeMatches) {
    return {
      label: target.label,
      kind: target.kind,
      exists: true,
      safe: false,
    };
  }
  let safe: boolean;
  try {
    safe =
      target.kind === "directory"
        ? await security.verifyDirectory(target.path)
        : await security.verifyFile(target.path);
  } catch {
    // A checker that could not run proves nothing, so nothing is proved safe.
    safe = false;
  }
  return { label: target.label, kind: target.kind, exists: true, safe };
}

async function permissionCheck(
  dependencies: DoctorDependencies,
  fix: boolean,
): Promise<CheckResult> {
  const targets = await permissionTargets(dependencies.paths);
  let inspected = await Promise.all(
    targets.map((target) => inspect(target, dependencies.security)),
  );
  let fixed = false;

  if (fix && inspected.some((entry) => entry.exists && !entry.safe)) {
    for (const [index, target] of targets.entries()) {
      const entry = inspected[index];
      if (entry === undefined || !entry.exists || entry.safe) continue;
      try {
        if (target.kind === "directory") {
          await dependencies.security.secureDirectory(target.path);
        } else {
          await dependencies.security.secureFile(target.path);
        }
      } catch {
        // A repair that failed is reported by the re-inspection below, not by
        // an exception: the point of `--fix` is a complete report either way.
      }
    }
    inspected = await Promise.all(
      targets.map((target) => inspect(target, dependencies.security)),
    );
    // `fixed: true` is evidence, not intent: `--fix` was given, a repair was
    // attempted, and the re-inspection proves the relevant condition now
    // passes. Nothing here reports the flag on its own.
    fixed = inspected.every((entry) => !entry.exists || entry.safe);
  }

  const evidence = { targets: inspected };
  const unsafe = inspected.filter((entry) => entry.exists && !entry.safe);
  if (unsafe.length > 0) {
    return {
      status: "fail",
      summary:
        "Private local storage has unsafe ownership, permissions, or file types.",
      evidence,
      ...(fixed ? { fixed: true } : {}),
    };
  }
  if (inspected.every((entry) => !entry.exists)) {
    return {
      status: "warn",
      summary: "Private local storage has not been initialized.",
      evidence,
    };
  }
  return {
    status: "pass",
    summary: fixed
      ? "Private local storage permissions were repaired."
      : "Private local storage permissions are safe.",
    evidence,
    ...(fixed ? { fixed: true } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* 3: storage.atomic                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Can the state directory do the create-temp / fsync / rename dance every write
 * in HQ depends on?
 *
 * It is a real probe, not an inference from the filesystem type: a network
 * share, a container bind mount and a sandboxed path each fail differently, and
 * only trying finds out.
 */
async function atomicCheck(
  dependencies: DoctorDependencies,
  fix: boolean,
): Promise<CheckResult> {
  const stateDir = dependencies.paths.stateDir;
  const evidence = { stateDir };
  let created = false;
  try {
    const info = await stat(stateDir);
    if (!info.isDirectory()) {
      return {
        status: "fail",
        summary: "The state location is not a directory.",
        evidence,
      };
    }
  } catch {
    if (!fix) {
      return {
        status: "warn",
        summary: "The state location has not been initialized.",
        evidence,
      };
    }
    await secureDirectory(stateDir, dependencies.security);
    created = true;
  }

  try {
    await probeAtomicWrite(stateDir);
  } catch {
    return {
      status: "fail",
      summary:
        "The state location does not support the required atomic write pattern.",
      evidence,
    };
  }
  return {
    status: "pass",
    summary: created
      ? "Atomic storage was initialized."
      : "Atomic storage is available.",
    evidence,
    // `fixed: true` only when `--fix` actually changed state by creating the
    // directory; a probe against an already-initialized directory is not a
    // repair performed.
    ...(created ? { fixed: true } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* 4: credential.backend                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which credential backend this machine resolved to.
 *
 * The owner-only file fallback is a `warn` and not a `fail`: it works, it is
 * refused when its permissions are unsafe, and on a headless Linux box with no
 * secret service it is the only thing available. The operator is told, once,
 * that their secrets are not encrypted by an OS service.
 */
async function credentialBackendCheck(
  dependencies: DoctorDependencies,
): Promise<CheckResult> {
  const diagnostic = (await dependencies.credentials()).diagnostic();
  const evidence = {
    backend: diagnostic.backend,
    osBackedEncryption: diagnostic.osBackedEncryption,
    platform: dependencies.platform ?? process.platform,
    ...(diagnostic.warning === undefined
      ? {}
      : { warning: diagnostic.warning }),
  };
  return diagnostic.osBackedEncryption
    ? {
        status: "pass",
        summary: "Provider secrets use an OS-backed credential service.",
        evidence,
      }
    : {
        status: "warn",
        summary: "Provider secrets use the owner-only file fallback.",
        evidence,
      };
}

/* -------------------------------------------------------------------------- */
/* 5: config.schema                                                           */
/* -------------------------------------------------------------------------- */

type ConfigOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "loaded"; readonly document: ConfigDocument };

async function loadConfig(
  store: ConfigStore,
  configFile: string,
): Promise<ConfigOutcome> {
  try {
    await stat(configFile);
  } catch {
    return { kind: "absent" };
  }
  try {
    return { kind: "loaded", document: await store.load() };
  } catch {
    // The message is deliberately dropped: `ConfigStore.load` interpolates the
    // configuration path and the failing JSON pointer into it, and evidence is
    // rendered verbatim.
    return { kind: "invalid" };
  }
}

async function schemaCheck(
  configuration: () => Promise<ConfigOutcome>,
): Promise<CheckResult> {
  const outcome = await configuration();
  if (outcome.kind === "absent") {
    return {
      status: "warn",
      summary: "No configuration file exists yet.",
      evidence: { exists: false },
    };
  }
  if (outcome.kind === "invalid") {
    return {
      status: "fail",
      summary: "The configuration file does not match the v1 schema.",
      evidence: { exists: true, valid: false },
    };
  }
  return {
    status: "pass",
    summary: "The configuration file matches the v1 schema.",
    evidence: {
      exists: true,
      valid: true,
      version: outcome.document.version,
      profileCount: Object.keys(outcome.document.hostingProfiles).length,
      deployPathCount: Object.keys(outcome.document.deployPaths).length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 6: profile.credentials                                                     */
/* -------------------------------------------------------------------------- */

interface ProfileEvidence {
  readonly name: string;
  readonly provider: string;
  /** `env:NAME` / `file:PATH` / `stored:ID`. Never a value. */
  readonly credential: string;
  readonly available: boolean;
  readonly companyIdConfigured: boolean;
  readonly apiBaseUrlConfigured: boolean;
}

/**
 * Go's `credentialAvailable` (doctor.go:164-167) is the one function in that
 * file worth copying: resolve, discard, record the boolean. The resolved
 * {@link SecretValue} goes out of scope on the same line that produced it — it
 * is never stored, never returned, never stringified.
 */
async function credentialResolves(
  profile: HostingProfile,
  dependencies: DoctorDependencies,
): Promise<boolean> {
  try {
    await resolveCredential(profile.credential, {
      env: dependencies.environment,
      security: dependencies.security,
      ...(profile.credential.type === "stored"
        ? { store: await dependencies.credentials() }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

async function profileCredentialCheck(
  dependencies: DoctorDependencies,
  options: DoctorCheckOptions,
  configuration: () => Promise<ConfigOutcome>,
): Promise<CheckResult> {
  const outcome = await configuration();
  if (outcome.kind !== "loaded") {
    return {
      status: "pass",
      summary: "No hosting profiles are configured.",
      evidence: { profiles: [] },
    };
  }
  const requested = options.profile?.trim() ?? "";
  const entries = Object.entries(outcome.document.hostingProfiles)
    .filter(([name]) => requested === "" || name === requested)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return {
      status: "pass",
      summary:
        requested === ""
          ? "No hosting profiles are configured."
          : "The selected hosting profile is not configured.",
      evidence: { profiles: [] },
    };
  }

  const profiles: ProfileEvidence[] = [];
  for (const [name, profile] of entries) {
    profiles.push({
      name,
      provider: profile.provider,
      credential: credentialSource(profile.credential),
      available: await credentialResolves(profile, dependencies),
      companyIdConfigured: profile.companyId !== undefined,
      apiBaseUrlConfigured: profile.apiBaseUrl !== undefined,
    });
  }

  const unresolved = profiles.filter((entry) => !entry.available);
  // Never `fail`: one broken reference must not condemn the installation.
  return unresolved.length > 0
    ? {
        status: "warn",
        summary: "A hosting profile's credential reference does not resolve.",
        evidence: { profiles },
      }
    : {
        status: "pass",
        summary: "Every hosting profile's credential reference resolves.",
        evidence: { profiles },
      };
}

/* -------------------------------------------------------------------------- */
/* 7: skills.bundled                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Go's `BundledSkillsReadable` (skills.go:220-224), with a severity and a list.
 *
 * This is a `fail` and not a `warn` because it can only mean one thing: the
 * installed package is incomplete or was tampered with. Every other check
 * describes the operator's machine; this one describes HQ itself.
 */
async function skillsCheck(
  dependencies: DoctorDependencies,
): Promise<CheckResult> {
  const readable = await dependencies.skills.readable();
  const evidence = {
    core: readable.core,
    hosting: readable.hosting,
    agentStub: readable.agentStub,
    missing: readable.missing,
  };
  return readable.missing.length === 0
    ? {
        status: "pass",
        summary: "The bundled agent skills are readable and intact.",
        evidence,
      }
    : {
        status: "fail",
        summary:
          "A bundled agent skill is missing, empty, or has lost its cross-reference.",
        evidence,
      };
}

/* -------------------------------------------------------------------------- */
/* 8: integration.site_cli                                                    */
/* -------------------------------------------------------------------------- */

const SITE_CLI_SUMMARIES: Readonly<
  Record<"available" | "absent" | "incompatible" | "unreadable", string>
> = {
  available: "The Novamira site CLI is installed and compatible.",
  absent: "The Novamira site CLI is not installed.",
  incompatible: "The installed Novamira site CLI is older than HQ requires.",
  unreadable: "The Novamira site CLI could not be read.",
};

/**
 * The optional integration, and the one check that is structurally incapable of
 * failing the report.
 *
 * Every branch of {@link ProbeSiteCli} is a state — absent, incompatible, timed
 * out, malformed — and every one of them is a `warn`. `CLAUDE.md`: HQ's hosting
 * inventory, actions, provisioning and plugin-installed status all work with
 * `novamira` absent, and only connected-state detection degrades, with an
 * install hint. Anything stronger than a warning here would be false.
 */
async function siteCliCheck(
  dependencies: DoctorDependencies,
): Promise<CheckResult> {
  const probe = await dependencies.probeSiteCli();
  const evidence = {
    resolved: probe.status !== "absent",
    minimum: probe.minimum,
    ...(probe.command === undefined ? {} : { command: probe.command }),
    ...(probe.version === undefined ? {} : { version: probe.version }),
    ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    ...(probe.hint === undefined ? {} : { hint: probe.hint }),
  };
  return {
    status: probe.status === "available" ? "pass" : "warn",
    summary: SITE_CLI_SUMMARIES[probe.status],
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* 9: update.available                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Is a newer `@novamira/hq` published?
 *
 * The only check that touches the network, which is why `--offline` removes it
 * from the list entirely rather than running it and reporting "skipped".
 *
 * It uses {@link UpdateChecker.refresh}, not `check()`: the doctor is a
 * diagnostic, and a diagnostic must not force a registry request that the
 * 24-hour cache says is unnecessary. `refresh()` answers from the cached record
 * when it is fresh and makes at most one request per interval otherwise.
 *
 * **It cannot fail the report.** A newer version is a `warn` — an out-of-date
 * install still works — and an unreachable registry is a `warn` too, because a
 * laptop on a plane is not a broken installation. The evidence carries the
 * registry identity (origin and path, never credentials — `distTagsUrl` refuses
 * a URL that has any) and never the caught error's message.
 */
async function updateCheck(
  createUpdateChecker: (timeoutMs: number) => UpdateChecker,
): Promise<CheckResult> {
  const checker = createUpdateChecker(UPDATE_CHECK_DOCTOR_TIMEOUT_MS);
  const registry = checker.registryIdentity;
  let status;
  try {
    status = await checker.refresh();
  } catch {
    status = undefined;
  }
  if (status === undefined) {
    return {
      status: "warn",
      summary: "The package registry could not be consulted for updates.",
      evidence: { registry },
    };
  }
  const evidence = {
    current: status.current,
    latest: status.latest,
    updateAvailable: status.updateAvailable,
    registry,
    checkedAt: status.checkedAt,
  };
  return status.updateAvailable
    ? {
        status: "warn",
        summary: "A newer Novamira HQ release is published.",
        evidence,
      }
    : {
        status: "pass",
        summary: "Novamira HQ is the latest published release.",
        evidence,
      };
}

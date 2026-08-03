// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `config` command group: hosting provider profiles and the references
 * that say where their credentials live. Ported from
 * `internal/cli/config.go`.
 *
 * Three deliberate departures from the Go source:
 *
 * 1. **No interactive mode.** Go's bare `config` command, `promptCredential`,
 *    `configInteractive` and `interactiveAddHostingProfile` drive a `survey`
 *    TUI. HQ's runtime dependencies are exactly `commander` and the Datastar
 *    SDK, and the local dashboard is the interactive surface, so the prompts
 *    are dropped. Everything they could produce is reachable from flags: the
 *    "use an environment variable" branch is the default, and the "paste a
 *    credential" branch is `--credential-stdin`.
 * 2. **`stored` never means plaintext.** Go's `StoredCredential(value)` wrote
 *    the secret straight into `config.toml`. Here `--credential-stdin` writes
 *    the secret to HQ's credential store (OS keychain, owner-only file
 *    fallback) and `config.json` keeps only the opaque id, with the credential
 *    write and the config write inside one hosting-profile lock so a failed
 *    save rolls the secret back (plan §5.5, decision 9). Removing or replacing
 *    a profile removes the secret it owned, which is what deleting a
 *    plaintext-carrying TOML entry used to do.
 * 3. **`--profile` is the global one.** Go's `config add` registered a local
 *    `--profile` that shadowed the persistent root flag; the v1 contract makes
 *    `--profile` global, so `config add --profile <name>` names the profile
 *    being created and `config show --profile <name>` selects the one shown,
 *    exactly as before, with one flag instead of two.
 *
 * Nothing in this file ever renders a secret: the only description of a
 * credential is `credentialSource()`'s `env:NAME` / `file:PATH` / `stored:ID`.
 */

import type { Command } from "commander";

import { defaultFileSecurity } from "../../config/file-security.js";
import {
  PROVIDER_KINDS,
  credentialSource,
  defaultCredentialEnv,
  envCredential,
  fileCredential,
  serializeConfigDocument,
  storedCredential,
  validateProfileName,
  type CredentialRef,
  type HostingProfile,
  type ProviderKind,
} from "../../config/schema.js";
import {
  createCredentialStore,
  credentialId,
  withCredentialTransaction,
  type CredentialStore,
} from "../../credentials/store.js";
import { CliError } from "../../errors.js";
import type { InvocationWarning } from "../../output/render.js";
import type { CommandDependencies } from "../commands.js";
import { addSecretSourceOptions, requireEnum } from "../flags.js";
import { runLocalCommand, type HostingOptions } from "../hosting-command.js";
import { readSecret, type CommandIo, type SecretSpec } from "../inputs.js";
import type { RenderedResult } from "../print.js";
import type { GlobalOptions } from "../program.js";

/** The subcommand tree this group owns, and the one `program.ts` already has. */
const CONFIG_COMMAND = "config";

/** `--company auto`: validate the credential and adopt the reported scope. */
const COMPANY_AUTO = "auto";

/** `--company none`: store no company/account id at all. */
const COMPANY_NONE = "none";

/** Rendered in place of an unset company id, as in Go's `derefOr`. */
const NOT_SET = "(not set)";

/** Rendered by `config show` for a profile using the provider default URL. */
const DEFAULT_API_BASE_URL = "(default)";

/**
 * The provider credential, for {@link readSecret}'s messages. `prefix` matches
 * the option group `addSecretSourceOptions(command, "credential", ...)`
 * registers, so the three flag names in an error are the three that exist.
 */
const CREDENTIAL_SECRET: SecretSpec = {
  label: "The provider credential",
  prefix: "credential",
};

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** Options of `config add`, beyond the globals. */
interface ConfigAddOptions extends HostingOptions {
  /** `--credential-env <name>`: store an `env` reference to this variable. */
  readonly credentialEnv?: string;
  /** `--credential-stdin`: read the secret and store it in the keychain. */
  readonly credentialStdin?: boolean;
  /** `--credential-file <path>`: store a `file` reference to this path. */
  readonly credentialFile?: string;
  /** `--company <id|auto|none>`; defaults to {@link COMPANY_AUTO}. */
  readonly company?: string;
  /** `--api-base-url <url>`; unset means "use the provider default". */
  readonly apiBaseUrl?: string;
  /** `--force`: replace an existing profile of the same name. */
  readonly force?: boolean;
}

/**
 * Seams this group needs that `CommandDependencies` does not carry yet. Both
 * are optional, so the composition root can pass its `CommandDependencies`
 * unchanged; the credential store is then built on demand, only for the
 * commands that actually touch a secret.
 */
interface ConfigHandlerSeams {
  /** Defaults to `createCommandIo()` inside `runLocalCommand`. */
  readonly io?: CommandIo;
  /** Defaults to a store over `paths.credentialsDir`. */
  readonly credentials?: CredentialStore;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/** One method per `config` subcommand. */
export interface HostingConfigHandlers {
  /** `config add <provider>`. */
  configAdd(provider: string, options: ConfigAddOptions): Promise<void>;
  /** `config list`. */
  configList(options: HostingOptions): Promise<void>;
  /** `config show`, scoped by the global `--profile` when it is given. */
  configShow(options: HostingOptions): Promise<void>;
  /** `config remove <profile>`. */
  configRemove(profile: string, options: HostingOptions): Promise<void>;
}

/** Writes one secret into the credential store, inside the open transaction. */
type SecretWriter = (id: string, secret: string) => Promise<void>;

/** What `config add` will store, and the secret that has to be written first. */
interface CredentialPlan {
  readonly credential: CredentialRef;
  /** Present only for `--credential-stdin`, i.e. only for a `stored` ref. */
  readonly secret?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function createHostingConfigHandlers(
  dependencies: CommandDependencies & ConfigHandlerSeams,
): HostingConfigHandlers {
  const { hosting, paths, store } = dependencies;

  /**
   * The credential store, built at most once and only when a command reaches a
   * `stored` credential. Building it probes the OS keychain, so `config add
   * --credential-env` must not pay for it.
   */
  let pendingCredentials: Promise<CredentialStore> | undefined;
  const credentialStore = async (): Promise<CredentialStore> => {
    if (dependencies.credentials !== undefined) return dependencies.credentials;
    pendingCredentials ??= createCredentialStore(
      paths.credentialsDir,
      defaultFileSecurity(),
    );
    return pendingCredentials;
  };

  /** The backend's own caveat (unencrypted file fallback), as a warning. */
  const backendWarnings = async (): Promise<InvocationWarning[]> => {
    const diagnostic = (await credentialStore()).diagnostic();
    if (diagnostic.warning === undefined) return [];
    return [
      {
        code: "credential_backend",
        message: diagnostic.warning,
        details: { backend: diagnostic.backend },
      },
    ];
  };

  /**
   * Go's `credentialFromArgs`, minus the survey prompt. At most one source may
   * be named; naming none stores an `env` reference to the provider's default
   * variable, which is what Go's `--yes` branch did and what the v1 contract
   * specifies for a credential omitted at profile creation.
   */
  const planCredential = async (
    provider: ProviderKind,
    profileName: string,
    options: ConfigAddOptions,
    io: CommandIo,
  ): Promise<CredentialPlan> => {
    const variable = nonEmpty(options.credentialEnv);
    const path = nonEmpty(options.credentialFile);
    const sources = [
      variable !== undefined,
      options.credentialStdin === true,
      path !== undefined,
    ].filter(Boolean).length;
    if (sources > 1) {
      throw new CliError(
        "usage_error",
        "Specify at most one of --credential-env, --credential-stdin, or --credential-file.",
        { details: { secret: CREDENTIAL_SECRET.prefix } },
      );
    }
    // An `env` or `file` source is a *reference*: the name or the path is
    // recorded and the secret itself is never read here.
    if (variable !== undefined) return { credential: envCredential(variable) };
    if (path !== undefined) return { credential: fileCredential(path) };
    if (options.credentialStdin === true) {
      // The secret exists only in this local; it reaches the credential store
      // and nothing else. It is never rendered, logged, or put in an error.
      const secret = await readSecret({ stdin: true }, CREDENTIAL_SECRET, io);
      return {
        credential: storedCredential(
          credentialId({ provider, profile: profileName }),
        ),
        secret,
      };
    }
    return { credential: envCredential(defaultCredentialEnv(provider)) };
  };

  /**
   * Go's `applyCompanySelection`. `auto` validates the credential against the
   * provider and adopts the account scope it reports; InstaWP and Pressable
   * have no such scope, so their profiles keep none even though the credential
   * is still validated.
   */
  const resolveCompany = async (
    provider: ProviderKind,
    profileName: string,
    credential: CredentialRef,
    apiBaseUrl: string | undefined,
    selection: string,
  ): Promise<string | undefined> => {
    const requested = selection.trim();
    if (requested === COMPANY_NONE || requested === "") return undefined;
    if (requested !== COMPANY_AUTO) return requested;
    const candidate: HostingProfile = {
      provider,
      credential,
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    };
    const client = await hosting.clientFromEntry({
      name: profileName,
      profile: candidate,
    });
    const validation = await client.validate();
    if (provider === "instawp" || provider === "pressable") return undefined;
    return validation.companyId ?? undefined;
  };

  /**
   * Delete a `stored` secret that no profile refers to any more. Best effort:
   * the configuration is already correct, so an unreachable keychain must not
   * fail the command, but it must not pass silently either.
   */
  const forgetSecret = async (
    id: string,
    profileName: string,
    warnings: InvocationWarning[],
  ): Promise<void> => {
    try {
      await (await credentialStore()).delete(id);
    } catch {
      warnings.push({
        code: "credential_orphaned",
        message: `The provider secret previously stored for hosting profile ${profileName} could not be removed.`,
        details: { storedId: id },
      });
    }
  };

  const addProfile = async (
    providerArgument: string,
    options: ConfigAddOptions,
    io: CommandIo,
  ): Promise<RenderedResult> => {
    const provider = requireEnum(providerArgument, "provider", PROVIDER_KINDS);
    const profileName = validateProfileName(
      nonEmpty(options.profile) ?? provider,
    );
    const apiBaseUrl = nonEmpty(options.apiBaseUrl);
    const plan = await planCredential(provider, profileName, options, io);
    const warnings: InvocationWarning[] = [];

    const saved = await store.withHostingProfileLock(profileName, async () => {
      const existing = await store.getHostingProfile(profileName);
      if (existing !== undefined && options.force !== true) {
        throw new CliError(
          "usage_error",
          `Hosting profile ${profileName} already exists; rerun with --force to replace it.`,
          { details: { profile: profileName } },
        );
      }

      // Order matters: the secret has to be readable before `--company auto`
      // can validate it, and the config save has to be last so that a failed
      // validation or a failed save rolls the credential write back.
      const persist = async (
        writeSecret: SecretWriter,
      ): Promise<HostingProfile> => {
        if (plan.secret !== undefined && plan.credential.type === "stored")
          await writeSecret(plan.credential.id, plan.secret);
        const companyId = await resolveCompany(
          provider,
          profileName,
          plan.credential,
          apiBaseUrl,
          options.company ?? COMPANY_AUTO,
        );
        const profile: HostingProfile = {
          provider,
          credential: plan.credential,
          ...(companyId === undefined ? {} : { companyId }),
          ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
        };
        return store.upsertHostingProfileWithProfileLockHeld(
          profileName,
          profile,
        );
      };

      const profile =
        plan.secret === undefined
          ? await persist(unusedSecretWriter)
          : await withCredentialTransaction(
              await credentialStore(),
              async (transaction) =>
                persist(async (id, secret) => transaction.replace(id, secret)),
              {
                onRollbackFailure: (result) => {
                  for (const failure of result.failures) {
                    warnings.push({
                      code: "credential_rollback_failed",
                      message:
                        "A provider secret could not be restored after the configuration save failed.",
                      details: { storedId: failure.id },
                    });
                  }
                },
              },
            );

      // The replaced profile owned its secret, exactly as a plaintext entry in
      // Go's config.toml did; a new id (or a non-stored reference) orphans it.
      const previous = existing?.credential;
      if (
        previous?.type === "stored" &&
        !(
          plan.credential.type === "stored" &&
          plan.credential.id === previous.id
        )
      )
        await forgetSecret(previous.id, profileName, warnings);

      return profile;
    });

    if (plan.secret !== undefined) warnings.push(...(await backendWarnings()));

    const credential = credentialSource(saved.credential);
    const companyId = saved.companyId ?? null;
    return {
      data: {
        profile: profileName,
        provider,
        credential,
        companyId,
        configFile: store.configFile,
      },
      meta: { profile: profileName, provider },
      human: `added profile ${profileName} [${provider}], credential=${credential}, company=${saved.companyId ?? NOT_SET}`,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  const listProfiles = async (): Promise<RenderedResult> => {
    const profiles = (await store.listHostingProfiles()).map((entry) => ({
      name: entry.name,
      provider: entry.profile.provider,
      credential: credentialSource(entry.profile.credential),
      companyId: entry.profile.companyId ?? null,
    }));
    return {
      data: { configFile: store.configFile, profiles },
      human:
        profiles.length === 0
          ? "no profiles configured"
          : profiles
              .map(
                (profile) =>
                  `${profile.name} [${profile.provider}] credential=${profile.credential} company=${profile.companyId ?? NOT_SET}`,
              )
              .join("\n"),
    };
  };

  const showProfile = async (requested: string): Promise<RenderedResult> => {
    const { name, profile } = await store.requireHostingProfile(requested);
    const credential = credentialSource(profile.credential);
    return {
      data: {
        configFile: store.configFile,
        profile: name,
        provider: profile.provider,
        credential,
        companyId: profile.companyId ?? null,
        apiBaseUrl: profile.apiBaseUrl ?? null,
      },
      meta: { profile: name, provider: profile.provider },
      human: [
        `profile = ${name}`,
        `provider = ${profile.provider}`,
        `credential = ${credential}`,
        `company_id = ${profile.companyId ?? NOT_SET}`,
        `api_base_url = ${profile.apiBaseUrl ?? DEFAULT_API_BASE_URL}`,
      ].join("\n"),
    };
  };

  /**
   * Go rendered the whole document as redacted TOML. HQ's configuration is
   * non-secret by construction — a credential is a reference, never a value —
   * so the document is emitted exactly as it is written to disk: sorted keys,
   * stable field order, nothing masked because nothing is secret.
   */
  const showDocument = async (): Promise<RenderedResult> => {
    const rendered = serializeConfigDocument(await store.load());
    return { data: JSON.parse(rendered) as unknown, human: rendered.trimEnd() };
  };

  const removeProfile = async (requested: string): Promise<RenderedResult> => {
    const profileName = validateProfileName(requested);
    const warnings: InvocationWarning[] = [];
    const removed = await store.withHostingProfileLock(
      profileName,
      async () => {
        const profile =
          await store.removeHostingProfileWithProfileLockHeld(profileName);
        // The profile is gone, so its secret has no owner left. Deleting after
        // the save means a failed save leaves the secret in place.
        if (profile.credential.type === "stored")
          await forgetSecret(profile.credential.id, profileName, warnings);
        return profile;
      },
    );
    return {
      data: { profile: profileName, configFile: store.configFile },
      meta: { profile: profileName, provider: removed.provider },
      human: `removed profile ${profileName}`,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  };

  return {
    configAdd: async (provider, options) =>
      runLocalCommand(dependencies, options, ({ io }) =>
        addProfile(provider, options, io),
      ),

    configList: async (options) =>
      runLocalCommand(dependencies, options, listProfiles),

    configShow: async (options) =>
      runLocalCommand(dependencies, options, async () => {
        const requested = nonEmpty(options.profile);
        return requested === undefined
          ? showDocument()
          : showProfile(requested);
      }),

    configRemove: async (profile, options) =>
      runLocalCommand(dependencies, options, async () =>
        removeProfile(profile),
      ),
  };
}

/** Unreachable: only passed when there is no secret to write. */
const unusedSecretWriter: SecretWriter = () =>
  Promise.reject(
    new CliError(
      "internal_error",
      "No credential transaction is active for this profile.",
    ),
  );

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `config` command to attach to. `program.ts` already creates it for
 * `config path`, so this group extends that command rather than shadowing it;
 * passing the `config` command itself works too.
 */
function configCommand(parent: Command): Command {
  if (parent.name() === CONFIG_COMMAND) return parent;
  const existing = parent.commands.find(
    (command) => command.name() === CONFIG_COMMAND,
  );
  return (
    existing ??
    parent
      .command(CONFIG_COMMAND)
      .description("manage hosting provider profiles")
  );
}

export function registerHostingConfigCommands(
  parent: Command,
  handlers: HostingConfigHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const config = configCommand(parent);

  // `--profile` is global, so the globals already carry every option these
  // handlers read beyond the ones registered here.
  const hostingOptions = (values: readonly unknown[]): HostingOptions =>
    optionsFor(values);

  const add = config
    .command("add")
    .description("add a hosting profile")
    .argument("<provider>", `hosting provider (${PROVIDER_KINDS.join(", ")})`)
    .option(
      "--company <id>",
      `provider company or account id, "${COMPANY_AUTO}" to detect it, or "${COMPANY_NONE}"`,
      COMPANY_AUTO,
    )
    .option("--api-base-url <url>", "override the provider API base URL")
    .option("--force", "replace an existing profile of the same name", false);
  addSecretSourceOptions(
    add,
    CREDENTIAL_SECRET.prefix,
    "the provider credential",
  );
  add.action(
    async (
      provider: string,
      options: Omit<ConfigAddOptions, keyof HostingOptions>,
      command: Command,
    ) =>
      handlers.configAdd(provider, {
        ...hostingOptions([command]),
        ...options,
      }),
  );

  config
    .command("list")
    .description("list hosting profiles")
    .action(async (...values: unknown[]) =>
      handlers.configList(hostingOptions(values)),
    );

  config
    .command("show")
    .description(
      "show the configuration, or one hosting profile with --profile",
    )
    .action(async (...values: unknown[]) =>
      handlers.configShow(hostingOptions(values)),
    );

  config
    .command("remove")
    .description("remove a hosting profile")
    .argument("<profile>", "hosting profile name")
    .action(async (profile: string, ...values: unknown[]) =>
      handlers.configRemove(profile, hostingOptions(values)),
    );
}

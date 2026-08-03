// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting access ssh …` and `hosting access sftp …`, ported from
 * `internal/cli/access.go`.
 *
 * The Go file was thirteen `cobra.Command` literals, each one repeating the
 * same `selectedClient(flags)` preamble and each one printing for itself. Here
 * the grammar (bottom half of the file) and the work (top half) are separate,
 * exactly as `program.ts` and `commands.ts` are separate: the grammar knows the
 * flags, the handlers know the provider requests, and neither one writes to a
 * stream — {@link runHostingCommand} renders every result through the single
 * v1 envelope.
 *
 * Four deliberate departures from the Go source, all of them narrowing what the
 * CLI will send to a provider:
 *
 * 1. Go declared `--env`, `--site`, `--interval` and `--secret-out` as plain
 *    `StringVar`s defaulting to `""`, so omitting one produced a request against
 *    a URL with an empty path segment (or, for `--secret-out`, an `os.OpenFile`
 *    error on the path `""`). Every one of those values is required by the
 *    request it feeds, so it goes through {@link requireOption} and an omission
 *    is a `usage_error` naming the flag.
 * 2. `--enabled` gains a `--no-enabled` counterpart. cobra's `BoolVar` accepted
 *    `--enabled=false`; commander's flags do not, and these three commands are
 *    the only way to *disable* SSH, SSH passwords and SFTP, so the negation has
 *    to stay reachable.
 * 3. `ssh password` reported a response without `environment.sftp_password` as
 *    a bare `fmt.Errorf`; here it is a `provider_error`, which the taxonomy
 *    already maps to exit 4.
 * 4. The secret `ssh password` writes is never echoed, exactly as in Go: the
 *    envelope carries the path and a fixed mask ({@link renderSecretWrite}), and
 *    the password itself only ever exists between the provider response and the
 *    owner-only file.
 *
 * `access sftp add` takes its password by reference only — `--password-env`,
 * `--password-stdin` or `--password-file` — because a secret in argv is visible
 * in the process table. There is no bare `--password`, and there must never be.
 */

import type { Command } from "commander";

import { CliError } from "../../errors.js";
import {
  addFromJsonOption,
  addSecretSourceOptions,
  collect,
} from "../flags.js";
import type { HostingCommandDependencies } from "../hosting-command.js";
import { runHostingCommand, type HostingOptions } from "../hosting-command.js";
import { jsonPointerLookupString, requireOption } from "../inputs.js";
import {
  DEFAULT_SFTP_PERMISSION,
  DEFAULT_SFTP_ROOT_DIRECTORY,
  sftpAddPayload,
  sshAllowlistPayload,
  type SftpAddOptions,
  type SshAllowlistSetOptions,
} from "../payloads.js";
import { renderAction, renderRaw, renderSecretWrite } from "../print.js";
import type { GlobalOptions } from "../program.js";

/** The JSON pointer Go read the generated SFTP/SSH password out of. */
const SSH_PASSWORD_POINTER = "/environment/sftp_password";

/* -------------------------------------------------------------------------- */
/* Parsed options                                                             */
/* -------------------------------------------------------------------------- */

/** `--env`, the only option of the four single-environment read commands. */
interface AccessEnvOptions {
  readonly env?: string;
}

/** `--env` plus the `--enabled` / `--no-enabled` toggle. */
interface AccessToggleOptions extends AccessEnvOptions {
  readonly enabled?: boolean;
}

interface SshSetAllowlistOptions
  extends AccessEnvOptions, SshAllowlistSetOptions {}

interface SshConfigOptions extends AccessEnvOptions {
  readonly site?: string;
}

interface SshPasswordOptions extends AccessEnvOptions {
  readonly secretOut?: string;
}

interface SshChangeExpirationOptions extends AccessEnvOptions {
  readonly interval?: string;
}

interface SftpAddCommandOptions extends AccessEnvOptions, SftpAddOptions {}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One method per `hosting access` subcommand. Each takes the options commander
 * parsed for that subcommand, plus the global options the invocation carries
 * (`--json`, `--profile`, …).
 */
export interface AccessHandlers {
  sshStatus(values: AccessEnvOptions, options: HostingOptions): Promise<void>;
  sshSetStatus(
    values: AccessToggleOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshAllowlist(
    values: AccessEnvOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshSetAllowlist(
    values: SshSetAllowlistOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshConfig(values: SshConfigOptions, options: HostingOptions): Promise<void>;
  sshGeneratePassword(
    values: AccessEnvOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshPassword(
    values: SshPasswordOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshSetPasswordStatus(
    values: AccessToggleOptions,
    options: HostingOptions,
  ): Promise<void>;
  sshChangeExpiration(
    values: SshChangeExpirationOptions,
    options: HostingOptions,
  ): Promise<void>;
  sftpList(values: AccessEnvOptions, options: HostingOptions): Promise<void>;
  sftpToggle(
    values: AccessToggleOptions,
    options: HostingOptions,
  ): Promise<void>;
  sftpAdd(
    values: SftpAddCommandOptions,
    options: HostingOptions,
  ): Promise<void>;
  /** `remove` takes a positional account id and has no options of its own. */
  sftpRemove(sftpAccountId: string, options: HostingOptions): Promise<void>;
}

/** cobra's `ExactArgs(1)` accepted `""`; the provider request never can. */
function requireArgument(value: string, name: string): string {
  if (value === "") {
    throw new CliError("usage_error", `<${name}> is required.`, {
      details: { argument: name },
    });
  }
  return value;
}

/** Go's `BoolVar(..., false)`: an absent toggle means "disable". */
function enabled(values: AccessToggleOptions): boolean {
  return values.enabled ?? false;
}

/** The `--password-*` group, as {@link sftpAddPayload}'s optional members. */
function sftpAddOptions(values: SftpAddCommandOptions): SftpAddOptions {
  return {
    ...(values.fromJson === undefined ? {} : { fromJson: values.fromJson }),
    ...(values.username === undefined ? {} : { username: values.username }),
    ...(values.passwordEnv === undefined
      ? {}
      : { passwordEnv: values.passwordEnv }),
    ...(values.passwordStdin === undefined
      ? {}
      : { passwordStdin: values.passwordStdin }),
    ...(values.passwordFile === undefined
      ? {}
      : { passwordFile: values.passwordFile }),
    ...(values.rootDirectory === undefined
      ? {}
      : { rootDirectory: values.rootDirectory }),
    ...(values.permission === undefined
      ? {}
      : { permission: values.permission }),
  };
}

export function createAccessHandlers(
  dependencies: HostingCommandDependencies,
): AccessHandlers {
  return {
    sshStatus: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "ssh-status",
            envId: requireOption(values.env, "--env"),
          }),
        ),
      ),

    sshSetStatus: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "set-ssh-status",
            envId: requireOption(values.env, "--env"),
            body: { is_enabled: enabled(values) },
          }),
        ),
      ),

    sshAllowlist: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "ssh-allowlist",
            envId: requireOption(values.env, "--env"),
          }),
        ),
      ),

    sshSetAllowlist: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireOption(values.env, "--env");
        const body = await sshAllowlistPayload(
          {
            ...(values.fromJson === undefined
              ? {}
              : { fromJson: values.fromJson }),
            ...(values.ip === undefined ? {} : { ip: values.ip }),
          },
          io,
        );
        return renderAction(
          await client.action({ kind: "set-ssh-allowlist", envId, body }),
        );
      }),

    sshConfig: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "ssh-config",
            siteId: requireOption(values.site, "--site"),
            envId: requireOption(values.env, "--env"),
          }),
        ),
      ),

    sshGeneratePassword: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "generate-ssh-password",
            envId: requireOption(values.env, "--env"),
          }),
        ),
      ),

    sshPassword: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireOption(values.env, "--env");
        const secretOut = requireOption(values.secretOut, "--secret-out");
        const value = await client.read({ kind: "ssh-password", envId });
        const password = jsonPointerLookupString(value, SSH_PASSWORD_POINTER);
        if (password === undefined) {
          throw new CliError(
            "provider_error",
            "The provider response did not include environment.sftp_password.",
            { details: { provider: client.provider, envId } },
          );
        }
        await io.writePrivateFile(secretOut, password);
        return renderSecretWrite(secretOut);
      }),

    sshSetPasswordStatus: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "set-ssh-password-status",
            envId: requireOption(values.env, "--env"),
            body: { is_enabled: enabled(values) },
          }),
        ),
      ),

    sshChangeExpiration: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "change-ssh-password-expiration",
            envId: requireOption(values.env, "--env"),
            body: {
              exp_interval: requireOption(values.interval, "--interval"),
            },
          }),
        ),
      ),

    sftpList: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "sftp-accounts",
            envId: requireOption(values.env, "--env"),
          }),
        ),
      ),

    sftpToggle: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "toggle-sftp-accounts",
            envId: requireOption(values.env, "--env"),
            body: { enabled: enabled(values) },
          }),
        ),
      ),

    sftpAdd: (values, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireOption(values.env, "--env");
        const body = await sftpAddPayload(sftpAddOptions(values), io);
        return renderAction(
          await client.action({ kind: "add-sftp-account", envId, body }),
        );
      }),

    sftpRemove: (sftpAccountId, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderAction(
          await client.action({
            kind: "remove-sftp-account",
            sftpAccountId: requireArgument(sftpAccountId, "sftp_account_id"),
          }),
        ),
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/** `--env <id>`: every access command but `sftp remove` names an environment. */
function addEnvOption(command: Command): Command {
  return command.option("--env <id>", "environment id");
}

/**
 * Go's `BoolVar(&enabled, "enabled", false, "")`, plus the negation cobra got
 * for free from `--enabled=false`. Declaring `--enabled` first keeps the
 * default `false`, so an invocation with neither flag behaves as Go did.
 */
function addEnabledOption(command: Command, subject: string): Command {
  return command
    .option("--enabled", `enable ${subject}`, false)
    .option("--no-enabled", `disable ${subject}`);
}

export function registerAccessCommands(
  parent: Command,
  handlers: AccessHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const access = parent
    .command("access")
    .description("SSH and SFTP access operations");

  const ssh = access.command("ssh").description("SSH access operations");

  addEnvOption(ssh.command("status").description("show the SSH status")).action(
    async (values: AccessEnvOptions, ...rest: unknown[]) =>
      handlers.sshStatus(values, optionsFor(rest)),
  );

  addEnabledOption(
    addEnvOption(
      ssh.command("set-status").description("enable or disable SSH access"),
    ),
    "SSH access",
  ).action(async (values: AccessToggleOptions, ...rest: unknown[]) =>
    handlers.sshSetStatus(values, optionsFor(rest)),
  );

  addEnvOption(
    ssh.command("allowlist").description("show the SSH IP allowlist"),
  ).action(async (values: AccessEnvOptions, ...rest: unknown[]) =>
    handlers.sshAllowlist(values, optionsFor(rest)),
  );

  addFromJsonOption(
    addEnvOption(
      ssh.command("set-allowlist").description("replace the SSH IP allowlist"),
    ),
  )
    .option(
      "--ip <address>",
      "allowlisted IP address (repeatable)",
      collect,
      [],
    )
    .action(async (values: SshSetAllowlistOptions, ...rest: unknown[]) =>
      handlers.sshSetAllowlist(values, optionsFor(rest)),
    );

  addEnvOption(ssh.command("config").description("show the SSH connection"))
    .option("--site <id>", "site id")
    .action(async (values: SshConfigOptions, ...rest: unknown[]) =>
      handlers.sshConfig(values, optionsFor(rest)),
    );

  addEnvOption(
    ssh.command("generate-password").description("generate a new SSH password"),
  ).action(async (values: AccessEnvOptions, ...rest: unknown[]) =>
    handlers.sshGeneratePassword(values, optionsFor(rest)),
  );

  addEnvOption(
    ssh
      .command("password")
      .description("write the SSH password to an owner-only file"),
  )
    .option("--secret-out <path>", "file the secret is written to")
    .action(async (values: SshPasswordOptions, ...rest: unknown[]) =>
      handlers.sshPassword(values, optionsFor(rest)),
    );

  addEnabledOption(
    addEnvOption(
      ssh
        .command("set-password-status")
        .description("enable or disable SSH password authentication"),
    ),
    "SSH password authentication",
  ).action(async (values: AccessToggleOptions, ...rest: unknown[]) =>
    handlers.sshSetPasswordStatus(values, optionsFor(rest)),
  );

  addEnvOption(
    ssh
      .command("change-expiration")
      .description("change the SSH password expiration interval"),
  )
    .option("--interval <interval>", "password expiration interval")
    .action(async (values: SshChangeExpirationOptions, ...rest: unknown[]) =>
      handlers.sshChangeExpiration(values, optionsFor(rest)),
    );

  const sftp = access.command("sftp").description("SFTP access operations");

  addEnvOption(
    sftp.command("list").description("list the additional SFTP accounts"),
  ).action(async (values: AccessEnvOptions, ...rest: unknown[]) =>
    handlers.sftpList(values, optionsFor(rest)),
  );

  addEnabledOption(
    addEnvOption(
      sftp
        .command("toggle")
        .description("enable or disable the additional SFTP accounts"),
    ),
    "the additional SFTP accounts",
  ).action(async (values: AccessToggleOptions, ...rest: unknown[]) =>
    handlers.sftpToggle(values, optionsFor(rest)),
  );

  addSecretSourceOptions(
    addFromJsonOption(
      addEnvOption(
        sftp.command("add").description("add an additional SFTP account"),
      ),
    ).option("--username <name>", "SFTP account username"),
    "password",
    "the SFTP password",
  )
    .option(
      "--root-directory <path>",
      "directory the account is confined to",
      DEFAULT_SFTP_ROOT_DIRECTORY,
    )
    .option(
      "--permission <permission>",
      "access level granted to the account",
      DEFAULT_SFTP_PERMISSION,
    )
    .action(async (values: SftpAddCommandOptions, ...rest: unknown[]) =>
      handlers.sftpAdd(values, optionsFor(rest)),
    );

  sftp
    .command("remove")
    .description("remove an additional SFTP account")
    .argument("<sftp_account_id>", "SFTP account id")
    .action(async (sftpAccountId: string, ...rest: unknown[]) =>
      handlers.sftpRemove(sftpAccountId, optionsFor(rest)),
    );
}

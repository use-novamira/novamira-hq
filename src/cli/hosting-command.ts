// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The execution shell every hosting command handler runs inside, ported from
 * Go's `selectedProfile` / `selectedClient` in `internal/cli/print.go` and the
 * polling loop in `internal/cli/wp_install.go`.
 *
 * Go rebuilt the whole world per command: `selectedClient` re-resolved the
 * config path, re-read `config.toml` and re-constructed a provider client on
 * every invocation, and each `RunE` then repeated the same
 * `client, err := ...; if err != nil { return err }` preamble ~110 times. HQ
 * injects the already-built store and client factory (`main.ts` builds exactly
 * one of each per process) and gives the command groups a single
 * {@link runHostingCommand} wrapper that resolves the profile, builds the
 * client, runs the body and renders the result through the one envelope.
 *
 * `--profile` is a global option in the v1 contract, so it is read off
 * {@link HostingOptions} rather than registered here; the Phase 4 integration
 * step adds it to `program.ts` alongside the other globals. A profile is never
 * inferred: `ConfigStore.selectHostingProfile` raises `usage_error` with the
 * configured names under `details.profiles` when none was given.
 */

import type { ConfigStore, HostingProfileEntry } from "../config/profiles.js";
import type { ProviderClient } from "../hosting/client.js";
import type { HostingClientFactory } from "../hosting/factory.js";
import type { Renderer } from "../output/render.js";
import { createCommandIo, type CommandIo } from "./inputs.js";
import type { RenderedResult } from "./print.js";
import type { GlobalOptions } from "./program.js";

/**
 * The globals a hosting command sees. `profile` is optional in the type because
 * commander only supplies it once `--profile` is registered; every command that
 * needs one goes through {@link runHostingCommand}, which fails closed.
 */
export interface HostingOptions extends GlobalOptions {
  /** `--profile <name>`: the hosting profile to operate through. */
  readonly profile?: string;
}

/**
 * What a hosting handler needs from the composition root. `CommandDependencies`
 * in `commands.ts` already satisfies this structurally, so the integration step
 * passes it straight through.
 */
export interface HostingCommandDependencies {
  readonly store: ConfigStore;
  readonly hosting: HostingClientFactory;
  /** Defaults to a `CommandIo` over `process.env` and real stdin. */
  readonly io?: CommandIo;
  rendererFor(options: GlobalOptions): Renderer;
}

/** Everything a command body is handed. */
export interface HostingCommandContext {
  readonly client: ProviderClient;
  /** The resolved hosting profile, name and document. */
  readonly entry: HostingProfileEntry;
  readonly options: HostingOptions;
  readonly renderer: Renderer;
  readonly io: CommandIo;
}

/** A command body: do the work, describe the result, render nothing. */
export type HostingCommandBody = (
  context: HostingCommandContext,
) => Promise<RenderedResult> | RenderedResult;

/** A command body that needs no provider client (local-only commands). */
export type LocalCommandBody = (context: {
  readonly options: HostingOptions;
  readonly renderer: Renderer;
  readonly io: CommandIo;
}) => Promise<RenderedResult> | RenderedResult;

function ioFor(dependencies: HostingCommandDependencies): CommandIo {
  return dependencies.io ?? createCommandIo();
}

/** Resolve the selected profile and build its provider client. */
export async function resolveHostingClient(
  dependencies: HostingCommandDependencies,
  options: HostingOptions,
): Promise<{
  readonly client: ProviderClient;
  readonly entry: HostingProfileEntry;
}> {
  const entry = await dependencies.store.selectHostingProfile(options.profile);
  return { client: await dependencies.hosting.clientFromEntry(entry), entry };
}

/**
 * Run a command that needs a provider client. `meta.profile` and
 * `meta.provider` are filled in from the resolved profile, so every hosting
 * envelope says which profile and provider produced it without each of the
 * ~110 handlers remembering to.
 */
export async function runHostingCommand(
  dependencies: HostingCommandDependencies,
  options: HostingOptions,
  body: HostingCommandBody,
): Promise<void> {
  const renderer = dependencies.rendererFor(options);
  const io = ioFor(dependencies);
  const { client, entry } = await resolveHostingClient(dependencies, options);
  const result = await body({ client, entry, options, renderer, io });
  renderer.success(result.data, {
    meta: {
      profile: entry.name,
      provider: client.provider,
      ...result.meta,
    },
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    ...(result.human === undefined ? {} : { human: result.human }),
  });
}

/** Run a command that touches no provider. */
export async function runLocalCommand(
  dependencies: HostingCommandDependencies,
  options: HostingOptions,
  body: LocalCommandBody,
): Promise<void> {
  const renderer = dependencies.rendererFor(options);
  const result = await body({ options, renderer, io: ioFor(dependencies) });
  renderer.success(result.data, {
    ...(result.meta === undefined ? {} : { meta: result.meta }),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    ...(result.human === undefined ? {} : { human: result.human }),
  });
}

/* -------------------------------------------------------------------------- */
/* Long-running provider operations                                           */
/* -------------------------------------------------------------------------- */

/**
 * Operation polling moved to `src/hosting/operations.ts`: it is provider
 * machinery, not CLI grammar, and `src/provisioning/` needs it without
 * importing `src/cli/`. Re-exported here so every existing caller — and
 * `test/cli-foundations-contract.test.mjs` — keeps working unchanged.
 */
export {
  operationFailure,
  waitForOperationStatus,
  type WaitForOperationOptions,
} from "../hosting/operations.js";

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hosting command tree, assembled from the seven groups that were ported
 * from Go's `internal/cli` one file at a time.
 *
 * Each group owns three exports — a handler interface, a factory over
 * `CommandDependencies`, and a `register*Commands(parent, handlers, optionsFor)`
 * that attaches its own subcommands to whatever parent it is given. This module
 * is the only place that decides what those parents are, so `program.ts` keeps
 * knowing only the grammar and `commands.ts` keeps knowing only the wiring.
 *
 * Two placement rules matter and are the reason this file exists rather than
 * seven calls inlined into `program.ts`:
 *
 * - every hosting group hangs off one `hosting` command created here exactly
 *   once, because commander would otherwise reject the second `hosting`;
 * - the hosting-profile group extends the **existing** top-level `config`
 *   command instead of creating a second one, so `config path` — registered in
 *   `program.ts` and covered by its contract test — keeps its name, its place
 *   and its output.
 *
 * The handler interfaces are intersected rather than nested. Every method name
 * across the seven groups is distinct, so one flat object satisfies all of them,
 * `CommandHandlers` stays a flat interface, and a test can still hand
 * `createProgram` a single recording double.
 */

import type { Command } from "commander";

import type { CommandDependencies } from "../commands.js";
import type { GlobalOptions } from "../program.js";
import {
  createAccessHandlers,
  registerAccessCommands,
  type AccessHandlers,
} from "./access.js";
import {
  createHostingConfigHandlers,
  registerHostingConfigCommands,
  type HostingConfigHandlers,
} from "./config.js";
import {
  createDomainsHandlers,
  registerDomainsCommands,
  type DomainsHandlers,
} from "./domains.js";
import {
  createHostingInventoryHandlers,
  registerHostingInventoryCommands,
  type HostingInventoryHandlers,
} from "./inventory.js";
import {
  createMaintenanceHandlers,
  registerMaintenanceCommands,
  type MaintenanceHandlers,
} from "./maintenance.js";
import {
  createSitesHandlers,
  registerSitesCommands,
  type SitesHandlers,
} from "./sites.js";
import { createWpHandlers, registerWpCommands, type WpHandlers } from "./wp.js";

/** The parent every provider-facing group hangs off. */
export const HOSTING_COMMAND = "hosting";

/**
 * Every hosting handler the program can dispatch to, as one flat object. The
 * seven groups' method names are disjoint by construction; a collision would
 * be a compile error here rather than a silently shadowed command.
 */
export type HostingCommandHandlers = HostingInventoryHandlers &
  SitesHandlers &
  DomainsHandlers &
  MaintenanceHandlers &
  WpHandlers &
  AccessHandlers &
  HostingConfigHandlers;

/**
 * Build every group's handlers over the one set of dependencies the
 * composition root assembled. `CommandDependencies` satisfies each group's
 * narrower requirement structurally, so nothing is adapted on the way in.
 */
export function createHostingCommandHandlers(
  dependencies: CommandDependencies,
): HostingCommandHandlers {
  return {
    ...createHostingInventoryHandlers(dependencies),
    ...createSitesHandlers(dependencies),
    ...createDomainsHandlers(dependencies),
    ...createMaintenanceHandlers(dependencies),
    ...createWpHandlers(dependencies),
    ...createAccessHandlers(dependencies),
    ...createHostingConfigHandlers(dependencies),
  };
}

/**
 * Attach the whole hosting surface to `program`.
 *
 * `optionsFor` is `program.ts`'s own reader, so a subcommand's options are
 * merged over the globals exactly once, in one place, for all ~100 commands.
 */
export function registerHostingCommands(
  program: Command,
  handlers: HostingCommandHandlers,
  optionsFor: (values: readonly unknown[]) => GlobalOptions,
): void {
  const hosting = program
    .command(HOSTING_COMMAND)
    .description("operate hosting provider resources");

  registerHostingInventoryCommands(hosting, handlers, optionsFor);
  registerSitesCommands(hosting, handlers, optionsFor);
  registerDomainsCommands(hosting, handlers, optionsFor);
  registerMaintenanceCommands(hosting, handlers, optionsFor);
  registerWpCommands(hosting, handlers, optionsFor);
  registerAccessCommands(hosting, handlers, optionsFor);

  // Hosting *profiles* are local configuration, not a provider resource, so
  // they extend the existing top-level `config` command rather than living
  // under `hosting`. `registerHostingConfigCommands` reuses that command.
  registerHostingConfigCommands(program, handlers, optionsFor);
}

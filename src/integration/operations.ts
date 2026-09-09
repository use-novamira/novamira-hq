// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import { redact } from "../output/redact.js";
import { isSiteProfileName } from "../site-profiles.js";
import { type ResolveSiteCli } from "./resolve.js";
import { parseEnvelope, parseSitesList, siteCliChildEnv } from "./site-cli.js";
import { siteOperationArgs } from "./site-cli.js";
import { type SpawnChild } from "./spawn.js";

export type SiteOperation =
  | { readonly kind: "list" }
  | { readonly kind: "doctor" | "discover"; readonly site: string }
  | {
      readonly kind: "describe";
      readonly site: string;
      readonly ability: string;
    }
  | { readonly kind: "skill"; readonly site: string; readonly slug: string }
  | {
      readonly kind: "run";
      readonly site: string;
      readonly ability: string;
      readonly input: unknown;
      readonly approveDestructive: boolean;
    };

export interface SiteOperations {
  execute(operation: SiteOperation): Promise<unknown>;
}

/** CLI-only delegation. No local file arguments, site HTTP, credentials or retries. */
export function createSiteOperations(options: {
  readonly resolve: ResolveSiteCli;
  readonly spawn: SpawnChild;
  readonly environment: NodeJS.ProcessEnv;
}): SiteOperations {
  return {
    async execute(operation) {
      if (operation.kind !== "list" && !isSiteProfileName(operation.site))
        throw new CliError(
          "usage_error",
          "Choose an explicit valid Novamira site profile.",
        );
      const identifier =
        operation.kind === "describe" || operation.kind === "run"
          ? operation.ability
          : operation.kind === "skill"
            ? operation.slug
            : undefined;
      if (
        identifier !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(identifier)
      )
        throw new CliError(
          "usage_error",
          "Invalid Ability name or skill slug.",
        );
      const input =
        operation.kind === "run" ? JSON.stringify(operation.input) : undefined;
      if (
        operation.kind === "run" &&
        (input === undefined || Buffer.byteLength(input) > 262144)
      )
        throw new CliError(
          "usage_error",
          "Ability input must be JSON within 256 KiB.",
        );
      const resolved = await options.resolve();
      if (!resolved)
        throw new CliError(
          "not_found",
          "Novamira CLI is not installed. Install @novamira/cli to manage WordPress sites; hosting tools remain available.",
        );
      const outcome = await options.spawn({
        command: resolved.command,
        args: [...resolved.prefixArgs, ...siteOperationArgs(operation)],
        env: siteCliChildEnv(options.environment),
        timeoutMs: 35000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 32768,
        signal: AbortSignal.timeout(35000),
        ...(input === undefined ? {} : { input }),
      });
      const uncertain = operation.kind === "run";
      const fail = (message: string): never => {
        throw new CliError(
          "provider_error",
          message +
            (uncertain
              ? " The operation may have executed. Verify the site with a read-only operation before repeating it."
              : ""),
          { retryable: false },
        );
      };
      if (outcome.kind !== "exited")
        return fail("Novamira CLI did not return a complete result.");
      const envelope = parseEnvelope(outcome.stdout);
      if (envelope.ok === "malformed")
        return fail("Novamira CLI returned an invalid response.");
      if (!envelope.ok) {
        const hint =
          envelope.code === "server_unsupported"
            ? "Check the site's Novamira version and AI Abilities. No reinstall or activation was attempted."
            : envelope.code === "confirmation_required"
              ? "Destructive execution requires explicit approval for this operation."
              : envelope.code === "usage_error"
                ? "The installed Novamira CLI may be incompatible; check its version."
                : "Check the selected site's connection and run the Novamira site doctor.";
        return fail(hint);
      }
      if (outcome.code !== 0)
        return fail("Novamira CLI exited unsuccessfully.");
      if (operation.kind === "list") {
        const profiles = parseSitesList(envelope.data);
        if (!profiles)
          return fail("Novamira CLI returned an invalid site list.");
        return profiles.map(({ name, siteUrl, origin }) => ({
          name,
          siteUrl,
          origin,
        }));
      }
      return {
        site: operation.site,
        untrustedSiteData: true,
        data: redact(envelope.data),
      };
    },
  };
}

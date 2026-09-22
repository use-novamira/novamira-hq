// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `hosting domains …` and `hosting dns …`, ported from `newDomainsCommand` and
 * `newDnsCommand` in `internal/cli/hosting.go`.
 *
 * The group is small and entirely mechanical: every subcommand resolves the
 * selected profile, dispatches exactly one `ProviderClient` request, and renders
 * the result. Go repeated the `client, err := selectedClient(flags)` preamble in
 * each of the ten `RunE` bodies and printed from inside them; here
 * {@link runHostingCommand} owns the preamble and the envelope, the payload
 * builders in `../payloads.js` own the request bodies, and the bodies below only
 * say which request to send.
 *
 * Three deliberate differences from the Go original:
 *
 * 1. Go declared `--setup-type` as a free string and called `validateEnum`
 *    inside `RunE`, so an invalid value was only rejected after every other flag
 *    had been parsed. Here `oneOf(DOMAIN_SETUP_TYPES)` runs during commander's
 *    own parse, which both narrows the option's type and reports the failure as
 *    a usage error before anything else runs.
 * 2. Go passed the resource identifiers (`--env`, `--domain`) straight through
 *    even when empty, so `domains list` with no `--env` reached the provider as
 *    a request against an empty path segment and came back as a 404. HQ refuses
 *    the invocation up front with `usage_error` — see {@link requireIdentifier}.
 *    These identifiers name a path segment rather than a body field, so they
 *    stay required even when `--from-json` supplies the body. The check lives in
 *    the handler rather than in `requiredOption` so that the failure is a
 *    `CliError` from the shared taxonomy, with the flag under `details`.
 * 3. `dns domains list --company` keeps Go's `optStr` semantics: an empty or
 *    absent value means "the profile's configured company", so the member is
 *    omitted rather than sent as `""`.
 */

import { Command } from "commander";

import { CliError } from "../../errors.js";
import type { CommandDependencies } from "../commands.js";
import { addFromJsonOption, oneOf } from "../flags.js";
import { runHostingCommand, type HostingOptions } from "../hosting-command.js";
import {
  DOMAIN_SETUP_TYPES,
  domainAddPayload,
  domainPrimaryPayload,
  type DomainAddOptions,
  type DomainPrimaryOptions,
} from "../payloads.js";
import { renderAction, renderRaw } from "../print.js";
import type { GlobalOptions } from "../program.js";

/* -------------------------------------------------------------------------- */
/* Command inputs                                                             */
/* -------------------------------------------------------------------------- */

/** `hosting domains list`. */
export interface DomainsListInput {
  readonly env?: string;
}

/** `hosting domains add`; `--env` names the request path, not the body. */
export interface DomainsAddInput extends DomainAddOptions {
  readonly env?: string;
}

/** `hosting domains primary`. */
export interface DomainsPrimaryInput extends DomainPrimaryOptions {
  readonly env?: string;
}

/** `hosting dns domains list`. */
export interface DnsDomainsListInput {
  readonly company?: string;
}

/** `hosting dns records list`. */
export interface DnsRecordsListInput {
  readonly domain?: string;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/** One method per subcommand of `hosting domains` and `hosting dns`. */
export interface DomainsHandlers {
  domainsList(input: DomainsListInput, options: HostingOptions): Promise<void>;
  domainsAdd(input: DomainsAddInput, options: HostingOptions): Promise<void>;
  domainsVerify(siteDomainId: string, options: HostingOptions): Promise<void>;
  domainsPrimary(
    input: DomainsPrimaryInput,
    options: HostingOptions,
  ): Promise<void>;
  dnsDomainsList(
    input: DnsDomainsListInput,
    options: HostingOptions,
  ): Promise<void>;
  dnsRecordsList(
    input: DnsRecordsListInput,
    options: HostingOptions,
  ): Promise<void>;
}

/**
 * A resource identifier that becomes part of the provider request path. Unlike
 * `requireOption` in `../inputs.js` this one is not satisfiable by
 * `--from-json`, so the message does not offer that escape hatch.
 */
function requireIdentifier(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new CliError("usage_error", `${flag} is required.`, {
      details: { flag },
    });
  }
  return value;
}

export function createDomainsHandlers(
  dependencies: CommandDependencies,
): DomainsHandlers {
  return {
    domainsList: (input, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "site-domains",
            envId: requireIdentifier(input.env, "--env"),
          }),
        ),
      ),

    domainsAdd: (input, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireIdentifier(input.env, "--env");
        const body = await domainAddPayload(input, io);
        return renderAction(
          await client.action({ kind: "add-domain", envId, body }),
        );
      }),

    domainsVerify: (siteDomainId, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "site-domain-verification",
            siteDomainId: requireIdentifier(siteDomainId, "<site_domain_id>"),
          }),
        ),
      ),

    domainsPrimary: (input, options) =>
      runHostingCommand(dependencies, options, async ({ client, io }) => {
        const envId = requireIdentifier(input.env, "--env");
        const body = await domainPrimaryPayload(input, io);
        return renderAction(
          await client.action({ kind: "change-primary-domain", envId, body }),
        );
      }),

    dnsDomainsList: (input, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "dns-domains",
            // Go's `optStr`: empty means "the profile's company", not "".
            ...(input.company === undefined || input.company === ""
              ? {}
              : { companyId: input.company }),
          }),
        ),
      ),

    dnsRecordsList: (input, options) =>
      runHostingCommand(dependencies, options, async ({ client }) =>
        renderRaw(
          await client.read({
            kind: "dns-records",
            domainId: requireIdentifier(input.domain, "--domain"),
          }),
        ),
      ),
  };
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                    */
/* -------------------------------------------------------------------------- */

/** `program.ts`'s global-option resolver, threaded through registration. */
type OptionsFor = (values: readonly unknown[]) => GlobalOptions;

/**
 * Attach `domains` and `dns` to `parent` — the `hosting` command during
 * integration, a throwaway `Command` in the contract test.
 *
 * Commander calls an action handler with the parsed arguments, then the parsed
 * options of the command itself, then the command; `optionsFor([command])`
 * turns that last one back into the globals, since it resolves options with
 * `optsWithGlobals` and therefore walks up to the program on its own.
 */
export function registerDomainsCommands(
  parent: Command,
  handlers: DomainsHandlers,
  optionsFor: OptionsFor,
): void {
  registerDomains(parent, handlers, optionsFor);
  registerDns(parent, handlers, optionsFor);
}

function registerDomains(
  parent: Command,
  handlers: DomainsHandlers,
  optionsFor: OptionsFor,
): void {
  const domains = parent
    .command("domains")
    .description("domain operations on a hosting environment");

  domains
    .command("list")
    .description("list the domains of an environment")
    .option("--env <id>", "environment id")
    .action(async (input: DomainsListInput, command: Command) =>
      handlers.domainsList(input, optionsFor([command])),
    );

  const add = domains
    .command("add")
    .description("add a domain to an environment")
    .option("--env <id>", "environment id")
    .option("--domain-name <name>", "domain name to add")
    .option("--is-wildcardless", "add the domain without a wildcard", false)
    .option("--add-with-www-subdomain", "also add the www subdomain", false)
    .option(
      "--setup-type <type>",
      `domain setup mode (${DOMAIN_SETUP_TYPES.join("|")})`,
      oneOf(DOMAIN_SETUP_TYPES),
    )
    .option("--custom-ssl-key-file <path>", "path of a custom SSL private key")
    .option(
      "--custom-ssl-cert-file <path>",
      "path of a custom SSL certificate",
    );
  addFromJsonOption(add).action(
    async (input: DomainsAddInput, command: Command) =>
      handlers.domainsAdd(input, optionsFor([command])),
  );

  domains
    .command("verify")
    .description("read the verification status of a site domain")
    .argument("<site_domain_id>", "site domain id")
    .action(async (siteDomainId: string, input: unknown, command: Command) =>
      handlers.domainsVerify(siteDomainId, optionsFor([command])),
    );

  const primary = domains
    .command("primary")
    .description("change the primary domain of an environment")
    .option("--env <id>", "environment id")
    .option("--domain-id <id>", "domain id to promote")
    .option(
      "--search-replace",
      "run a search and replace after the change",
      false,
    );
  addFromJsonOption(primary).action(
    async (input: DomainsPrimaryInput, command: Command) =>
      handlers.domainsPrimary(input, optionsFor([command])),
  );
}

function registerDns(
  parent: Command,
  handlers: DomainsHandlers,
  optionsFor: OptionsFor,
): void {
  const dns = parent.command("dns").description("DNS operations");

  const dnsDomains = dns
    .command("domains")
    .description("DNS domain operations");
  dnsDomains
    .command("list")
    .description("list the DNS domains of a company")
    .option("--company <id>", "company id; defaults to the profile's company")
    .action(async (input: DnsDomainsListInput, command: Command) =>
      handlers.dnsDomainsList(input, optionsFor([command])),
    );

  const records = dns.command("records").description("DNS record operations");

  records
    .command("list")
    .description("list the DNS records of a domain")
    .option("--domain <id>", "DNS domain id")
    .action(async (input: DnsRecordsListInput, command: Command) =>
      handlers.dnsRecordsList(input, optionsFor([command])),
    );
}

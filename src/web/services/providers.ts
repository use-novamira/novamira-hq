// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider-profile mutation for the dashboard: upsert, remove, validate, and the
 * process-lifetime "last checked" map.
 *
 * **What the Go did.** `upsertProvider` (`server.go:1334-1386`) took the
 * server's one `sync.Mutex`, loaded the config, wrote the profile — with the
 * credential **value in plaintext, inside `config.toml`**, via
 * `config.StoredCredential(req.CredentialValue)` — saved, and cleared the sites
 * cache. `removeProvider` (`:1388-1404`) did the same in reverse. There was no
 * credential store, no rollback, and no locking beyond that one process mutex.
 *
 * **What HQ does instead.** The secret never touches `config.json`. It goes to
 * `src/credentials/`, which fronts the OS keychain with an owner-only file
 * fallback, and the configuration records a `stored:<id>` *reference*. The
 * ordering is the one `src/cli/hosting/config.ts:296-300` documents and is not
 * negotiable:
 *
 * > write the secret first, save the config last, so a failed save rolls the
 * > credential write back.
 *
 * `withCredentialTransaction` provides the rollback; the whole sequence runs
 * inside `store.withHostingProfileLock(name)`, so the credential write and the
 * config write are one critical section and two dashboard requests for the same
 * profile queue instead of interleaving.
 *
 * **It reimplements nothing from `src/cli/hosting/config.ts`, and must not
 * import it** — `src/web/` may not import `src/cli/`. What it shares is the
 * ordering rule above and the `forgetSecret` behaviour: an orphaned `stored`
 * record is deleted best-effort, and a failure to delete it becomes a warning
 * the caller can show, never a failed save. The configuration is already correct
 * at that point; an unreachable keychain must not undo it, but it must not pass
 * in silence either.
 *
 * **`lastChecked` is deliberately not persisted.** It is a plain `Map`, exactly
 * Go's `s.lastChecked` (`server.go:44-46`). An operator who restarts the
 * dashboard has not verified anything, and a stamp restored from disk would make
 * the connection cell claim a success that no longer means anything. See
 * `views/types.ts` for why a stamp implies success and the failure path
 * deliberately does not record one.
 *
 * **`onMutated` flushes the sites cache.** It is called after every successful
 * upsert and remove, and `server.ts` wires it to `services/sites.ts`'s
 * `invalidate()` — Go's `clearSitesCacheLocked` (`server.go:1384`), on the same
 * two events. Without it a removed profile would keep answering the Sites page
 * from a warm cache for up to five minutes. It stays optional so this service
 * can be constructed in a test with no sites service in the graph.
 */

import type { ConfigStore } from "../../config/profiles.js";
import {
  defaultCredentialEnv,
  envCredential,
  isProviderKind,
  storedCredential,
  validateProfileName,
  PROVIDER_KINDS,
  type CredentialRef,
  type HostingProfile,
  type ProviderKind,
} from "../../config/schema.js";
import {
  credentialId,
  withCredentialTransaction,
  type CredentialStore,
} from "../../credentials/store.js";
import { CliError } from "../../errors.js";
import { applyHqCapabilityPolicy } from "../../hosting/capabilities.js";
import type { HostingClientFactory } from "../../hosting/factory.js";
import type { ProviderValidation } from "../../hosting/types.js";
import type { ProviderFormInput } from "../signals-input.js";

/** What a mutation did, plus anything non-fatal that went wrong doing it. */
export interface ProviderMutation {
  readonly name: string;
  /**
   * A fixed, non-secret sentence about a best-effort step that failed — today,
   * only an orphaned stored credential. It is shown as a `warn` notice; it is
   * never an error, because the configuration change succeeded.
   */
  readonly warning?: string;
}

export interface ProviderService {
  upsert(input: ProviderFormInput): Promise<ProviderMutation>;
  remove(name: string): Promise<ProviderMutation>;
  /** A **live provider API call**. Tests inject a registry or a mock origin. */
  validate(
    name: string,
    includeCapabilities?: boolean,
  ): Promise<ProviderValidation & { readonly capabilities?: unknown }>;
  /**
   * The provider's capability document with HQ-excluded operations omitted.
   *
   * Also a **live provider API call**. It lives here rather than in the
   * diagnostics handler so that `handlers/` never touches
   * `HostingClientFactory` directly: a handler is a pure request-to-response
   * function, and the layer that resolves a profile into a client is the
   * services layer. The visibility filter is the same rule `hosting providers
   * capabilities` applies, from the same module, so the two surfaces cannot
   * disagree about what HQ can do.
   */
  capabilities(name: string): Promise<unknown>;
  recordChecked(name: string, millis: number): void;
  clearChecked(name: string): void;
  lastChecked(name: string): number | null;
}

export interface ProviderServiceOptions {
  readonly store: ConfigStore;
  readonly hosting: HostingClientFactory;
  /** Lazy: building the credential store probes the OS keychain. */
  readonly credentials: () => Promise<CredentialStore>;
  /** Called after a successful upsert or remove; 6b-2 passes the cache flush. */
  readonly onMutated?: () => void;
}

const ORPHANED_SECRET_WARNING =
  "The provider secret previously stored for this hosting profile could not be removed.";

function requireProviderKind(value: string): ProviderKind {
  if (!isProviderKind(value)) {
    throw new CliError(
      "usage_error",
      `"${value}" is not a supported hosting provider.`,
      { details: { providers: [...PROVIDER_KINDS] } },
    );
  }
  return value;
}

/** The `stored` id a credential reference points at, or `undefined`. */
function storedIdOf(credential: CredentialRef | undefined): string | undefined {
  return credential?.type === "stored" ? credential.id : undefined;
}

export function createProviderService(
  options: ProviderServiceOptions,
): ProviderService {
  const checked = new Map<string, number>();

  /**
   * Delete a `stored` record no profile refers to any more. Best effort: the
   * configuration is already saved and correct.
   */
  const forgetSecret = async (id: string): Promise<boolean> => {
    try {
      await (await options.credentials()).delete(id);
      return true;
    } catch {
      return false;
    }
  };

  const upsert = async (
    input: ProviderFormInput,
  ): Promise<ProviderMutation> => {
    const name = validateProfileName(input.profile);
    const provider = requireProviderKind(input.provider);

    const outcome = await options.store.withHostingProfileLock(
      name,
      async (): Promise<{
        readonly previousStoredId: string | undefined;
        readonly nextStoredId: string | undefined;
      }> => {
        const existing = await options.store.getHostingProfile(name);
        if (existing !== undefined && !input.force) {
          // Go's wording, kept verbatim (`server.go:1352`): it names the control
          // that resolves the conflict rather than a flag the dashboard has no
          // field for.
          throw new CliError(
            "conflict",
            `A hosting provider named "${name}" already exists. Open it in Edit to change it.`,
            { details: { profile: name } },
          );
        }

        // Go's credential precedence (`server.go:1355-1362`), unchanged: a typed
        // secret wins, then a named environment variable, then — only for a new
        // profile — the provider's default variable, and otherwise whatever the
        // profile already had. A submission that leaves the credential field
        // empty must not clear an existing credential.
        let credential: CredentialRef;
        let secret: string | undefined;
        if (input.credentialValue !== "") {
          credential = storedCredential(
            credentialId({ provider, profile: name }),
          );
          secret = input.credentialValue;
        } else if (input.credentialEnv !== "") {
          credential = envCredential(input.credentialEnv);
        } else if (existing === undefined) {
          credential = envCredential(defaultCredentialEnv(provider));
        } else {
          credential = existing.credential;
        }

        // A departure from Go, which persisted `kind.DefaultAPIBaseURL()`
        // whenever the form omitted one (`server.go:1369-1371`). HQ's
        // `profileApiBaseUrl` already falls back at *read* time, so writing the
        // default only freezes today's endpoint into an operator's config file
        // and turns a future provider migration into a manual edit. Go's real
        // requirement — that omitting the field does not erase a custom base URL
        // — is preserved by the `existing.apiBaseUrl` fallback.
        const apiBaseUrl =
          input.apiBaseUrl !== "" ? input.apiBaseUrl : existing?.apiBaseUrl;
        const companyId = input.companyId !== "" ? input.companyId : undefined;

        const profile: HostingProfile = {
          provider,
          credential,
          ...(companyId === undefined ? {} : { companyId }),
          ...(apiBaseUrl === undefined || apiBaseUrl === ""
            ? {}
            : { apiBaseUrl }),
        };

        const previousStoredId = storedIdOf(existing?.credential);
        const nextStoredId = storedIdOf(credential);

        const saveConfig = async (): Promise<void> => {
          await options.store.upsertHostingProfileWithProfileLockHeld(
            name,
            profile,
          );
        };

        if (secret === undefined || nextStoredId === undefined) {
          // No secret travelled: nothing to roll back, so no transaction. The
          // credential store is not even constructed, which keeps a profile
          // pointing at an environment variable from touching the keychain.
          await saveConfig();
        } else {
          const id = nextStoredId;
          const value = secret;
          await withCredentialTransaction(
            await options.credentials(),
            async (transaction) => {
              // Secret first, config last: a failed save rolls the write back.
              await transaction.replace(id, value);
              await saveConfig();
            },
          );
        }
        return { previousStoredId, nextStoredId };
      },
    );

    options.onMutated?.();

    // Outside the lock: the config is saved, and this is cleanup. Go had no
    // equivalent because it stored the plaintext in the config file itself.
    if (
      outcome.previousStoredId !== undefined &&
      outcome.previousStoredId !== outcome.nextStoredId &&
      !(await forgetSecret(outcome.previousStoredId))
    ) {
      return { name, warning: ORPHANED_SECRET_WARNING };
    }
    return { name };
  };

  const remove = async (name: string): Promise<ProviderMutation> => {
    const key = validateProfileName(name);
    const removed = await options.store.withHostingProfileLock(key, () =>
      options.store.removeHostingProfileWithProfileLockHeld(key),
    );
    // Go silently left `s.lastChecked[profile]` in place, so re-creating a
    // profile with the same name inherited a "Connected" pill from a credential
    // that no longer existed (`server.go:280-282` cleared it; the equivalent is
    // here so the two can never be done in one place and not the other).
    checked.delete(key);
    options.onMutated?.();

    const storedId = storedIdOf(removed.credential);
    if (storedId !== undefined && !(await forgetSecret(storedId))) {
      return { name: key, warning: ORPHANED_SECRET_WARNING };
    }
    return { name: key };
  };

  return {
    upsert,
    remove,
    validate: async (name, includeCapabilities = false) => {
      const client = await options.hosting.clientFromProfile(name);
      const validation = await client.validate();
      if (!includeCapabilities) return validation;
      // Reuse the validated client: describing the account must not resolve its
      // credential a second time. A missing catalog does not undo validation.
      try {
        return {
          ...validation,
          capabilities: applyHqCapabilityPolicy(
            await client.read({ kind: "capabilities" }),
          ),
        };
      } catch {
        return validation;
      }
    },
    capabilities: async (name) => {
      const client = await options.hosting.clientFromProfile(name);
      return applyHqCapabilityPolicy(
        await client.read({ kind: "capabilities" }),
      );
    },
    recordChecked: (name, millis) => {
      checked.set(name, millis);
    },
    clearChecked: (name) => {
      checked.delete(name);
    },
    lastChecked: (name) => checked.get(name) ?? null,
  };
}

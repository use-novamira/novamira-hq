// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `POST /_dashboard/connect` — connect one WordPress environment to Novamira.
 *
 * **There is no Go original, and that is the point.** Go's dashboard "connected"
 * a site by posting a URL and an Application Password to
 * `/_dashboard/sites/save`: it called the site's REST API to *create* the
 * password, wrote the credential into its own config as a `site_profiles` entry,
 * and thereafter spoke to the site on the operator's behalf. Every one of those
 * steps is deleted under the boundary rule. HQ holds no WordPress token, makes
 * no request to a configured site, and has no site profiles.
 *
 * **What HQ does instead** (plan §6, decision 3). It spawns the site CLI and
 * gets out of the way: `novamira auth login <url>`, no shell, an argv array, the
 * **non-secret URL as the only argument**, no `--name`. The child owns the
 * browser launch, the OAuth callback and the credential write; HQ observes only
 * whether the child's v1 envelope said `ok`. The spawn itself lives in
 * `src/integration/connect.ts`, because `CLAUDE.md` makes that package the only
 * place HQ runs `novamira` — this handler never touches a child process.
 *
 * **The URL is normalized before it can reach an argv array.** `?url=` goes
 * through `normalizeSiteUrl` from `src/provisioning/site-url.ts`, the same
 * normalizer `hosting novamira setup` uses: it refuses userinfo, a query string,
 * a fragment and a non-loopback `http://` origin, and it never echoes the raw
 * value into an error. A rejected URL is a `usage_error` toast and **nothing is
 * spawned**.
 *
 * **Child output never reaches the page.** {@link ConnectOutcome}'s failure arm
 * carries an `UnavailableReason` and has nowhere to put a string, so the toast
 * can only ever show `unavailableHint(reason)` — a fixed sentence from a closed
 * set. The copyable command the operator needs when that sentence says "install
 * the site CLI" is already in the Connect button's `title`.
 *
 * **On success the route refreshes connection state and nothing else.** It
 * re-reads the **warm** sites cache — no provider call, because logging in did
 * not change the inventory — and re-runs the connected-state round over the same
 * groups, then sends the sites page's three fragments. The cache key comes from
 * `?profile=` and `?include_envs=`, which the Connect button carries, so the
 * repaint is of the listing the operator is looking at rather than of a guess.
 * When that entry has expired there is nothing warm to repaint and the handler
 * sends the toast alone; the next Refresh will re-list. Fetching it here instead
 * would turn one click into a fan-out across every hosting API.
 */

import { asCliError } from "../../errors.js";
import { unavailableHint } from "../../connection-state.js";
import { normalizeSiteUrl } from "../../provisioning/index.js";
import { patchToast } from "../patch.js";
import { readSignals } from "../request.js";
import type { DashboardResponse } from "../responses.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { patchSites } from "./sites.js";
import type { DashboardNotice } from "../views/types.js";

function danger(message: string): DashboardNotice {
  return { level: "danger", message };
}

export function createConnectHandler(context: RouteContext): RouteHandler {
  return (request): DashboardResponse => ({
    kind: "sse",
    run: async (stream) => {
      try {
        // Read past the body for the same reason the provider routes do: an
        // unparseable body is a client that is not the dashboard's own page.
        // Nothing in it is used — the target is a query parameter.
        await readSignals(request);

        // `normalizeSiteUrl` throws `usage_error` on anything the site CLI
        // would refuse, and it does that *before* the value can become an argv
        // element. It also never puts the raw string in the error.
        const site = normalizeSiteUrl(
          request.query.get("url") ?? "",
          context.environment,
          "--url",
        );

        const outcome = await context.integration.connect(site.siteUrl);
        if (outcome.kind === "failed") {
          // A fixed sentence from a closed set. No child output, ever.
          patchToast(stream, danger(unavailableHint(outcome.reason)));
        } else {
          const options = {
            profile: (request.query.get("profile") ?? "").trim(),
            includeEnvs: request.query.get("include_envs") !== "false",
            refresh: false,
          };
          const warm =
            options.profile === ""
              ? undefined
              : await context.sites.refreshWarm(
                  options.profile,
                  options.includeEnvs,
                );
          const connected: DashboardNotice = {
            level: "ok",
            message: `Connected. ${site.siteUrl}`,
          };
          if (warm === undefined) {
            // Nothing warm to repaint: say so with the toast and leave the
            // stale listing alone rather than fanning out across the providers.
            patchToast(stream, connected);
          } else {
            patchSites(stream, options, warm, connected);
          }
        }
      } catch (error) {
        const cliError = asCliError(error);
        context.onDiagnostic?.("dashboard", {
          path: "/_dashboard/connect",
          code: cliError.code,
        });
        patchToast(stream, danger(cliError.message));
      }
      stream.close();
    },
  });
}

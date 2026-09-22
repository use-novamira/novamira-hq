// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

/** Exercise the shipped child, never import its implementation or real credentials. */
export async function verifySiteCli(
  command,
  prefixArgs,
  home,
  version,
  runtime,
) {
  const environment = {
    ...process.env,
    PATH:
      process.platform === "win32"
        ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`
        : "",
    DENO_DIR: join(home, "empty-runtime-cache"),
    NOVAMIRA_HQ_SITE_CLI: "",
    NOVAMIRA_HQ_HOME: join(home, "hq"),
    NOVAMIRA_HOME: join(home, "site"),
    NOVAMIRA_CREDENTIAL_BACKEND: "file",
    NOVAMIRA_ALLOW_INSECURE_HTTP: "1",
    NOVAMIRA_HQ_UPDATE_CHECK: "0",
    NOVAMIRA_REGISTRY: "http://127.0.0.1:1",
  };
  let authorization;
  const run = (args, expected = 0, input) =>
    new Promise((resolve, reject) => {
      let browser;
      const child = execFile(
        command,
        [...prefixArgs, ...args],
        {
          cwd: home,
          env: environment,
          timeout: 60_000,
          maxBuffer: 1_048_576,
        },
        (error, stdout, stderr) => {
          void (async () => {
            await browser;
            assert.equal(error?.code ?? 0, expected, stderr || stdout);
            assert.doesNotMatch(
              stdout,
              /acceptance-access-token|acceptance-refresh-token/,
            );
            resolve(stdout);
          })().catch(reject);
        },
      );
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
        const match = diagnostics.match(
          /http:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s]+/,
        );
        if (match && !browser)
          browser = globalThis
            .fetch(match[0])
            .then((response) => assert.equal(response.status, 200));
        // Observe rejection immediately; the completion callback reports it.
        browser?.catch(() => undefined);
      });
      child.stdin.end(input);
    });
  assert.equal((await run(["--version"])).trim(), version);
  const guide = JSON.parse(
    await run(["guide", "get", "core", "--full", "--json"]),
  );
  assert.ok(guide.data.content.length > 1_000);
  assert.ok(guide.data.references.length > 0);
  assert.match(await run(["update", "--json"], 2), /Update Novamira HQ/);
  assert.match(
    await run(["update", "--check", "--json"], 2),
    /Update Novamira HQ/,
  );

  const compatibility = {
    plugin_version: "1.11.1",
    rest_api_version: 1,
    wordpress_version: "6.9.2",
    minimum_wordpress_version: "6.9",
    features: {
      abilities_bearer_auth: true,
      agent_context: true,
      rest_skills: true,
      generalized_execution_shim: true,
    },
  };
  const ability = {
    name: "novamira/read-value",
    meta: {
      show_in_rest: true,
      annotations: { readonly: true, destructive: false, idempotent: true },
    },
  };
  let revoked = false;
  let serverFailure;
  const server = createServer((request, response) => {
    void (async () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      let body = "";
      for await (const chunk of request) body += chunk;
      const send = (data) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(data));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return send({
          resource: `${origin}/wp-json/mcp/novamira-oauth`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["mcp"],
          novamira: compatibility,
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return send({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
        });
      if (url.pathname === "/register")
        return send({
          client_id: "acceptance-client",
          redirect_uris: JSON.parse(body).redirect_uris,
          token_endpoint_auth_method: "none",
        });
      if (url.pathname === "/authorize") {
        authorization = url;
        assert.equal(url.searchParams.get("scope"), "mcp");
        const callback = new URL(url.searchParams.get("redirect_uri"));
        assert.equal(callback.hostname, "127.0.0.1");
        callback.searchParams.set("state", url.searchParams.get("state"));
        callback.searchParams.set("code", "acceptance-code");
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(body);
        assert.equal(form.get("code"), "acceptance-code");
        assert.equal(
          createHash("sha256")
            .update(form.get("code_verifier"))
            .digest("base64url"),
          authorization.searchParams.get("code_challenge"),
        );
        return send({
          access_token: "acceptance-access-token",
          refresh_token: "acceptance-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "mcp",
        });
      }
      if (url.pathname === "/revoke") {
        revoked = true;
        return send(null);
      }
      assert.equal(
        request.headers.authorization,
        "Bearer acceptance-access-token",
      );
      if (url.pathname.endsWith("/wp-abilities/v1/abilities")) {
        response.setHeader("x-wp-totalpages", "1");
        return send([ability]);
      }
      if (url.pathname.endsWith("/novamira/agent-context/run"))
        return send({
          server: compatibility,
          instructions: "Mock site",
          skills: [],
        });
      if (url.pathname.endsWith("/novamira/read-value")) return send(ability);
      if (url.pathname.endsWith("/novamira/read-value/run"))
        return send({ value: JSON.parse(body).input.value });
      throw new Error(`Unexpected mocked request ${url.pathname}`);
    })().catch((error) => {
      serverFailure = error;
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal(
      JSON.parse(
        await run([
          "auth",
          "login",
          origin,
          "--name",
          "acceptance",
          "--no-open",
          "--json",
        ]),
      ).ok,
      true,
    );
    const profiles = JSON.parse(await run(["sites", "list", "--json"]));
    assert.equal(profiles.data[0].name, "acceptance");
    const report = JSON.parse(await run(["doctor", "--offline", "--json"]));
    assert.ok(
      report.data.checks.some((check) => check.id === `runtime.${runtime}`),
    );
    await run(["sites", "rename", "acceptance", "renamed", "--json"]);
    const result = JSON.parse(
      await run(
        [
          "--site",
          "renamed",
          "run",
          "novamira/read-value",
          "--input",
          "-",
          "--json",
        ],
        0,
        '{"value":"stdin worked"}',
      ),
    );
    assert.equal(result.data.value, "stdin worked");
    await run(["--site", "renamed", "auth", "logout", "--json"]);
    assert.equal(revoked, true);
    await run(["sites", "remove", "renamed", "--json"]);
    assert.deepEqual(
      JSON.parse(await run(["sites", "list", "--json"])).data,
      [],
    );
    if (serverFailure) throw serverFailure;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

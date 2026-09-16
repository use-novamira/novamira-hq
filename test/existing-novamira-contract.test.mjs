// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectExistingNovamira,
  EXISTING_NOVAMIRA_COMMAND,
  EXISTING_AI_COMMAND,
  EXISTING_AI_DOMAIN_COMMAND,
} from "../dist/provisioning/existing.js";

function fixture(plugins, options = []) {
  const calls = [];
  return {
    calls,
    provider: "kinsta",
    action: async (request) => {
      const command = request.body.wp_command;
      calls.push(command);
      assert.match(command, /^[A-Za-z0-9 '_./:=\-]+$/);
      assert.ok(
        [
          EXISTING_NOVAMIRA_COMMAND,
          EXISTING_AI_COMMAND,
          EXISTING_AI_DOMAIN_COMMAND,
        ].includes(command),
      );
      return {
        provider: "kinsta",
        action: "wp-cli.run",
        status: 200,
        raw: {
          data: {
            result: JSON.stringify(
              command === EXISTING_NOVAMIRA_COMMAND
                ? plugins
                : options.filter((option) =>
                    command.includes(`--search=${option.option_name} `),
                  ),
            ),
          },
        },
      };
    },
  };
}
const budget = { intervalSeconds: 1, timeoutSeconds: 10 };

test("absent Novamira is distinguished from an existing installation", async () => {
  const client = fixture([]);
  assert.equal(await inspectExistingNovamira(client, "env", budget), undefined);
  assert.deepEqual(client.calls, [EXISTING_NOVAMIRA_COMMAND]);
});

test("old or unverifiable Novamira stops after read-only inspection", async () => {
  for (const version of ["1.0.0", "unknown", ""]) {
    const client = fixture([{ name: "novamira", version, status: "active" }]);
    await assert.rejects(inspectExistingNovamira(client, "env", budget), {
      code: "server_unsupported",
    });
    assert.deepEqual(client.calls, [EXISTING_NOVAMIRA_COMMAND]);
  }
});

test("existing abilities are read without changing either option", async () => {
  for (const enabled of ["0", "1"]) {
    const client = fixture(
      [{ name: "novamira", version: "1.11.1", status: "active" }],
      [
        { option_name: "novamira_ai_abilities_enabled", option_value: enabled },
        {
          option_name: "novamira_ai_abilities_domain",
          option_value: "example.test",
        },
      ],
    );
    const result = await inspectExistingNovamira(client, "env", budget);
    assert.equal(result.aiEnabled, enabled === "1");
    assert.equal(result.aiDomain, "example.test");
    assert.deepEqual(client.calls, [
      EXISTING_NOVAMIRA_COMMAND,
      EXISTING_AI_COMMAND,
      EXISTING_AI_DOMAIN_COMMAND,
    ]);
  }
});

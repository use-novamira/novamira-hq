// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppAcknowledgement } from "../dist/config/app-acknowledgement.js";
import { defaultFileSecurity } from "../dist/config/file-security.js";
import { platformPaths, appAcknowledgementPath } from "../dist/config/paths.js";
import { renderAcknowledgement } from "../dist/web/views/acknowledgement.js";
import { renderHtml } from "../dist/web/html.js";

test("app acknowledgement is lazy, persistent and private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hq-app-ack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = platformPaths({ NOVAMIRA_HQ_HOME: root });
  const service = createAppAcknowledgement(paths, defaultFileSecurity());
  assert.equal(await service.accepted(), false);
  await assert.rejects(stat(appAcknowledgementPath(paths)), { code: "ENOENT" });
  await service.accept();
  assert.equal(
    await createAppAcknowledgement(paths, defaultFileSecurity()).accepted(),
    true,
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(appAcknowledgementPath(paths))).mode & 0o777,
      0o600,
    );
});

test("the app explains setup approval, overwrite risks and independent backups", () => {
  const markup = renderHtml(renderAcknowledgement());
  assert.ok(markup.includes('aria-labelledby="acknowledgement-title"'));
  assert.ok(markup.includes('class="how-to-card"'));
  assert.ok(markup.includes("max-width: 760px"));
  assert.equal((markup.match(/<h2>/g) ?? []).length, 3);
  for (const value of [
    "run PHP",
    "You will be asked to approve this during setup",
    "Push and restore operations can overwrite",
    "backup in a safe location, separate from the site",
    "This acknowledgement does not authorize operations",
    "I understand and continue",
    "/_dashboard/app/acknowledge",
  ])
    assert.ok(markup.includes(value), value);
});

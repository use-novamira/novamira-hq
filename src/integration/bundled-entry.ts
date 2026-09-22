// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Only this child-process entry imports the managed CLI. Never import it in HQ.
import { main } from "@novamira/cli/entry";

process.exitCode = await main(process.argv.slice(2), undefined, undefined, {
  managed: {
    updateHint: "Update Novamira HQ to update its bundled site CLI.",
    commandPrefix: "novamira-hq site-cli",
  },
});

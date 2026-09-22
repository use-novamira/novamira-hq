// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { copyFile, mkdir } from "node:fs/promises";
import { URL } from "node:url";

// Reuse the desktop master; never commit a second copy that can drift.
await mkdir(new URL("../dist/mcp/", import.meta.url), { recursive: true });
await copyFile(
  new URL("./macos/icon.png", import.meta.url),
  new URL("../dist/mcp/icon.png", import.meta.url),
);
await copyFile(
  new URL("../LICENSE", import.meta.url),
  new URL("../dist/mcp/LICENSE", import.meta.url),
);

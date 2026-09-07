// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

export { runMcpServer } from "./server.js";
export type { McpServerDependencies, McpStreams } from "./server.js";
export { parseMcpAccess, requireMcpAccess } from "./access.js";
export type { McpAccessPolicy, McpCapability } from "./access.js";

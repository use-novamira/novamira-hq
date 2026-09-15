// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import { patchToast } from "../patch.js";
import type { RouteContext, RouteHandler } from "../routes.js";

export function createMcpVerifyHandler(context: RouteContext): RouteHandler {
  return () => ({
    kind: "sse",
    run: async (stream) => {
      try {
        if (!context.mcpConnection)
          throw new CliError(
            "provider_unsupported",
            "Novamira HQ MCP startup verification is unavailable in this instance.",
          );
        const result = await context.mcpConnection.verify();
        patchToast(stream, {
          level: "ok",
          message: `Novamira HQ started locally and listed ${String(result.toolCount)} MCP tools. Confirm the external connection in your AI client.`,
        });
      } catch (error) {
        patchToast(stream, {
          level: "danger",
          message: asCliError(error).message,
        });
      }
      stream.close();
    },
  });
}

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
            "MCP startup verification is unavailable in this instance.",
          );
        const result = await context.mcpConnection.verify();
        patchToast(stream, {
          level: "ok",
          message: `Local MCP initialized and listed ${String(result.toolCount)} tools. This does not confirm an external client connection or provider credentials.`,
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

// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import { createMcpBundle } from "../../mcp/bundle.js";
import { patchToast } from "../patch.js";
import type { RouteContext, RouteHandler } from "../routes.js";

export function createMcpBundleHandler(context: RouteContext): RouteHandler {
  return () => {
    if (!context.mcpConnection)
      throw new CliError(
        "provider_unsupported",
        "Claude Desktop setup is unavailable in this Novamira HQ instance.",
      );
    const body = createMcpBundle(
      context.mcpConnection.configuration(),
      context.version,
    );
    return {
      kind: "asset",
      status: 200,
      contentType: "application/octet-stream",
      contentDisposition: 'attachment; filename="novamira-hq.mcpb"',
      cacheControl: "no-store",
      etag: '"novamira-hq-mcpb"',
      contentLength: body.length,
      body,
    };
  };
}

export function createMcpConnectHandler(context: RouteContext): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      try {
        if (!context.mcpConnection)
          throw new CliError(
            "provider_unsupported",
            "Automatic AI client setup is unavailable in this Novamira HQ instance.",
          );
        const client = request.query.get("client");
        if (client !== "chatgpt" && client !== "claude-code")
          throw new CliError("usage_error", "Choose a supported AI client.");
        await context.mcpConnection.connect(client);
        patchToast(stream, {
          level: "ok",
          message:
            client === "chatgpt"
              ? "Novamira HQ is connected to ChatGPT Desktop and Codex. Restart the client if it is already open."
              : "Novamira HQ is connected to Claude Code. Start a new session to use it.",
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

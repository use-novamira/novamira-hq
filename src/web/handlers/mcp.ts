// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import { createMcpBundle } from "../../mcp/bundle.js";
import { patchPage, patchToast } from "../patch.js";
import type { RouteContext, RouteHandler } from "../routes.js";
import { defaultDashboardSignals } from "../signals.js";
import type { McpClient } from "../../mcp-connection.js";
import type { McpSetupState } from "../views/mcp.js";

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
      let client: McpClient | undefined;
      const repaint = async (state: McpSetupState): Promise<void> => {
        const notice = { level: "neutral" as const, message: "" };
        patchPage(stream, {
          page: "mcp",
          notice,
          model: {
            view: await context.loadConfigView(),
            notice,
            signals: defaultDashboardSignals(context.token),
            ...(client ? { mcpClient: client } : {}),
            ...(context.mcpConnection
              ? { mcp: context.mcpConnection.configuration() }
              : {}),
            mcpSetup: state,
          },
        });
      };
      try {
        if (!context.mcpConnection)
          throw new CliError(
            "provider_unsupported",
            "Automatic AI client setup is unavailable in this Novamira HQ instance.",
          );
        const requested = request.query.get("client");
        if (
          requested !== "chatgpt" &&
          requested !== "codex" &&
          requested !== "claude-code" &&
          requested !== "vscode"
        )
          throw new CliError("usage_error", "Choose a supported AI client.");
        client = requested;
        await repaint({ status: "checking" });
        await context.mcpConnection.verify();
        await repaint({ status: "configuring" });
        const status = await context.mcpConnection.connect(client);
        await repaint({ status });
      } catch (error) {
        try {
          await repaint({
            status: "failed",
            message: asCliError(error).message,
          });
        } catch {
          patchToast(stream, {
            level: "danger",
            message:
              "Configuration could not be completed. Refresh the page and try again.",
          });
        }
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

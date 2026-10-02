import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OPENAI_MENTIONS_CAPABILITY_KEY,
  OpenAIMentionSearchParamsSchema,
  OpenAIMentionSearchResultSchema,
  type OpenAIMentionSearchParams,
  type OpenAIMentionSearchResult,
} from "../shared/mentions.js";

export type OpenAIMentionSearchHandler = (
  params: OpenAIMentionSearchParams,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => OpenAIMentionSearchResult | Promise<OpenAIMentionSearchResult>;
/** Mention-search extensions exposed for one MCP server instance. */
export type OpenAIMentions = {
  setHandler(handler: OpenAIMentionSearchHandler): void;
};

export function createMentions(server: McpServer): OpenAIMentions {
  let mentionSearchHandler: OpenAIMentionSearchHandler | null = null;
  let mentionsRegistered = false;

  return {
    setHandler: (handler) => {
      if (!mentionsRegistered) {
        if (server.server.transport) {
          throw new Error(
            "Register mention search before connecting the server.",
          );
        }
        server.registerTool(
          "search_mentions",
          {
            annotations: { readOnlyHint: true },
            inputSchema: OpenAIMentionSearchParamsSchema,
            outputSchema: OpenAIMentionSearchResultSchema,
            _meta: {
              "openai/extensions": { "mentions/search": {} },
              ui: { visibility: ["app"] },
            },
          },
          async (params, extra) => ({
            content: [],
            structuredContent:
              mentionSearchHandler == null
                ? { items: [] }
                : await mentionSearchHandler(params, extra),
          }),
        );
        const capability = { searchTool: "search_mentions" };
        server.server.registerCapabilities({
          extensions: { [OPENAI_MENTIONS_CAPABILITY_KEY]: capability },
          experimental: { [OPENAI_MENTIONS_CAPABILITY_KEY]: capability },
        });
        mentionsRegistered = true;
      }
      mentionSearchHandler = handler;
    },
  };
}

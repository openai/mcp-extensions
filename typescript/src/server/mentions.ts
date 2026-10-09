import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  OPENAI_MENTIONS_CAPABILITY_KEY,
  OpenAIMentionSearchParamsSchema,
  OpenAIMentionSearchResultSchema,
  type OpenAIMentionSearchParams,
  type OpenAIMentionSearchResult,
} from "../shared/mentions.js";

export type OpenAIMentionSearchHandler = (
  params: OpenAIMentionSearchParams,
  context: ServerContext,
) => OpenAIMentionSearchResult | Promise<OpenAIMentionSearchResult>;
/** Mention-search extensions exposed for one MCP server instance. */
export type OpenAIMentions = {
  setHandler(handler: OpenAIMentionSearchHandler): void;
};

export function createMentions(
  server: Pick<McpServer, "registerTool" | "server">,
): OpenAIMentions {
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
          async (params, context) => ({
            content: [],
            structuredContent:
              mentionSearchHandler == null
                ? { items: [] }
                : await mentionSearchHandler(params, context),
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

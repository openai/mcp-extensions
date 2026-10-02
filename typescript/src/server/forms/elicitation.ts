import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  createOpenAIFormContentSchema,
  OpenAIFormResultSchema,
  OpenAIFormSchema,
  type OpenAIForm,
  type OpenAIFormResult,
} from "../../shared/forms/schema.js";

export type OpenAIFormRequestParams = Omit<
  ElicitRequestFormParams,
  "mode" | "requestedSchema"
> & {
  mode: "form";
  requestedSchema: OpenAIForm;
};
export type OpenAIElicitInput = (
  params: OpenAIFormRequestParams,
  options?: RequestOptions,
) => Promise<OpenAIFormResult>;

const OPENAI_ELICITATION_EXTENSION_ID = "openai/elicitation";
const OPENAI_ELICITATION_METHOD = "openai/elicitation/create";
const OpenAIFormClientCapabilitiesSchema = z.object({
  extensions: z.object({
    [OPENAI_ELICITATION_EXTENSION_ID]: z.object({ form: z.object({}) }),
  }),
});

export function createElicitInput(server: {
  server: Pick<McpServer["server"], "request" | "getClientCapabilities">;
}): OpenAIElicitInput {
  return async (params, options): Promise<OpenAIFormResult> => {
    const capabilities = OpenAIFormClientCapabilitiesSchema.safeParse(
      server.server.getClientCapabilities(),
    );
    if (!capabilities.success) {
      throw new Error(
        `The MCP client does not support ${OPENAI_ELICITATION_EXTENSION_ID} form requests`,
      );
    }

    const requestedSchema = OpenAIFormSchema.parse(params.requestedSchema);
    const result = await server.server.request(
      {
        method: OPENAI_ELICITATION_METHOD,
        params: { ...params, requestedSchema },
      },
      OpenAIFormResultSchema,
      options,
    );
    if (result.action === "accept") {
      return {
        ...result,
        content: createOpenAIFormContentSchema(requestedSchema).parse(
          result.content,
        ),
      };
    }
    return result;
  };
}

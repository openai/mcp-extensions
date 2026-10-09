import type {
  ElicitRequestFormParams,
  McpServer,
  RequestOptions,
  ServerContext,
} from "@modelcontextprotocol/server";
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
  context: ServerContext,
  params: OpenAIFormRequestParams,
  options?: RequestOptions,
) => Promise<OpenAIFormResult>;

const OPENAI_ELICITATION_EXTENSION_ID = "openai/elicitation";
const OPENAI_ELICITATION_METHOD = "openai/elicitation/create";
const RequestEnvelopeSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.string().optional(),
  "io.modelcontextprotocol/clientCapabilities": z.unknown().optional(),
});
const OpenAIFormClientCapabilitiesSchema = z.object({
  extensions: z.object({
    [OPENAI_ELICITATION_EXTENSION_ID]: z.object({ form: z.object({}) }),
  }),
});

export function createElicitInput(server: McpServer): OpenAIElicitInput {
  return async (context, params, options): Promise<OpenAIFormResult> => {
    const envelope = RequestEnvelopeSchema.parse(context.mcpReq.envelope ?? {});
    const protocolVersion =
      envelope["io.modelcontextprotocol/protocolVersion"] ??
      server.server.getNegotiatedProtocolVersion();
    if (protocolVersion !== undefined && protocolVersion >= "2026-07-28") {
      throw new Error("Use requestFormInput for MCP 2026-07-28 or newer");
    }
    const capabilities = OpenAIFormClientCapabilitiesSchema.safeParse(
      envelope["io.modelcontextprotocol/clientCapabilities"] ??
        server.server.getClientCapabilities(),
    );
    if (!capabilities.success) {
      throw new Error(
        `The MCP client does not support ${OPENAI_ELICITATION_EXTENSION_ID} form requests`,
      );
    }

    const requestedSchema = OpenAIFormSchema.parse(params.requestedSchema);
    const result = await context.mcpReq.send(
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

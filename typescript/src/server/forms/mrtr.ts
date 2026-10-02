import type {
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { OpenAIFormRequestParams } from "./elicitation.js";
import {
  createOpenAIFormContentSchema,
  OpenAIFormResultSchema,
  OpenAIFormSchema,
  type OpenAIFormResult,
} from "../../shared/forms/schema.js";

const MrtrEnvelopeSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z
    .string()
    .refine((version) => version >= "2026-07-28"),
  "io.modelcontextprotocol/clientCapabilities": z.object({
    elicitation: z.object({ form: z.object({}) }),
    extensions: z.object({
      "openai/elicitation": z.object({
        form: z.object({}),
      }),
    }),
  }),
});

/**
 * Request a form elicitation with OpenAI form extensions for MCP Servers that support
 * multi-round-trip requests introduced in MCP 2026-07-28.
 */
export function requestFormInput(
  context: ServerContext,
  params: OpenAIFormRequestParams & { key: string; requestState?: string },
): InputRequiredResult | OpenAIFormResult {
  if (!MrtrEnvelopeSchema.safeParse(context.mcpReq.envelope).success) {
    throw new Error(
      "MRTR requires MCP 2026-07-28 or newer and openai/elicitation form support",
    );
  }
  const requestedSchema = OpenAIFormSchema.parse(params.requestedSchema);
  const responses = context.mcpReq.inputResponses;
  if (responses !== undefined && Object.hasOwn(responses, params.key)) {
    const result = OpenAIFormResultSchema.parse(responses[params.key]);
    return result.action === "accept"
      ? {
          ...result,
          content: createOpenAIFormContentSchema(requestedSchema).parse(
            result.content,
          ),
        }
      : result;
  }
  return {
    resultType: "input_required",
    inputRequests: {
      [params.key]: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: params.message,
          // Core schemas reject URI arrays and strip extended field metadata.
          // https://github.com/modelcontextprotocol/typescript-sdk/blob/0b403f0e072eb49e5ee063bba606c492e2fe04f1/packages/core-internal/src/types/types.ts
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            ...params._meta,
            "openai/elicitation": { requestedSchema },
          },
        },
      },
    },
    requestState: params.requestState,
  };
}

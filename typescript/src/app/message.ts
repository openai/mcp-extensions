import type { App } from "@modelcontextprotocol/ext-apps";
import { McpUiMessageRequestSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { RequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const OPENAI_MESSAGE_KEY = "openai/message";

/** Defaults to { target: "active", send: true }. */
export const OpenAIMessageOptionsSchema = z
  .object({
    /** Which conversation receives the content. */
    target: z.enum(["active", "new"]).optional(),
    /** Whether to send the content immediately. */
    send: z.literal(true).optional(),
  })
  .strict();

export type OpenAIMessageOptions = z.infer<typeof OpenAIMessageOptionsSchema>;

export const OpenAIMessageParamsSchema =
  McpUiMessageRequestSchema.shape.params.extend({
    _meta: RequestSchema.shape.params
      .unwrap()
      .shape._meta.unwrap()
      .extend({
        [OPENAI_MESSAGE_KEY]: OpenAIMessageOptionsSchema.optional(),
      })
      .optional(),
  });

export type OpenAIMessageParams = z.infer<typeof OpenAIMessageParamsSchema>;

export type OpenAIMessage = {
  /** Sends to the active or a new conversation. */
  send(
    params: OpenAIMessageParams,
    options?: RequestOptions,
  ): ReturnType<App["sendMessage"]>;
};

export function createMessage(app: App): OpenAIMessage {
  return {
    send: (params, options) =>
      app.sendMessage(OpenAIMessageParamsSchema.parse(params), options),
  };
}

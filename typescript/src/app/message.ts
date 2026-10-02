import type { App } from "@modelcontextprotocol/ext-apps";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ContentBlockSchema,
  RequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const OPENAI_MESSAGE_KEY = "openai/message";

/** Defaults to { target: "active", send: true }. */
export const OpenAIMessageOptionsSchema = z
  .object({
    /** Which conversation receives the content. */
    target: z.enum(["active", "new"]).optional(),
    /** Whether to send immediately or leave an editable draft. */
    send: z.boolean().optional(),
  })
  .strict();

export type OpenAIMessageOptions = z.infer<typeof OpenAIMessageOptionsSchema>;

export const OpenAIMessageParamsSchema = RequestSchema.shape.params
  .unwrap()
  .extend({
    role: z.literal("user"),
    content: z.array(ContentBlockSchema),
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
  /** Sends or drafts content in the active or a new conversation. */
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

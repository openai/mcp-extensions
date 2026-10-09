import { ResourceLinkSchema } from "@modelcontextprotocol/core";
import { z } from "zod";

import { NonBlankStringSchema } from "./strings.js";

export const OpenAIMcpAppToolTargetSchema = z.strictObject({
  arguments: z.record(z.string(), z.json()).optional(),
  name: NonBlankStringSchema,
  type: z.literal("mcp_app_tool"),
});

export const OpenAIPreviewTargetSchema = z.discriminatedUnion("type", [
  OpenAIMcpAppToolTargetSchema,
  ResourceLinkSchema,
]);

export type OpenAIPreviewTarget = z.infer<typeof OpenAIPreviewTargetSchema>;

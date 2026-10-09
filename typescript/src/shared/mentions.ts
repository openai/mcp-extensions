import { IconSchema, ResourceLinkSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import { NonBlankStringSchema } from "./strings.js";

export const OPENAI_MENTIONS_CAPABILITY_KEY = "openai/mentions";
export const OpenAIMentionsCapabilitySchema = z.object({
  searchTool: NonBlankStringSchema,
});
export type OpenAIMentionsCapability = z.infer<
  typeof OpenAIMentionsCapabilitySchema
>;

export const OpenAIMentionResourceSchema = z.strictObject({
  icons: z.array(IconSchema).optional(),
  resourceUri: NonBlankStringSchema,
  subtitle: NonBlankStringSchema.optional(),
  title: NonBlankStringSchema,
  type: z.literal("resource"),
});
export const OpenAIMentionItemSchema = z.discriminatedUnion("type", [
  ResourceLinkSchema,
  OpenAIMentionResourceSchema,
]);
export const OpenAIMentionSearchParamsSchema = z.object({
  query: z.string(),
});
export const OpenAIMentionSearchResultSchema = z.strictObject({
  items: z.array(OpenAIMentionItemSchema),
});

/** One MCP resource returned from mention search. */
export type OpenAIMentionResource = z.infer<typeof OpenAIMentionResourceSchema>;
/** One result returned from mention search. */
export type OpenAIMentionItem = z.infer<typeof OpenAIMentionItemSchema>;
/** Request payload for Codex mention search. */
export type OpenAIMentionSearchParams = z.infer<
  typeof OpenAIMentionSearchParamsSchema
>;
/** Response payload for Codex mention search. */
export type OpenAIMentionSearchResult = z.infer<
  typeof OpenAIMentionSearchResultSchema
>;

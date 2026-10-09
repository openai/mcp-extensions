import { IconSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { NonBlankStringSchema } from "./strings.js";

export const OpenAIUiQuickActionSchema = z.strictObject({
  title: NonBlankStringSchema,
  icons: z.array(IconSchema).min(1),
  target: z.strictObject({
    type: z.literal("tool"),
    name: NonBlankStringSchema,
    arguments: z.record(z.string(), z.json()).optional(),
  }),
});

export const OpenAIUiEntrypointSchema = z.discriminatedUnion("type", [
  z.strictObject({
    extensions: z.array(z.string().trim().startsWith(".")),
    type: z.literal("file"),
  }),
  z.strictObject({
    type: z.literal("global"),
    quickAction: OpenAIUiQuickActionSchema.optional(),
  }),
  z.strictObject({ type: z.literal("thread") }),
]);
export const OpenAIUiToolMetadataSchema = z.strictObject({
  entrypoints: z.array(OpenAIUiEntrypointSchema).optional(),
  preferredModelDisplayMode: z.enum(["inline", "fullscreen"]).optional(),
});

const displayModeSchema = z.enum(["inline", "fullscreen", "pip"]);

export const OpenAIUiResourceMetadataSchema = z.strictObject({
  availableDisplayModes: z.array(displayModeSchema).optional(),
  preferredDisplayMode: displayModeSchema.optional(),
});

/** One Codex launch affordance layered onto an MCP App tool. */
export type OpenAIUiEntrypoint = z.infer<typeof OpenAIUiEntrypointSchema>;

/** A sidebar shortcut that invokes a tool in the same MCP App. */
export type OpenAIUiQuickAction = z.infer<typeof OpenAIUiQuickActionSchema>;

/** OpenAI tool metadata carried in `_meta["openai/ui"]`. */
export type OpenAIUiToolMetadata = z.infer<typeof OpenAIUiToolMetadataSchema>;

/** UI resource content metadata carried in `_meta["openai/ui"]`. */
export type OpenAIUiResourceMetadata = z.infer<
  typeof OpenAIUiResourceMetadataSchema
>;

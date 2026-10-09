import { ResourceSchema } from "@modelcontextprotocol/core";
import { z } from "zod";

import { arrayFieldShape, stringFieldSchema } from "./fields.js";

const userOptionsSchema = z.object({
  kind: z.enum(["file", "directory"]).optional(),
  accept: z.array(z.string()).optional(),
});
const fileInputSchema = z.object({
  type: z.enum(["resource", "file"]),
  options: z.array(ResourceSchema),
  userOptions: userOptionsSchema.optional(),
  selection: z.enum(["explicit", "implicit"]).optional(),
});
const uriSchema = stringFieldSchema.extend({
  format: z.literal("uri"),
  enum: z.never().optional(),
  oneOf: z.never().optional(),
  anyOf: z.never().optional(),
});
export const OpenAIFileFormFieldSchema = z
  .discriminatedUnion("type", [
    uriSchema.extend({
      "x-openai-input": fileInputSchema.extend({
        selection: z.never().optional(),
      }),
    }),
    z.object({
      ...arrayFieldShape,
      items: uriSchema,
      "x-openai-input": fileInputSchema,
    }),
  ])
  .superRefine((field, context) => {
    const input = field["x-openai-input"];
    if (field.default != null) {
      if (input.selection === "implicit") {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "Implicit selection cannot specify a default",
        });
      }
      const defaults = Array.isArray(field.default)
        ? field.default
        : [field.default];
      if (
        defaults.some(
          (uri) => !input.options.some((option) => option.uri === uri),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "Defaults must name supplied resources",
        });
      }
    }
  });

export type OpenAIFileFormField = z.infer<typeof OpenAIFileFormFieldSchema>;

export function isValidFileSelection(
  input: OpenAIFileFormField["x-openai-input"],
  value: z.infer<z.ZodJSONSchema> | undefined,
): boolean {
  const selected = Array.isArray(value) ? value : [value];
  return (
    input.selection === "implicit" ||
    input.userOptions != null ||
    selected.every((uri) => input.options.some((option) => option.uri === uri))
  );
}

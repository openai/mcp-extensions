import { Validator } from "@cfworker/json-schema";
import { z } from "zod";

import { standardFieldSchemas } from "./fields.js";
import {
  isValidFileSelection,
  OpenAIFileFormFieldSchema,
} from "./file-picker.js";

export const OpenAIFormFieldSchema = z.union([
  OpenAIFileFormFieldSchema,
  ...standardFieldSchemas,
]);
export const OpenAIFormSchema = z.object({
  $schema: z.string().optional(),
  type: z.literal("object"),
  required: z.array(z.string()).optional(),
  properties: createFormRecordSchema(OpenAIFormFieldSchema),
});
const FormContentSchema = createFormRecordSchema(
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export const OpenAIFormResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), content: FormContentSchema }),
  z.object({ action: z.enum(["cancel", "decline"]) }),
]);

export type OpenAIFormField = z.infer<typeof OpenAIFormFieldSchema>;
export type OpenAIForm = z.infer<typeof OpenAIFormSchema>;
export type OpenAIFormResult = z.infer<typeof OpenAIFormResultSchema>;

/** Validate answers without applying defaults or changing submitted values. */
export function createOpenAIFormContentSchema(form: OpenAIForm) {
  const validator = new Validator(structuredClone(form), "2020-12", false);
  return FormContentSchema.superRefine((content, context) => {
    // The validator uses `in`; inherited names must not count as submitted fields.
    const result = validator.validate(
      Object.setPrototypeOf({ ...content }, null),
    );
    for (const error of result.errors) {
      if (error.keywordLocation === "#/required") {
        continue;
      }
      context.addIssue({
        code: "custom",
        path: error.instanceLocation
          .split("/")
          .slice(1)
          .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")),
        message: error.error,
      });
    }
    // Attach missing-field errors to the corresponding control.
    for (const name of form.required ?? []) {
      if (!Object.hasOwn(content, name)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Required field",
        });
      }
    }
    for (const [name, field] of Object.entries(form.properties)) {
      if (!Object.hasOwn(content, name)) {
        continue;
      }
      if (
        field["x-openai-input"] != null &&
        !isValidFileSelection(field["x-openai-input"], content[name])
      ) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "Invalid file selection",
        });
      }
    }
  });
}

// Parse entries so protocol field names such as __proto__ survive intact.
function createFormRecordSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .custom<Record<string, unknown>>(
      (value) => z.record(z.string(), z.unknown()).safeParse(value).success,
    )
    .transform((value) => Object.entries(value))
    .pipe(z.array(z.tuple([z.string(), valueSchema.nonoptional()])))
    .transform((entries) => Object.fromEntries(entries));
}

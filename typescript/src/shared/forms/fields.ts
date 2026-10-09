import {
  BooleanSchemaSchema,
  IconSchema,
  NumberSchemaSchema,
  LegacyTitledEnumSchemaSchema,
  TitledSingleSelectEnumSchemaSchema,
  TitledMultiSelectEnumSchemaSchema,
  UntitledMultiSelectEnumSchemaSchema,
  StringSchemaSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod";

const optionSchema =
  TitledSingleSelectEnumSchemaSchema.shape.oneOf.element.extend({
    "x-openai-thumbnail": IconSchema.optional(),
    /** @deprecated Use x-openai-thumbnail. */
    "x-openai-preview": IconSchema.optional(),
    description: z.string().optional(),
  });
export const arrayFieldShape = TitledMultiSelectEnumSchemaSchema.omit({
  items: true,
}).shape;
export const stringFieldSchema = StringSchemaSchema.extend({
  pattern: z.string().optional(),
  "x-openai-suggestions": z.array(optionSchema).optional(),
});

// Prevent a standard field from stripping an unsupported semantic input.
const noCustomInput = { "x-openai-input": z.never().optional() };
const singleSelectSchema = TitledSingleSelectEnumSchemaSchema.extend({
  ...noCustomInput,
  oneOf: z.array(optionSchema),
  anyOf: z.never().optional(),
});
const stringArraySchema = z.object({
  ...arrayFieldShape,
  ...noCustomInput,
  uniqueItems: z.boolean().optional(),
  items: stringFieldSchema.extend({
    enum: z.never().optional(),
    oneOf: z.never().optional(),
    anyOf: z.never().optional(),
  }),
});
const multiSelectSchema = TitledMultiSelectEnumSchemaSchema.extend({
  ...noCustomInput,
  items: z.object({
    enum: z.never().optional(),
    anyOf: z.array(optionSchema),
  }),
});
const untitledMultiSelectSchema = UntitledMultiSelectEnumSchemaSchema.extend({
  ...noCustomInput,
  items: UntitledMultiSelectEnumSchemaSchema.shape.items.extend({
    anyOf: z.never().optional(),
  }),
});
const primitiveSchemas = [
  LegacyTitledEnumSchemaSchema.extend({
    ...noCustomInput,
    oneOf: z.never().optional(),
    anyOf: z.never().optional(),
  }),
  stringFieldSchema.extend({
    ...noCustomInput,
    enum: z.never().optional(),
    oneOf: z.never().optional(),
    anyOf: z.never().optional(),
  }),
  NumberSchemaSchema.extend(noCustomInput),
  BooleanSchemaSchema.extend(noCustomInput),
] as const;
export const standardFieldSchemas = [
  singleSelectSchema,
  multiSelectSchema,
  untitledMultiSelectSchema,
  ...primitiveSchemas,
  stringArraySchema,
] as const;
export type OpenAIFormOption = z.infer<typeof optionSchema>;

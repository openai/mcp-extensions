import { z } from "zod";
import { NonBlankStringSchema } from "./strings.js";

/** Server capability extension identifying the settings tools. */
export const OPENAI_SETTINGS_CAPABILITY_KEY = "openai/settings";

/** Validates discovery without checking that the referenced same-server tools exist. */
export const OpenAISettingsCapabilitySchema = z.object({
  readTool: NonBlankStringSchema,
  /** Name of the settings update tool on the same MCP server. */
  updateTool: NonBlankStringSchema,
});
/** A reference to a value field. Keys are checked against the read schema. */
export const OpenAISettingsPropertySchema = z.strictObject({
  kind: z.literal("property"),
  property: z.string(),
});
/** A button invoking a same-server tool accepting `{}`. An MCP App UI is optional. */
export const OpenAISettingsToolSchema = z.strictObject({
  kind: z.literal("tool"),
  tool: NonBlankStringSchema,
  /** @deprecated Set the title on the referenced MCP tool. Hosts ignore this field. */
  title: NonBlankStringSchema.optional(),
  description: z.string().optional(),
});
const settingsLayoutLeafSchema = z.discriminatedUnion("kind", [
  OpenAISettingsPropertySchema,
  OpenAISettingsToolSchema,
]);
/** One section of ordered settings and buttons. Nested groups are not supported. */
export const OpenAISettingsGroupSchema = z.strictObject({
  kind: z.literal("group"),
  title: NonBlankStringSchema,
  items: z.array(settingsLayoutLeafSchema),
});
export const OpenAISettingsLayoutItemSchema = OpenAISettingsGroupSchema;
/** Presentation annotations for value fields, independent of their layout. */
export const OpenAISettingsFieldPresentationSchema = z.object({
  title: NonBlankStringSchema,
  description: z.string().optional(),
});
/**
 * Preserves JSON Schema keywords and validates layout references across groups.
 * Does not validate field definitions or check `values` against their schemas.
 * Use `settings.register` for schema-derived validation of native settings.
 */
export const OpenAISettingsReadResultSchema = z
  .object({
    schema: z.looseObject({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()).optional(),
      required: z.array(z.string()).optional(),
    }),
    layout: z.array(OpenAISettingsLayoutItemSchema).optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .superRefine(({ schema, layout }, context) => {
    const seen = new Set<string>();
    for (const item of layout ?? []) {
      for (const entry of item.items) {
        if (entry.kind !== "property") continue;
        if (
          !Object.hasOwn(schema.properties ?? {}, entry.property) ||
          seen.has(entry.property)
        ) {
          context.addIssue({
            code: "custom",
            path: ["layout"],
            message: `Unknown or duplicate settings key: ${entry.property}`,
          });
        }
        seen.add(entry.property);
      }
    }
  });
/**
 * Requires a nonempty `set`, but does not constrain its keys or value types.
 * Custom tools must also validate them against their declared settings schema.
 */
export const OpenAISettingsUpdateArgumentsSchema = z.strictObject({
  set: z
    .record(z.string(), z.unknown())
    .refine((set) => Object.keys(set).length > 0, "Set at least one setting.")
    .meta({ minProperties: 1 }),
});
/** Validates the update-result envelope, without validating individual settings values. */
export const OpenAISettingsUpdateResultSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

/**
 * One read/update pair advertised in the server capability extensions map.
 */
export type OpenAISettingsCapability = z.infer<
  typeof OpenAISettingsCapabilitySchema
>;
/** A titled section whose items appear in array order. */
export type OpenAISettingsGroup = z.infer<typeof OpenAISettingsGroupSchema>;
/** A tool button in the layout, with no corresponding settings value. */
export type OpenAISettingsTool = z.infer<typeof OpenAISettingsToolSchema>;
/** Settings omitted from a supplied layout appear in an "Other settings" section. */
export type OpenAISettingsLayoutItem<Key extends string = string> = {
  kind: "group";
  title: string;
  items: readonly ({ kind: "property"; property: Key } | OpenAISettingsTool)[];
};
/** Presentation metadata for a read-schema property, usable with Zod `.meta()`. */
export type OpenAISettingsFieldPresentation = z.infer<
  typeof OpenAISettingsFieldPresentationSchema
>;
/**
 * Read tool `structuredContent`. Return every effective settings value, including
 * server-applied defaults, conforming to `schema`.
 * Schema properties must not declare defaults in place of returned values.
 */
export type OpenAISettingsReadResult = z.infer<
  typeof OpenAISettingsReadResultSchema
>;
/**
 * Each supplied field replaces its current value.
 * Omitted fields stay unchanged. There is no deep merge or reset operation.
 */
export type OpenAISettingsUpdateArguments = z.infer<
  typeof OpenAISettingsUpdateArgumentsSchema
>;
/**
 * Update tool `structuredContent`, returned only after persistence succeeds.
 * Contains all effective values after the update, including unchanged settings.
 */
export type OpenAISettingsUpdateResult = z.infer<
  typeof OpenAISettingsUpdateResultSchema
>;

import { z } from "zod/v4";

export const cadFormatSchema = z.enum(["stl", "3mf", "step", "stp"]);
export type CadFormat = z.infer<typeof cadFormatSchema>;
const modelFormatSchema = cadFormatSchema.or(z.literal("glb"));
export type ModelFormat = z.infer<typeof modelFormatSchema>;

export const cadPreferencesSchema = z.object({
  defaultView: z.enum(["isometric", "front", "top"]),
  showGrid: z.boolean(),
  units: z.enum(["mm", "in"]),
});
export type CadPreferences = z.infer<typeof cadPreferencesSchema>;

export const cadPreferencesUpdateSchema = cadPreferencesSchema
  .partial()
  .strict()
  .refine((set) => Object.keys(set).length > 0, "Set at least one CAD setting.")
  .meta({ minProperties: 1 });

export const defaultCadPreferences: CadPreferences = {
  defaultView: "isometric",
  showGrid: true,
  units: "mm",
};

export const previewImagesSchema = z.object({
  front: z.string().optional(),
  isometric: z.string().optional(),
  top: z.string().optional(),
  wireframe: z.string().optional(),
});
export type PreviewImages = z.infer<typeof previewImagesSchema>;

export const displaySourceSchema = z.object({
  format: modelFormatSchema,
  url: z.string(),
});

export const publicCadPartSchema = z.object({
  displaySource: displaySourceSchema.optional(),
  description: z.string(),
  fileName: z.string(),
  format: cadFormatSchema,
  id: z.string(),
  name: z.string(),
  previews: previewImagesSchema,
  resourceUri: z.string(),
  sizeBytes: z.number(),
  sourceLabel: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});
export type PublicCadPart = z.infer<typeof publicCadPartSchema>;
export const cadPartMetadataSchema = publicCadPartSchema.omit({
  previews: true,
});
export type CadPartMetadata = z.infer<typeof cadPartMetadataSchema>;

export const partsResultSchema = z.object({
  parts: z.array(publicCadPartSchema),
});
export const partResultSchema = z.object({ part: publicCadPartSchema });
export const partSourceResultSchema = z
  .object({
    blob: z.string(),
    format: modelFormatSchema,
    part: publicCadPartSchema,
  })
  .or(displaySourceSchema);

export type PartSourceResult = z.infer<typeof partSourceResultSchema>;

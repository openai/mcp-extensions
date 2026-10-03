import { z } from "zod";

export const sqlTableSchema = z.strictObject({
  name: z.string(),
  schema: z.string(),
  columns: z.array(
    z.strictObject({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      isPrimary: z.boolean(),
    }),
  ),
  rowCount: z.number(),
  description: z.string().optional(),
});

export const sqlQuerySchema = z.strictObject({
  sql: z.string(),
  tables: z.array(z.string()),
  description: z.string().optional(),
});

export const sqlPreferencesSchema = z.strictObject({
  defaultSchema: z.enum(["public", "analytics", "staging"]),
  maxRows: z.number().int().min(10).max(10000),
  format: z.enum(["table", "json", "csv"]),
  showTimings: z.boolean(),
});

export type SqlTable = z.infer<typeof sqlTableSchema>;
export type SqlQuery = z.infer<typeof sqlQuerySchema>;
export type SqlPreferences = z.infer<typeof sqlPreferencesSchema>;

export const defaultSqlPreferences: SqlPreferences = {
  defaultSchema: "public",
  maxRows: 100,
  format: "table",
  showTimings: true,
};

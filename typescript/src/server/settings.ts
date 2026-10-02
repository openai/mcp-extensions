import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ToolSchema,
  type ServerRequest,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  OPENAI_SETTINGS_CAPABILITY_KEY,
  OpenAISettingsFieldPresentationSchema,
  OpenAISettingsReadResultSchema,
  OpenAISettingsUpdateResultSchema,
  type OpenAISettingsCapability,
  type OpenAISettingsLayoutItem,
} from "../shared/settings.js";

import { NonBlankStringSchema } from "../shared/strings.js";

const nativeSettingsFieldSchema = z
  .object({
    type: z.enum(["boolean", "string", "number", "integer"]),
    enum: z.array(z.string()).nonempty().optional(),
    $ref: z.never().optional(),
    anyOf: z.never().optional(),
    oneOf: z.never().optional(),
    allOf: z.never().optional(),
  })
  .refine((field) => field.enum === undefined || field.type === "string");

type SettingsContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Native fields use Zod for validation and typed properties for presentation. */
export interface OpenAISettingsField<Schema extends z.ZodType = z.ZodType> {
  schema: Schema;
  title: string;
  description?: string;
}

type SettingsFields = Record<string, OpenAISettingsField>;
type SettingsValues<Fields extends SettingsFields> = {
  -readonly [Key in keyof Fields]-?: Exclude<
    z.output<Fields[Key]["schema"]>,
    undefined
  >;
};

export interface OpenAISettingsRegistration<Fields extends SettingsFields> {
  /** Defaults to `settings.read`. Override with an unused tool name on this server. */
  readTool?: string;
  /** Defaults to `settings.update`. Must be unused and distinct from `readTool`. */
  updateTool?: string;
  /**
   * Native value fields, convertible to JSON Schema. Every field needs a title.
   * Schema defaults are rejected. Complete handler results must include
   * every field, even when its schema is optional.
   */
  fields: Fields;
  /** Keys refer to fields. Omitted fields appear in "Other settings" below the layout. */
  layout?: readonly OpenAISettingsLayoutItem<NoInfer<keyof Fields & string>>[];
  /**
   * Authorize using the request context and read without mutations. Return all
   * effective values, applying server-owned defaults for settings not yet saved.
   * The helper validates the result and rejects missing or unknown fields.
   */
  read: (
    extra: SettingsContext,
  ) => SettingsValues<Fields> | Promise<SettingsValues<Fields>>;
  /**
   * Receives the supplied fields after schema validation. Authorize the request,
   * preserve omitted fields, validate cross-field constraints, and persist the
   * update atomically before returning all effective values. The helper validates
   * the result but does not serialize concurrent updates or provide storage.
   * Throw on failure to return an MCP tool error.
   */
  update: (
    set: Partial<SettingsValues<Fields>>,
    extra: SettingsContext,
  ) => SettingsValues<Fields> | Promise<SettingsValues<Fields>>;
}

export interface OpenAISettings {
  /**
   * Register before connecting the server. Derives both tools' input and output
   * schemas and server capabilities without calling the handlers. Schema and layout
   * definitions are captured at registration. Invalid definitions throw.
   *
   * For dynamic definitions, register ordinary MCP tools using
   * the exported settings capability and result schemas instead of this helper.
   */
  register<const Fields extends SettingsFields>(
    options: OpenAISettingsRegistration<Fields>,
  ): void;
}

/** Creates the facade exposed by `OpenAIExtensions.settings`; no tools are registered yet. */
export function createSettings(server: McpServer): OpenAISettings {
  const registered = Symbol.for("@openai/mcp-extensions/settings/registered");
  return {
    register<const Fields extends SettingsFields>(
      options: OpenAISettingsRegistration<Fields>,
    ) {
      if (registered in server)
        throw new Error("Settings are already registered on this server.");
      if (server.server.transport)
        throw new Error("Register settings before connecting the server.");
      const readTool = NonBlankStringSchema.parse(
        options.readTool ?? "settings.read",
      );
      const updateTool = NonBlankStringSchema.parse(
        options.updateTool ?? "settings.update",
      );
      if (readTool === updateTool) {
        throw new Error(
          "Settings read and update tools must have different names.",
        );
      }
      // Each entry preserves its original Zod type; metadata changes only presentation.
      const shape = Object.fromEntries(
        Object.entries(options.fields).map(([name, field]) => {
          return [
            name,
            field.schema.meta({
              ...field.schema.meta(),
              title: field.title,
              description: field.description,
            }),
          ];
        }),
      ) as { [Key in keyof Fields]: Fields[Key]["schema"] };
      const valuesSchema = z.strictObject(shape).required();
      const schema = ToolSchema.shape.inputSchema.parse(
        z.toJSONSchema(valuesSchema),
      );
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        OpenAISettingsFieldPresentationSchema.parse(property);
        if (!nativeSettingsFieldSchema.safeParse(property).success) {
          throw new Error(
            `Unsupported native setting ${JSON.stringify(name)}: use a boolean, string, string enum, number, or integer field.`,
          );
        }
        if (
          typeof property === "object" &&
          property !== null &&
          "default" in property
        ) {
          throw new Error(
            "Settings defaults must be returned by the read handler, not declared in the schema.",
          );
        }
      }
      const { layout } = OpenAISettingsReadResultSchema.parse({
        schema,
        layout: options.layout,
        values: {},
      });
      // Cross-field rules require complete settings and are checked by the update handler.
      const setSchema = z
        .strictObject(shape)
        .partial()
        .refine(
          (set) => Object.keys(set).length > 0,
          "Set at least one setting.",
        )
        .meta({ minProperties: 1 });
      const registeredReadTool = server.registerTool(
        readTool,
        {
          inputSchema: z.strictObject({}),
          outputSchema: OpenAISettingsReadResultSchema.safeExtend({
            values: valuesSchema,
          }),
          annotations: { readOnlyHint: true },
        },
        async (_args, extra) => ({
          content: [],
          structuredContent: {
            schema,
            ...(layout === undefined ? {} : { layout }),
            values: valuesSchema.parse(await options.read(extra)),
          },
        }),
      );
      try {
        server.registerTool(
          updateTool,
          {
            inputSchema: z.strictObject({ set: setSchema }),
            outputSchema: OpenAISettingsUpdateResultSchema.extend({
              values: valuesSchema,
            }),
          },
          async ({ set }, extra) => ({
            content: [],
            // The MCP SDK validated set against the partial form of this same schema.
            structuredContent: {
              values: valuesSchema.parse(
                await options.update(
                  set as Partial<SettingsValues<Fields>>,
                  extra,
                ),
              ),
            },
          }),
        );
        const capability: OpenAISettingsCapability = { readTool, updateTool };
        server.server.registerCapabilities({
          extensions: { [OPENAI_SETTINGS_CAPABILITY_KEY]: capability },
          experimental: { [OPENAI_SETTINGS_CAPABILITY_KEY]: capability },
        });
        Object.defineProperty(server, registered, { value: true });
      } catch (error) {
        registeredReadTool.remove();
        throw error;
      }
    },
  };
}

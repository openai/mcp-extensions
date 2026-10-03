import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createElicitInput,
  createMentions,
  createSettings,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import { z } from "zod";
import {
  sqlPreferencesSchema,
  sqlQuerySchema,
  sqlTableSchema,
} from "../shared/contracts.js";
import type { SqlStore } from "./store.js";

export type SqlServerOptions = {
  server: McpServer;
  store: SqlStore;
  html: string;
  iconSvg: string;
};

const result = (data: Record<string, unknown>) => ({
  content: [],
  structuredContent: data,
});

const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export function registerSqlServer({
  server,
  store,
  html,
  iconSvg,
}: SqlServerOptions) {
  const UI = "ui://sql-query-builder/app-v1";
  const icon = {
    src: "data:image/svg+xml," + encodeURIComponent(iconSvg),
    mimeType: "image/svg+xml",
    sizes: ["any"],
  };
  const ui = (entrypoints: unknown[] = []) => ({
    ui: { resourceUri: UI },
    "openai/ui": { entrypoints },
    "openai/iconStyle": "monochrome",
  });

  const elicit = createElicitInput(server);
  const settings = createSettings(server);
  settings.register({
    fields: {
      defaultSchema: {
        schema: sqlPreferencesSchema.shape.defaultSchema,
        title: "Default schema",
      },
      maxRows: {
        schema: sqlPreferencesSchema.shape.maxRows,
        title: "Max rows",
      },
      format: {
        schema: sqlPreferencesSchema.shape.format,
        title: "Result format",
      },
      showTimings: {
        schema: sqlPreferencesSchema.shape.showTimings,
        title: "Show query timings",
      },
    },
    layout: [
      {
        kind: "group",
        title: "Query defaults",
        items: [
          { kind: "property", property: "defaultSchema" },
          { kind: "property", property: "maxRows" },
        ],
      },
      {
        kind: "group",
        title: "Display",
        items: [
          { kind: "property", property: "format" },
          { kind: "property", property: "showTimings" },
        ],
      },
    ],
    read: () => store.readSettings(),
    update: (set) => store.updateSettings(set),
  });

  createMentions(server).setHandler(async ({ query }) => ({
    items: (await store.searchTables(query)).slice(0, 30).map((table) => ({
      type: "resource_link" as const,
      uri: `sql://tables/${table.name}`,
      name: table.name,
      title: table.name,
      mimeType: "text/plain",
    })),
  }));

  server.registerTool(
    "sql.open",
    {
      title: "SQL Query Builder",
      description: "Open the SQL query builder.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([
        {
          type: "global",
          quickAction: {
            title: "New query",
            icons: [icon],
            target: { type: "tool", name: "sql.open", arguments: {} },
          },
        },
      ]),
    },
    async () => result({ page: "builder", tables: await store.listTables() }),
  );

  server.registerTool(
    "sql.tray",
    {
      title: "SQL Query Builder",
      description: "Open the query builder beside this conversation.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([{ type: "thread" }]),
    },
    async () => result({ page: "builder", tables: await store.listTables() }),
  );

  server.registerTool(
    "sql.listTables",
    {
      title: "List database tables",
      inputSchema: z.object({}),
      outputSchema: z.object({ tables: z.array(sqlTableSchema) }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => result({ tables: await store.listTables() }),
  );

  server.registerTool(
    "sql.getTable",
    {
      title: "Get table schema",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ table: sqlTableSchema }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ name }) => {
      const table = await store.getTable(name);
      if (!table) throw Error("Unknown table: " + name);
      return result({ table });
    },
  );

  server.registerTool(
    "sql.searchTables",
    {
      title: "Search tables",
      description: "Find tables by name, description, or column.",
      inputSchema: z.object({ query: z.string().default("") }),
      outputSchema: z.object({ tables: z.array(sqlTableSchema) }),
      annotations: readonly,
    },
    async ({ query }) => result({ tables: await store.searchTables(query) }),
  );

  server.registerTool(
    "sql.listQueries",
    {
      title: "List saved queries",
      inputSchema: z.object({}),
      outputSchema: z.object({ queries: z.array(sqlQuerySchema) }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => result({ queries: await store.listQueries() }),
  );

  server.registerTool(
    "sql.pickTable",
    {
      title: "Pick a table",
      description: "Show a picker with table previews.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui(),
    },
    async () => {
      const tables = await store.listTables();
      const form = await elicit({
        mode: "form",
        message: "Choose a table",
        requestedSchema: {
          type: "object",
          required: ["table"],
          properties: {
            table: {
              type: "string",
              title: "Table",
              oneOf: tables.map((t) => ({
                const: t.name,
                title: t.name,
                description: t.description,
              })),
            },
          },
        } as OpenAIFormRequestParams["requestedSchema"],
      });
      if (form.action !== "accept") return result({ selection: form.action });
      return result({
        table: await store.getTable(String(form.content.table)),
      });
    },
  );

  server.registerTool(
    "sql.pickColumns",
    {
      title: "Pick columns",
      description: "Select columns from a table with checkboxes.",
      inputSchema: z.object({
        tableName: z.string(),
        selection: z.enum(["explicit", "implicit"]).default("explicit"),
      }),
      annotations: readonly,
    },
    async ({ tableName, selection }) => {
      const table = await store.getTable(tableName);
      if (!table) throw Error("Unknown table: " + tableName);
      const form = await elicit({
        mode: "form",
        message: `Select columns from ${tableName}`,
        requestedSchema: {
          type: "object",
          required: ["columns"],
          properties: {
            columns: {
              type: "array",
              title: "Columns",
              items: {
                type: "string",
                format: "uri",
              },
              "x-openai-input": {
                type: "resource",
                selection,
                options: table.columns.map((c) => ({
                  uri: `sql://columns/${tableName}/${c.name}`,
                  name: c.name,
                  title: c.name,
                  _meta: {
                    "openai/thumbnail": {
                      src: "data:image/svg+xml," + encodeURIComponent(iconSvg),
                      mimeType: "image/svg+xml",
                    },
                  },
                })),
              },
            },
          },
        } as OpenAIFormRequestParams["requestedSchema"],
      });
      if (form.action !== "accept") return result({ selection: form.action });
      const columns = Array.isArray(form.content.columns)
        ? form.content.columns
        : [form.content.columns];
      const uris = columns.map(String);
      return result({
        columns: uris.map((uri) => uri.split("/").pop()),
        uris,
      });
    },
  );

  server.registerTool(
    "sql.reviewQuery",
    {
      title: "Review query",
      description:
        "Demonstrate form elicitation with patterns, enums, and numbers.",
      inputSchema: z.object({}),
      annotations: readonly,
    },
    async () => {
      const form = await elicit({
        mode: "form",
        message: "Review a SQL query",
        requestedSchema: {
          type: "object",
          required: ["table", "priority", "approved", "limit"],
          properties: {
            table: {
              type: "string",
              title: "Table name",
              pattern: "^[a-z_]+$",
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["low", "normal", "high"],
            },
            approved: { type: "boolean", title: "Approved" },
            limit: {
              type: "integer",
              title: "Row limit",
              minimum: 1,
              maximum: 10000,
            },
          },
        } as OpenAIFormRequestParams["requestedSchema"],
      });
      if (form.action !== "accept") return result({ selection: form.action });
      return result({ selection: form.action, content: form.content });
    },
  );

  server.registerResource(
    "sql-query-builder",
    UI,
    { title: "SQL Query Builder", mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri: UI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            "openai/ui": {
              preferredDisplayMode: "inline",
              availableDisplayModes: ["inline", "fullscreen"],
            },
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );
}

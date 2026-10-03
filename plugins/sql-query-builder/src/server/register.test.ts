import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerSqlServer } from "./register.js";
import { createSqlStore } from "./store.js";

const html = "<!doctype html><title>SQL Query Builder</title>";
const iconSvg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";

const formRequestSchema = z.object({
  method: z.literal("openai/elicitation/create"),
  params: z.object({
    mode: z.literal("form"),
    message: z.string(),
    requestedSchema: z.unknown(),
  }),
});

type FormField = {
  oneOf?: { const: string }[];
  "x-openai-input"?: { options?: { uri: string }[] };
};
type FormSchema = { properties: Record<string, FormField> };
type FormResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

function answerForm(requestedSchema: unknown): FormResponse {
  const schema = requestedSchema as FormSchema;
  if (schema.properties.columns) {
    const options = schema.properties.columns["x-openai-input"]?.options ?? [];
    return {
      action: "accept",
      content: { columns: options.slice(0, 2).map((option) => option.uri) },
    };
  }
  if (schema.properties.limit) {
    return {
      action: "accept",
      content: { table: "users", priority: "high", approved: true, limit: 25 },
    };
  }
  const table = schema.properties.table?.oneOf?.[0]?.const;
  if (table) return { action: "accept", content: { table } };
  return { action: "decline" };
}

async function connectClient(formSupport = false) {
  const server = new McpServer({
    name: "sql-query-builder",
    version: "0.1.0",
  });
  registerSqlServer({ server, store: createSqlStore(), html, iconSvg });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "sql-query-builder-test", version: "0.1.0" },
    {
      capabilities: formSupport
        ? { extensions: { "openai/elicitation": { form: {} } } }
        : {},
    },
  );
  if (formSupport) {
    client.setRequestHandler(formRequestSchema, async (request) =>
      answerForm(request.params.requestedSchema),
    );
  }
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

async function shutdown(server: McpServer, client: Client) {
  await Promise.allSettled([client.close(), server.close()]);
}

test("registers tools, mentions, and the app resource", async () => {
  const { server, client } = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    "sql.open",
    "sql.tray",
    "sql.listTables",
    "sql.getTable",
    "sql.searchTables",
    "sql.listQueries",
    "sql.pickTable",
    "sql.pickColumns",
    "sql.reviewQuery",
    "settings.read",
    "settings.update",
    "search_mentions",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }

  const open = tools.find((tool) => tool.name === "sql.open");
  assert.ok(open);
  const meta = (open._meta ?? {}) as Record<string, unknown>;
  assert.ok(meta["openai/ui"], "sql.open should advertise app entrypoints");
  assert.deepEqual(open.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });

  const mentions = await client.callTool({
    name: "search_mentions",
    arguments: { query: "users" },
  });
  const items = (mentions.structuredContent as { items: { uri: string }[] })
    .items;
  assert.ok(items.some((item) => item.uri === "sql://tables/users"));

  const resource = await client.readResource({
    uri: "ui://sql-query-builder/app-v1",
  });
  const [contents] = resource.contents;
  assert.ok("text" in contents);
  assert.equal(contents.text, html);

  await shutdown(server, client);
});

test("read-only tools return structured content", async () => {
  const { server, client } = await connectClient();

  const tables = await client.callTool({
    name: "sql.listTables",
    arguments: {},
  });
  assert.equal(tables.isError, undefined);
  const tableList = (tables.structuredContent as { tables: unknown[] }).tables;
  assert.ok(tableList.length >= 5);

  const order = await client.callTool({
    name: "sql.getTable",
    arguments: { name: "orders" },
  });
  const table = (
    order.structuredContent as { table: { name: string; columns: unknown[] } }
  ).table;
  assert.equal(table.name, "orders");
  assert.ok(table.columns.length > 0);

  const missing = await client.callTool({
    name: "sql.getTable",
    arguments: { name: "nope" },
  });
  assert.equal(missing.isError, true);

  const found = await client.callTool({
    name: "sql.searchTables",
    arguments: { query: "user_id" },
  });
  const matches = (found.structuredContent as { tables: { name: string }[] })
    .tables;
  assert.ok(matches.some((entry) => entry.name === "orders"));

  const queries = await client.callTool({
    name: "sql.listQueries",
    arguments: {},
  });
  const queryList = (queries.structuredContent as { queries: unknown[] })
    .queries;
  assert.ok(queryList.length > 0);

  await shutdown(server, client);
});

test("settings read and update round-trip", async () => {
  const { server, client } = await connectClient();

  const read = await client.callTool({
    name: "settings.read",
    arguments: {},
  });
  const values = (read.structuredContent as { values: Record<string, unknown> })
    .values;
  assert.equal(values.defaultSchema, "public");
  assert.equal(values.maxRows, 100);

  const updated = await client.callTool({
    name: "settings.update",
    arguments: { set: { maxRows: 500, format: "json" } },
  });
  const next = (
    updated.structuredContent as { values: Record<string, unknown> }
  ).values;
  assert.equal(next.maxRows, 500);
  assert.equal(next.format, "json");

  const invalid = await client.callTool({
    name: "settings.update",
    arguments: { set: { maxRows: 5 } },
  });
  assert.equal(invalid.isError, true);

  await shutdown(server, client);
});

test("form tools report a helpful error without elicitation support", async () => {
  const { server, client } = await connectClient();

  const response = await client.callTool({
    name: "sql.pickTable",
    arguments: {},
  });
  assert.equal(response.isError, true);
  const [first] = response.content as { type: string; text?: string }[];
  assert.match(first.text ?? "", /openai\/elicitation/);

  await shutdown(server, client);
});

test("picker forms round-trip through openai/elicitation", async () => {
  const { server, client } = await connectClient(true);

  const pickTable = await client.callTool({
    name: "sql.pickTable",
    arguments: {},
  });
  assert.equal(pickTable.isError, undefined);
  const picked = pickTable.structuredContent as { table: { name: string } };
  assert.equal(picked.table.name, "users");

  const pickColumns = await client.callTool({
    name: "sql.pickColumns",
    arguments: { tableName: "orders" },
  });
  const columns = pickColumns.structuredContent as {
    columns: string[];
    uris: string[];
  };
  assert.deepEqual(columns.columns, ["id", "user_id"]);
  assert.ok(
    columns.uris.every((uri) => uri.startsWith("sql://columns/orders/")),
  );

  const review = await client.callTool({
    name: "sql.reviewQuery",
    arguments: {},
  });
  const reviewed = review.structuredContent as {
    selection: string;
    content: Record<string, unknown>;
  };
  assert.equal(reviewed.selection, "accept");
  assert.equal(reviewed.content.priority, "high");
  assert.equal(reviewed.content.limit, 25);

  await shutdown(server, client);
});

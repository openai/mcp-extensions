import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import {
  McpServer as ModernServer,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { OpenAIExtensions, requestFormInput } from "../src/server/index.js";

test("settings and mention search work through the MCP client/server boundary", async (t) => {
  const server = new McpServer({ name: "sdk-contract", version: "1" });
  const client = new Client({ name: "sdk-consumer", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const extensions = new OpenAIExtensions(server);
  let values: { units: "mm" | "in"; grid: boolean } = {
    units: "mm",
    grid: true,
  };
  const updates: unknown[] = [];
  extensions.settings.register({
    fields: {
      units: { schema: z.enum(["mm", "in"]), title: "Units" },
      grid: { schema: z.boolean(), title: "Grid" },
    },
    read: () => values,
    update: (set) => {
      updates.push(set);
      values = { ...values, ...set };
      return values;
    },
  });
  extensions.mentions.setHandler(({ query }) => ({
    items: [{ type: "resource_link", uri: `cad://${query}`, name: query }],
  }));
  assert.deepEqual(updates, []);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  assert.deepEqual(
    client.getServerCapabilities()?.experimental?.["openai/settings"],
    { readTool: "settings.read", updateTool: "settings.update" },
  );
  const tools = (await client.listTools()).tools;
  assert.equal(
    tools.find((tool) => tool.name === "settings.read")?.annotations
      ?.readOnlyHint,
    true,
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === "search_mentions")?._meta?.ui,
    { visibility: ["app"] },
  );
  const read = await client.callTool({ name: "settings.read", arguments: {} });
  assert.deepEqual(read.structuredContent?.values, { units: "mm", grid: true });
  const update = await client.callTool({
    name: "settings.update",
    arguments: { set: { grid: false } },
  });
  assert.deepEqual(updates, [{ grid: false }]);
  assert.deepEqual(update.structuredContent, {
    values: { units: "mm", grid: false },
  });
  for (const set of [{}, { grid: "false" }, { unknown: true }]) {
    assert.equal(
      (await client.callTool({ name: "settings.update", arguments: { set } }))
        .isError,
      true,
    );
  }
  assert.deepEqual(updates, [{ grid: false }]);
  const mentions = await client.callTool({
    name: "search_mentions",
    arguments: { query: "bolt" },
  });
  assert.deepEqual(mentions.structuredContent, {
    items: [{ type: "resource_link", uri: "cad://bolt", name: "bolt" }],
  });
  extensions.mentions.setHandler(() => ({ items: [] }));
  assert.deepEqual(
    (
      await client.callTool({
        name: "search_mentions",
        arguments: { query: "bolt" },
      })
    ).structuredContent,
    { items: [] },
  );
  assert.throws(
    () =>
      extensions.settings.register({
        fields: {},
        read: () => ({}),
        update: () => ({}),
      }),
    /already registered/,
  );
  Object.assign(values, { units: "invalid" });
  assert.equal(
    (await client.callTool({ name: "settings.read", arguments: {} })).isError,
    true,
  );
});

test("invalid settings definitions fail before a server is connected", () => {
  for (const schema of [
    z.object({ nested: z.string() }),
    z.string().default("mm"),
  ]) {
    const server = new McpServer({ name: "sdk-contract", version: "1" });
    assert.throws(() =>
      new OpenAIExtensions(server).settings.register({
        fields: { value: { schema, title: "Value" } },
        read: () => ({ value: "mm" }),
        update: () => ({ value: "mm" }),
      }),
    );
  }
});

const form = {
  type: "object" as const,
  properties: {
    source: {
      type: "string" as const,
      format: "uri" as const,
      "x-openai-input": {
        type: "resource" as const,
        options: [{ uri: "file:///drawing.stl", name: "Drawing" }],
      },
    },
  },
  required: ["source"],
};
const params = {
  mode: "form" as const,
  message: "Choose a drawing",
  requestedSchema: form,
};

test("legacy forms exchange extended schemas and validate answers through MCP", async (t) => {
  for (const supported of [false, true]) {
    const server = new McpServer({ name: "forms", version: "1" });
    const extensions = new OpenAIExtensions(server);
    const client = new Client(
      { name: "form-consumer", version: "1" },
      {
        capabilities: supported
          ? { extensions: { "openai/elicitation": { form: {} } } }
          : {},
      },
    );
    t.after(async () => {
      await client.close();
      await server.close();
    });
    let reply: Record<string, unknown> = {
      action: "accept",
      content: { source: "file:///drawing.stl" },
    };
    const received: unknown[] = [];
    client.setRequestHandler(
      z.object({
        method: z.literal("openai/elicitation/create"),
        params: z.unknown(),
      }),
      async (request) => {
        received.push(request.params);
        return reply;
      },
    );
    server.registerTool(
      "choose-drawing",
      { inputSchema: z.object({}) },
      async () => ({
        content: [],
        structuredContent: await extensions.elicitInputLegacy(params),
      }),
    );
    const pair = InMemoryTransport.createLinkedPair();
    for (const transport of pair) {
      const send = transport.send.bind(transport);
      transport.send = (message, options) =>
        send(JSON.parse(JSON.stringify(message)), options);
    }
    await Promise.all([server.connect(pair[1]), client.connect(pair[0])]);
    const choose = () =>
      client.callTool({ name: "choose-drawing", arguments: {} });
    if (!supported) {
      assert.equal((await choose()).isError, true);
      assert.deepEqual(received, []);
      continue;
    }
    assert.deepEqual((await choose()).structuredContent, reply);
    assert.deepEqual(received, [params]);
    for (const content of [{ source: "file:///other.stl" }, {}]) {
      reply = { action: "accept", content };
      assert.equal((await choose()).isError, true);
    }
    reply = { action: "unexpected" };
    assert.equal((await choose()).isError, true);
    for (const action of ["cancel", "decline"]) {
      reply = { action };
      assert.deepEqual((await choose()).structuredContent, { action });
    }
  }
});

test("MRTR exchanges preserve extended schemas and consume validated retry answers", async (t) => {
  const exchanges: {
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }[] = [];
  const saved: unknown[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new ModernServer({ name: "forms", version: "1" });
      server.registerTool(
        "choose-drawing",
        { inputSchema: z.object({}) },
        (_args, context) => {
          const result = requestFormInput(context, {
            ...params,
            key: "drawing",
            requestState: "resume-1",
          });
          if ("resultType" in result) return result;
          if (result.action === "accept") {
            saved.push(result.content);
            assert.equal(context.mcpReq.requestState, "resume-1");
          }
          return { content: [], structuredContent: result };
        },
      );
      return server;
    },
    { responseMode: "json" },
  );
  t.after(() => handler.close());
  let reply: ElicitResult = {
    action: "accept",
    content: { source: "file:///drawing.stl" },
  };
  const client = new ModernClient(
    { name: "form-consumer", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: {
        elicitation: { form: {} },
        extensions: { "openai/elicitation": { form: {} } },
      },
    },
  );
  t.after(() => client.close());
  client.setRequestHandler("elicitation/create", async (request) => {
    assert.deepEqual(request.params._meta?.["openai/elicitation"], {
      requestedSchema: form,
    });
    return reply;
  });
  const fetchPeer: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await handler.fetch(request.clone());
    if (request.method === "POST")
      exchanges.push({
        request: await request.json(),
        response: await response.clone().json(),
      });
    return response;
  };
  const transport = new StreamableHTTPClientTransport(
    new URL("http://sdk.test/mcp"),
    { fetch: fetchPeer },
  );
  await client.connect(transport);
  const choose = () =>
    client.callTool({ name: "choose-drawing", arguments: {} });
  assert.deepEqual((await choose()).structuredContent, reply);
  assert.deepEqual(saved, [{ source: "file:///drawing.stl" }]);
  const rounds = exchanges.filter(
    (exchange) => exchange.request.method === "tools/call",
  );
  assert.equal(rounds.length, 2);
  const first = z
    .object({
      result: z.object({
        resultType: z.literal("input_required"),
        inputRequests: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(rounds[0]!.response).result;
  assert.deepEqual(first.inputRequests, {
    drawing: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: params.message,
        requestedSchema: { type: "object", properties: {} },
        _meta: { "openai/elicitation": { requestedSchema: form } },
      },
    },
  });
  for (const content of [{ source: "file:///other.stl" }, {}]) {
    reply = { action: "accept", content };
    assert.equal((await choose()).isError, true);
  }
  assert.equal(saved.length, 1);
  for (const action of ["cancel", "decline"] as const) {
    reply = { action };
    assert.deepEqual((await choose()).structuredContent, { action });
  }
  const unsupported = new ModernClient(
    { name: "unsupported", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { elicitation: { form: {} } },
    },
  );
  t.after(() => unsupported.close());
  await unsupported.connect(
    new StreamableHTTPClientTransport(new URL("http://sdk.test/mcp"), {
      fetch: fetchPeer,
    }),
  );
  assert.equal(
    (await unsupported.callTool({ name: "choose-drawing", arguments: {} }))
      .isError,
    true,
  );
});

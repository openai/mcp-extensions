import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { OpenAIExtensions } from "../src/server/index.js";

test("mention capabilities coexist with settings and retain legacy discovery", async () => {
  const server = new McpServer({ name: "mentions", version: "1" });
  server.server.registerCapabilities({
    extensions: {
      "openai/settings": { readTool: "read", updateTool: "update" },
    },
  });
  const extensions = new OpenAIExtensions(server);
  extensions.mentions.setHandler(({ query }) => ({
    items: [{ type: "resource_link", uri: `resource://${query}`, name: query }],
  }));
  const client = new Client({ name: "mentions-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const capabilities = client.getServerCapabilities();
    assert.deepEqual(capabilities?.extensions?.["openai/mentions"], {
      searchTool: "search_mentions",
    });
    assert.deepEqual(capabilities?.experimental?.["openai/mentions"], {
      searchTool: "search_mentions",
    });
    assert.deepEqual(capabilities?.extensions?.["openai/settings"], {
      readTool: "read",
      updateTool: "update",
    });
    const { tools } = await client.listTools();
    assert.deepEqual(tools[0]?._meta?.["openai/extensions"], {
      "mentions/search": {},
    });
    const result = await client.callTool({
      name: "search_mentions",
      arguments: { query: "bolt" },
    });
    assert.deepEqual(result.structuredContent, {
      items: [{ type: "resource_link", uri: "resource://bolt", name: "bolt" }],
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
  } finally {
    await client.close();
    await server.close();
  }
});

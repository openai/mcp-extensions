import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import {
  defaultCadPreferences,
  type PublicCadPart,
} from "../shared/contracts.js";
import { registerCadServer } from "./register.js";
import type { CatalogStore } from "./store.js";

const preview = "data:image/jpeg;base64," + "A".repeat(8192);
const parts: PublicCadPart[] = Array.from({ length: 34 }, (_, index) => ({
  id: `part-${index}`,
  name: `Part ${index}`,
  description: "A catalog fixture",
  fileName: `part-${index}.stl`,
  format: "stl",
  resourceUri: `mcp://bits-and-bolts/parts/part-${index}`,
  sizeBytes: 100,
  sourceLabel: "Test",
  tags: ["fixture"],
  updatedAt: "2026-01-01T00:00:00Z",
  previews: {
    front: preview,
    isometric: preview,
    top: preview,
    wireframe: preview,
  },
}));

async function connectCatalog() {
  const server = new McpServer({ name: "catalog-test", version: "1" });
  const client = new Client(
    { name: "catalog-client-test", version: "1" },
    { capabilities: { extensions: { "openai/elicitation": { form: {} } } } },
  );
  let selection: "accept" | "cancel" = "accept";
  client.setRequestHandler(
    z.object({
      method: z.literal("openai/elicitation/create"),
      params: z.unknown(),
    }),
    async () =>
      selection === "accept"
        ? { action: "accept", content: { part: "part-1" } }
        : { action: "cancel" },
  );
  const store: CatalogStore = {
    list: async () => parts,
    get: async (id) => parts.find((part) => part.id === id) ?? null,
    read: async (id) => ({
      part: parts.find((part) => part.id === id)!,
      format: "stl",
      blob: "c3Rs",
    }),
    import: async () => {
      throw new Error("Import is outside this test");
    },
    savePreviews: async (id) => parts.find((part) => part.id === id)!,
    readSettings: async () => defaultCadPreferences,
    updateSettings: async (set) => ({ ...defaultCadPreferences, ...set }),
    settingsLifetime: "test session",
  };
  await registerCadServer({
    server,
    store,
    html: "<html></html>",
    iconSvg: "<svg></svg>",
    formats: ["stl"],
    requestClient: () => server.server,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    server,
    cancel: () => {
      selection = "cancel";
    },
  };
}

for (const [name, args, selected] of [
  ["cad.library", {}, false],
  ["cad.tray", {}, false],
  ["cad.listParts", {}, false],
  ["cad.settings", {}, false],
  ["cad.view", { partId: "part-1" }, true],
  [
    "cad.configureView",
    { partId: "part-1", camera: "top", mode: "wireframe" },
    true,
  ],
  ["cad.pickFile", {}, true],
] as const) {
  test(`${name} keeps catalog previews in component metadata`, async (t) => {
    const { client, server } = await connectCatalog();
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
    assert.equal(result.isError, undefined);
    const modelData = result.structuredContent!;
    assert.ok(JSON.stringify(modelData).length < 4096);
    assert.equal(JSON.stringify(modelData).includes("data:image/"), false);
    assert.equal(modelData.parts, undefined);
    assert.equal(modelData.partCount, parts.length);
    const viewData = result._meta?.["bits-and-bolts/view"] as Record<
      string,
      unknown
    >;
    assert.deepEqual(viewData.parts, parts);
    assert.deepEqual(viewData.preferences, defaultCadPreferences);
    assert.equal(viewData.settingsLifetime, "test session");
    if (selected) {
      assert.deepEqual(viewData.part, parts[1]);
      assert.deepEqual(modelData.part, { ...parts[1], previews: {} });
    }
    if (name === "cad.configureView") {
      assert.equal(modelData.camera, "top");
      assert.equal(modelData.mode, "wireframe");
    }
    assert.equal(parts[1].previews.front, preview);
  });
}

test("app-only CAD source reads retain their bytes", async (t) => {
  const { client, server } = await connectCatalog();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = CallToolResultSchema.parse(
    await client.callTool({
      name: "cad.readPart",
      arguments: { partId: "part-1" },
    }),
  );
  assert.equal(result.structuredContent?.blob, "c3Rs");
  assert.deepEqual(result.structuredContent?.part, parts[1]);
});

test("cancelled selection stays cancelled", async (t) => {
  const { client, server, cancel } = await connectCatalog();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  cancel();
  const result = CallToolResultSchema.parse(
    await client.callTool({ name: "cad.pickFile", arguments: {} }),
  );
  assert.deepEqual(result.structuredContent, { selection: "cancel" });
});

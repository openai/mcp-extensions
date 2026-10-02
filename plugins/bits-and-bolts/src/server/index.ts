import { readFile } from "node:fs/promises";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerCadServer,
  cadImportSchema,
  cadResult,
  type CadServerOptions,
} from "./register.js";
import { elicitCadForm } from "./forms.js";
import { z } from "zod/v4";
import { createLocalStore } from "./local-store.js";
const icons = await Promise.all(
  (["light", "dark"] as const).map(async (theme) => ({
    src:
      "data:image/svg+xml," +
      encodeURIComponent(
        await readFile(
          new URL(
            `../assets/icon${theme === "dark" ? "-dark" : ""}.svg`,
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    mimeType: "image/svg+xml",
    sizes: ["any"],
    theme,
  })),
);
const server = new McpServer({
  name: "bits-and-bolts",
  title: "Bits & Bolts",
  version: "0.1.0",
  icons,
});
const store = await createLocalStore();
server.registerTool(
  "cad.importPart",
  {
    title: "Add CAD file",
    inputSchema: cadImportSchema.extend({ blob: z.string() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ["app"] } },
  },
  async (input) => cadResult({ part: await store.import(input) }),
);
registerCadServer({
  server: server as unknown as CadServerOptions["server"],
  resourceTemplate:
    ResourceTemplate as unknown as CadServerOptions["resourceTemplate"],
  partUriTemplate: "mcp://bits-and-bolts/parts/{id}",
  store,
  html: await readFile(new URL("./app.html", import.meta.url), "utf8"),
  icons,
  formats: ["stl", "3mf", "step", "stp"],
  wasm: {
    blob: (
      await readFile(new URL("./occt-import-js.wasm", import.meta.url))
    ).toString("base64"),
  },
  elicit: (_context, params) => elicitCadForm(server.server, params),
  requestMeta: (context) => context._meta,
});
await server.connect(new StdioServerTransport());

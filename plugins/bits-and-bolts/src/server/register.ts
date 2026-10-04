import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createSettings,
  createMentions,
  OpenAIFileEntrypointInputSchema,
  getResourcePath,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import {
  cadPreferencesSchema,
  publicCadPartSchema,
} from "../shared/contracts.js";
import { elicitCadForm, type RequestClient } from "./forms.js";
import type { CatalogStore } from "./store.js";
import { createViewResult } from "../shared/view-result.js";

export type CadServerOptions = {
  server: McpServer;
  store: CatalogStore;
  html: string;
  iconSvg: string;
  formats: string[];
  requestClient: (
    context: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => RequestClient;
  requestMeta?: (
    context: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Record<string, unknown> | undefined;
  wasm?: Uint8Array;
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
export function registerCadServer({
  server,
  store,
  html,
  iconSvg,
  formats,
  requestClient,
  requestMeta = (context) => context._meta,
  wasm,
}: CadServerOptions) {
  const UI = "ui://bits-and-bolts/app-v15";
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
  const view = async (data: Parameters<typeof createViewResult>[0]) =>
    createViewResult({
      ...data,
      preferences: await store.readSettings(),
      settingsLifetime: store.settingsLifetime,
      localFilesystem: store.importPath != null,
    });
  const find = async (id: string) => {
    const part = await store.get(id);
    if (!part) throw Error("Unknown part: " + id);
    return part;
  };
  const matching = async (query: string) =>
    (await store.list()).filter((part) =>
      [part.id, part.name, part.fileName, part.description, ...part.tags]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    );
  const registered = new Set<string>();
  function registerPart(id: string, uri: string, name: string) {
    if (registered.has(id)) return;
    registered.add(id);
    server.registerResource(
      id,
      uri,
      { title: name, mimeType: "text/markdown" },
      async () => {
        const part = await find(id);
        return {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text:
                "# " +
                part.name +
                "\n\n" +
                part.description +
                "\n\nTags: " +
                part.tags.join(", "),
            },
          ],
        };
      },
    );
  }
  const settings = createSettings(server);
  settings.register({
    fields: {
      units: { schema: cadPreferencesSchema.shape.units, title: "Units" },
      showGrid: {
        schema: cadPreferencesSchema.shape.showGrid,
        title: "Show grid",
      },
      defaultView: {
        schema: cadPreferencesSchema.shape.defaultView,
        title: "Default camera",
      },
    },
    layout: [
      {
        kind: "group",
        title: "Measurements",
        items: [{ kind: "property", property: "units" }],
      },
      {
        kind: "group",
        title: "3D viewer",
        items: [
          { kind: "property", property: "showGrid" },
          { kind: "property", property: "defaultView" },
          {
            kind: "tool",
            tool: "cad.settings",
            title: "Viewer controls",
            description: "Open the custom viewer settings",
          },
        ],
      },
    ],
    read: () => store.readSettings(),
    update: (set) => store.updateSettings(set),
  });
  createMentions(server).setHandler(async ({ query }) => ({
    items: (await matching(query)).slice(0, 30).map((part) => ({
      type: "resource_link" as const,
      uri: part.resourceUri,
      name: part.fileName,
      title: part.name,
      mimeType: "text/markdown",
    })),
  }));
  server.registerTool(
    "cad.library",
    {
      title: "Bits & Bolts",
      description: "Browse the CAD catalog and inspect a part.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([
        {
          type: "global",
          quickAction: {
            title: "Part reference",
            icons: [icon],
            target: { type: "tool", name: "cad.reference", arguments: {} },
          },
        },
      ]),
    },
    async () => view({ page: "library", parts: await store.list() }),
  );
  server.registerTool(
    "cad.tray",
    {
      title: "Bits & Bolts",
      description: "Open the parts library beside this conversation.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([{ type: "thread" }]),
    },
    async () => view({ page: "library", parts: await store.list() }),
  );
  server.registerTool(
    "cad.listParts",
    {
      title: "List CAD parts",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => view({ parts: await store.list() }),
  );
  server.registerTool(
    "cad.settings",
    {
      title: "Viewer settings",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([{ type: "settings" }]),
    },
    async () => view({ page: "settings", parts: await store.list() }),
  );
  server.registerTool(
    "cad.search",
    {
      title: "Search CAD parts",
      description: "Find CAD parts in the library.",
      inputSchema: z.object({ query: z.string().default("") }),
      outputSchema: z.object({ parts: z.array(publicCadPartSchema) }),
      annotations: readonly,
    },
    async ({ query }) => result({ parts: await matching(query) }),
  );
  server.registerTool(
    "cad.view",
    {
      title: "Open CAD part",
      inputSchema: z.object({ partId: z.string() }),
      annotations: readonly,
      _meta: ui(),
    },
    async ({ partId }) =>
      view({ part: await find(partId), parts: await store.list() }),
  );
  server.registerTool(
    "cad.configureView",
    {
      title: "Configure CAD view",
      description:
        "Open a part with a camera and render mode. Use mounted app tools to edit an existing view.",
      inputSchema: z.object({
        partId: z.string(),
        camera: z.enum(["isometric", "front", "top"]).optional(),
        mode: z.enum(["solid", "wireframe", "edges"]).optional(),
      }),
      annotations: readonly,
      _meta: ui(),
    },
    async ({ partId, ...config }) =>
      view({ part: await find(partId), parts: await store.list(), ...config }),
  );
  server.registerTool(
    "cad.open",
    {
      title: "Bits & Bolts CAD viewer",
      inputSchema: OpenAIFileEntrypointInputSchema,
      annotations: readonly,
      _meta: ui([
        { type: "file", extensions: formats.map((format) => "." + format) },
      ]),
    },
    async ({ file }) => view({ file }),
  );
  server.registerTool(
    "cad.readPart",
    {
      title: "Read CAD part",
      inputSchema: z.object({
        partId: z.string(),
        representation: z.enum(["source", "display"]).default("source"),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ partId, representation }) =>
      result(await store.read(partId, representation)),
  );
  server.registerTool(
    "cad.importPart",
    {
      title: "Add CAD file",
      inputSchema: z.object({
        blob: z.string(),
        fileName: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input) => {
      const part = await store.import(input);
      registerPart(part.id, part.resourceUri, part.name);
      return result({ part });
    },
  );
  server.registerTool(
    "cad.savePreviews",
    {
      title: "Save CAD previews",
      inputSchema: z.object({
        partId: z.string(),
        previews: publicCadPartSchema.shape.previews,
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ partId, previews }) =>
      result({ part: await store.savePreviews(partId, previews) }),
  );
  if (store.localPath)
    server.registerTool(
      "cad.partPath",
      {
        title: "Get CAD part path",
        inputSchema: z.object({ partId: z.string() }),
        annotations: readonly,
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ partId }) => result({ path: await store.localPath!(partId) }),
    );
  if (store.importPath)
    server.registerTool(
      "cad.addOpenFile",
      {
        title: "Add open CAD file to library",
        inputSchema: z.object({ fileName: z.string() }),
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ fileName }, context) => {
        const path = getResourcePath(requestMeta(context));
        if (!path)
          throw Error("The host did not provide a trusted CAD source path.");
        const part = await store.importPath!(path, fileName);
        registerPart(part.id, part.resourceUri, part.name);
        return result({ part });
      },
    );
  const elicit = (
    context: RequestHandlerExtra<ServerRequest, ServerNotification>,
    message: string,
    requestedSchema: OpenAIFormRequestParams["requestedSchema"],
  ) =>
    elicitCadForm(requestClient(context), {
      mode: "form",
      message,
      requestedSchema,
    });
  server.registerTool(
    "cad.reference",
    {
      title: "Part reference",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (_args, context) =>
      result(
        await elicit(
          context,
          (await store.list())
            .map((p) => p.name + ": " + p.description)
            .join("\n\n"),
          { type: "object", properties: {} },
        ),
      ),
  );
  server.registerTool(
    "cad.pickFile",
    {
      title: "Choose CAD part",
      description:
        "Show image previews when the user asks to pick or choose a CAD part.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui(),
    },
    async (_args, context) => {
      const parts = await store.list();
      const form = await elicit(context, "Choose a CAD part", {
        type: "object",
        required: ["part"],
        properties: {
          part: {
            type: "string",
            title: "CAD part",
            oneOf: parts.map((part) => ({
              const: part.id,
              title: part.name,
              ...(part.previews.isometric
                ? {
                    "x-openai-thumbnail": {
                      src: part.previews.isometric,
                      mimeType: part.previews.isometric.slice(
                        5,
                        part.previews.isometric.indexOf(";"),
                      ),
                    },
                  }
                : {}),
            })),
          },
        },
      });
      if (form.action !== "accept") return result({ selection: form.action });
      return view({ part: await find(String(form.content.part)), parts });
    },
  );
  server.registerTool(
    "cad.pickReferences",
    {
      title: "Choose CAD references",
      inputSchema: z.object({
        selection: z.enum(["single", "explicit", "implicit"]).default("single"),
        kind: z.enum(["file", "directory"]).default("file"),
      }),
      annotations: readonly,
    },
    async ({ selection, kind }, context) => {
      const parts = await store.list();
      const multiple = selection !== "single";
      const field = {
        ...(multiple
          ? { type: "array", items: { type: "string", format: "uri" } }
          : { type: "string", format: "uri" }),
        title: "CAD references",
        "x-openai-input": {
          type: "resource",
          ...(multiple ? { selection } : {}),
          options: parts.map((p) => ({
            uri: p.resourceUri,
            name: p.fileName,
            title: p.name,
          })),
          userOptions:
            kind === "file"
              ? { kind, accept: formats.map((format) => "." + format) }
              : { kind },
        },
        ...(selection === "implicit" || !parts.length
          ? {}
          : {
              default: multiple ? [parts[0].resourceUri] : parts[0].resourceUri,
            }),
      };
      const form = await elicit(context, "Choose CAD references", {
        type: "object",
        required: ["references"],
        properties: { references: field },
      } as OpenAIFormRequestParams["requestedSchema"]);
      return form.action === "accept"
        ? result({
            selection: "accept",
            uris: Array.isArray(form.content.references)
              ? form.content.references
              : [form.content.references],
          })
        : result({ selection: form.action });
    },
  );
  server.registerTool(
    "cad.reviewForm",
    {
      title: "CAD review form",
      description:
        "Demonstrate text patterns, enum, boolean and numeric input in a review form.",
      inputSchema: z.object({}),
      annotations: readonly,
    },
    async (_args, context) =>
      result(
        await elicit(context, "Review a CAD reference", {
          type: "object",
          required: ["reference", "priority", "approved", "tolerance"],
          properties: {
            reference: {
              type: "string",
              title: "CAD or file URI",
              format: "uri",
              pattern: "^(cad|file):",
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["low", "normal", "high"],
            },
            approved: { type: "boolean", title: "Approved" },
            tolerance: {
              type: "number",
              title: "Tolerance (mm)",
              minimum: 0,
              maximum: 10,
            },
          },
        }),
      ),
  );
  server.registerResource(
    "bits-and-bolts",
    UI,
    { title: "Bits & Bolts", mimeType: "text/html;profile=mcp-app" },
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
  if (wasm)
    server.registerResource(
      "occt-wasm",
      "cad-resource://bits-and-bolts/occt-import-js.wasm",
      { title: "OpenCascade STEP importer", mimeType: "application/wasm" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/wasm",
            blob: bytesToBase64(wasm),
          },
        ],
      }),
    );
  return store.list().then((parts) => {
    for (const part of parts)
      registerPart(part.id, part.resourceUri, part.name);
  });
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

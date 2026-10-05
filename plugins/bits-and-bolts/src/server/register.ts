import type {
  ResourceTemplate,
  McpServer,
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import {
  createSettings,
  createMentions,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import {
  OpenAIFileEntrypointInputSchema,
  getResourcePath,
  type OpenAIFormResult,
  type OpenAIUiResourceMetadata,
} from "@openai/mcp-extensions";
import { z } from "zod/v4";

import {
  cadPartMetadataSchema,
  cadPreferencesSchema,
  publicCadPartSchema,
  type PublicCadPart,
} from "../shared/contracts.js";
import type { CatalogStore } from "./store.js";

declare const __LOCAL_FILESYSTEM__: boolean;

// The two SDKs share registration APIs; their entrypoints supply resource templates
// and form handling from the matching SDK.
export type CadServerOptions<Context = ServerContext> = {
  server: Pick<McpServer, "registerTool" | "registerResource" | "server">;
  resourceTemplate: typeof ResourceTemplate;
  partUriTemplate: string;
  store: Omit<CatalogStore, "import">;
  title?: string;
  html: string;
  icons: Icon[];
  formats: string[];
  elicit: (
    context: Context,
    params: OpenAIFormRequestParams,
  ) =>
    | OpenAIFormResult
    | InputRequiredResult
    | Promise<OpenAIFormResult | InputRequiredResult>;
  requestMeta: (context: Context) => Record<string, unknown> | undefined;
  wasm: { blob: string } | { text: string };
  assetOrigin?: string;
};
export const cadImportSchema = z.object({
  fileName: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export const cadResult = (data: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(data, (key, value) =>
        key === "previews" || key === "blob" ? undefined : value,
      ),
    },
  ],
  structuredContent: data,
});
const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
export function registerCadServer<Context = ServerContext>({
  server,
  resourceTemplate: ResourceTemplate,
  partUriTemplate,
  store,
  title = "Bits & Bolts",
  html,
  icons,
  formats,
  elicit: requestForm,
  requestMeta,
  wasm,
  assetOrigin,
}: CadServerOptions<Context>) {
  const entrypoint = { icons, annotations: readonly };
  const UI = "ui://bits-and-bolts/global-v35";
  const THREAD = "ui://bits-and-bolts/thread-v35";
  const FILE = "ui://bits-and-bolts/file-v35";
  const WIDGET = "ui://bits-and-bolts/widget-v35";
  const ui = (entrypoints: unknown[] = [], resourceUri = WIDGET) => ({
    ui: { resourceUri },
    "openai/ui": { entrypoints },
    "openai/iconStyle": "monochrome",
  });
  const view = async (
    data: Record<string, unknown> & { part?: PublicCadPart },
  ) => {
    return {
      ...cadResult({
        ...data,
        ...(data.part ? { part: cadPartMetadataSchema.parse(data.part) } : {}),
        preferences: await store.readSettings(),
        settingsLifetime: store.settingsLifetime,
        ...(assetOrigin
          ? { uploadUrl: `${assetOrigin}/bits-and-bolts/upload` }
          : {}),
        localFilesystem: __LOCAL_FILESYSTEM__ && store.importPath != null,
      }),
      ...(data.part
        ? { _meta: { previews: { isometric: data.part.previews.isometric } } }
        : {}),
    };
  };
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
  server.registerResource(
    "cad-part",
    new ResourceTemplate(partUriTemplate, {
      list: async () => ({
        resources: (await store.list()).map((part) => ({
          uri: part.resourceUri,
          name: part.id,
          title: part.name,
          mimeType: "text/markdown",
        })),
      }),
    }),
    { mimeType: "text/markdown" },
    async (uri, { id }) => {
      if (typeof id !== "string") throw Error("Invalid part ID.");
      const part = await find(id);
      return {
        contents: [
          {
            uri: uri.href,
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
  const settings = createSettings(
    server as unknown as Parameters<typeof createSettings>[0],
  );
  settings.register({
    fields: {
      units: { schema: cadPreferencesSchema.shape.units, title: "Units" },
      showGrid: {
        schema: cadPreferencesSchema.shape.showGrid,
        title: "Show grid",
      },
      defaultView: {
        schema: cadPreferencesSchema.shape.defaultView,
        title: "Default view",
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
        ],
      },
    ],
    read: () => store.readSettings(),
    update: (set) => store.updateSettings(set),
  });
  createMentions(
    server as unknown as Parameters<typeof createMentions>[0],
  ).setHandler(async ({ query }) => ({
    items: (await matching(query)).slice(0, 30).map((part) => ({
      type: "resource_link" as const,
      uri: part.resourceUri,
      name: part.fileName,
      title: part.name,
      mimeType: "text/markdown",
    })),
  }));
  server.registerTool(
    "cad.browse",
    {
      title,
      description: "Open the full Parts Library.",
      inputSchema: z.object({}),
      ...entrypoint,
      _meta: {
        ...ui(
          [
            {
              type: "global",
              quickAction: {
                title: "Choose a part",
                icons,
                target: {
                  type: "tool",
                  name: "cad.pickFile",
                  arguments: {},
                },
              },
            },
          ],
          UI,
        ),
        ui: { resourceUri: UI, visibility: ["app"] },
      },
    },
    async () => view({ page: "library" }),
  );
  server.registerTool(
    "cad.library",
    {
      title,
      description: "Browse and inspect CAD parts in the library.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: ui([], THREAD),
    },
    async () => view({ page: "library" }),
  );
  server.registerTool(
    "cad.tray",
    {
      title: "Parts Tray",
      description: "Open the parts library beside this conversation.",
      inputSchema: z.object({}),
      ...entrypoint,
      _meta: ui([{ type: "thread" }], THREAD),
    },
    async () => view({ page: "library" }),
  );
  server.registerTool(
    "cad.listParts",
    {
      title: "List CAD parts",
      description: "List all CAD parts in the library.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () =>
      cadResult({
        parts: (await store.list()).map((part) => ({
          ...part,
          previews: { isometric: part.previews.isometric },
        })),
      }),
  );
  server.registerTool(
    "cad.search",
    {
      title: "Search CAD parts",
      description: "Find CAD parts in the library.",
      inputSchema: z.object({ query: z.string().default("") }),
      outputSchema: z.object({ parts: z.array(cadPartMetadataSchema) }),
      annotations: readonly,
    },
    async ({ query }) =>
      cadResult({
        parts: (await matching(query)).map((part) =>
          cadPartMetadataSchema.parse(part),
        ),
      }),
  );
  server.registerTool(
    "cad.view",
    {
      title: "Open CAD part",
      description:
        "Show a library part inline in the 3D viewer, with an option to browse the full library.",
      inputSchema: z.object({ partId: z.string() }),
      annotations: readonly,
      _meta: ui(),
    },
    async ({ partId }) => view({ part: await find(partId) }),
  );
  server.registerTool(
    "cad.configureView",
    {
      title: "Configure CAD view",
      description: "Open a CAD part with the chosen camera and render mode.",
      inputSchema: z.object({
        partId: z.string(),
        camera: z.enum(["isometric", "front", "top"]).optional(),
        mode: z.enum(["solid", "wireframe", "edges"]).optional(),
      }),
      annotations: readonly,
      _meta: ui(),
    },
    async ({ partId, ...config }) =>
      view({ part: await find(partId), ...config }),
  );
  server.registerTool(
    "cad.open",
    {
      title: "Bits & Bolts CAD viewer",
      description: "Open a CAD file in the 3D viewer.",
      inputSchema: OpenAIFileEntrypointInputSchema,
      ...entrypoint,
      _meta: ui(
        [{ type: "file", extensions: formats.map((format) => "." + format) }],
        FILE,
      ),
    },
    async ({ file }) => view({ file }),
  );
  server.registerTool(
    "cad.readPart",
    {
      title: "Read CAD part",
      description: "Read a library part in its source or display format.",
      inputSchema: z.object({
        partId: z.string(),
        representation: z.enum(["source", "display"]).default("source"),
      }),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ partId, representation }) =>
      cadResult(await store.read(partId, representation)),
  );
  server.registerTool(
    "cad.savePreviews",
    {
      title: "Save CAD previews",
      description: "Save preview images for a library part.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        partId: z.string(),
        previews: publicCadPartSchema.shape.previews,
      }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ partId, previews }) =>
      cadResult({ part: await store.savePreviews(partId, previews) }),
  );
  if (__LOCAL_FILESYSTEM__ && store.localPath)
    server.registerTool(
      "cad.partPath",
      {
        title: "Get CAD part path",
        inputSchema: z.object({ partId: z.string() }),
        annotations: readonly,
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ partId }) => cadResult({ path: await store.localPath!(partId) }),
    );
  if (__LOCAL_FILESYSTEM__ && store.importPath)
    server.registerTool(
      "cad.addOpenFile",
      {
        title: "Add open CAD file to library",
        inputSchema: z.object({ fileName: z.string() }),
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ fileName }, context) => {
        const path = getResourcePath(
          requestMeta(context as unknown as Context),
        );
        if (!path)
          throw Error("The host did not provide a trusted CAD source path.");
        const part = await store.importPath!(path, fileName);
        return cadResult({ part });
      },
    );
  const elicit = (
    context: ServerContext,
    message: string,
    requestedSchema: OpenAIFormRequestParams["requestedSchema"],
  ) =>
    requestForm(context as unknown as Context, {
      mode: "form",
      message,
      requestedSchema,
    });
  server.registerTool(
    "cad.reference",
    {
      title: "Part reference",
      description: "Show names and descriptions of library parts in a dialog.",
      inputSchema: z.object({}),
      annotations: readonly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (_args, context) => {
      const form = await elicit(
        context,
        (await store.list())
          .map((p) => p.name + ": " + p.description)
          .join("\n\n"),
        { type: "object", properties: {} },
      );
      return "resultType" in form ? form : cadResult(form);
    },
  );
  server.registerTool(
    "cad.pickFile",
    {
      title: "Choose CAD part",
      description: "Choose a CAD part using thumbnails.",
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
              description: part.description,
              ...(part.previews.isometric
                ? {
                    "x-openai-thumbnail": {
                      src: part.previews.isometric,
                    },
                  }
                : {}),
            })),
          },
        },
      });
      if ("resultType" in form) return form;
      if (form.action !== "accept")
        return cadResult({ selection: form.action });
      return view({ part: await find(String(form.content.part)) });
    },
  );
  server.registerTool(
    "cad.pickReferences",
    {
      title: "Choose CAD references",
      description:
        "Choose CAD references from the library or your files and folders.",
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
            description: p.description,
            _meta: {
              ...(p.previews.isometric
                ? { "openai/thumbnail": { src: p.previews.isometric } }
                : {}),
              "openai/preview": {
                target: {
                  type: "resource_link",
                  uri: p.resourceUri,
                  name: p.fileName,
                  mimeType: "text/markdown",
                },
              },
            },
          })),
          userOptions:
            kind === "file"
              ? { kind, accept: formats.map((format) => "." + format) }
              : { kind },
        },
      };
      const form = await elicit(context, "Choose CAD references", {
        type: "object",
        required: ["references"],
        properties: { references: field },
      } as OpenAIFormRequestParams["requestedSchema"]);
      if ("resultType" in form) return form;
      return form.action === "accept"
        ? cadResult({
            selection: "accept",
            uris: Array.isArray(form.content.references)
              ? form.content.references
              : [form.content.references],
          })
        : cadResult({ selection: form.action });
    },
  );
  server.registerTool(
    "cad.reviewForm",
    {
      title: "Review part requirements",
      description: "Collect part review requirements for discussion in chat.",
      inputSchema: z.object({ partId: z.string().optional() }),
      annotations: readonly,
    },
    async ({ partId }, context) => {
      const part = partId == null ? null : await find(partId);
      const form = await elicit(
        context,
        part ? `Review ${part.name}` : "Review a CAD reference",
        {
          type: "object",
          required: ["reference", "priority", "approved", "tolerance"],
          properties: {
            reference: {
              type: "string",
              title: "Part reference",
              format: "uri",
              pattern: "^(mcp|cad|file):",
              ...(part ? { default: part.resourceUri } : {}),
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["low", "normal", "high"],
            },
            purpose: {
              type: "string",
              title: "Purpose",
              minLength: 1,
              "x-openai-suggestions": [
                { const: "prototype", title: "Prototype" },
              ],
            },
            checks: {
              type: "array",
              title: "Checks",
              items: {
                type: "string",
                minLength: 1,
                "x-openai-suggestions": [
                  {
                    const: "clearance",
                    title: "Clearance",
                    description: "Check spacing between assembled parts.",
                  },
                  {
                    const: "dimensions",
                    title: "Dimensions",
                    description: "Verify the overall size and tolerances.",
                  },
                  {
                    const: "printability",
                    title: "Printability",
                    description: "Review the shape for 3D printing.",
                  },
                ],
              },
            },
            approved: { type: "boolean", title: "Ready for review" },
            tolerance: {
              type: "number",
              title: "Tolerance (mm)",
              minimum: 0,
              maximum: 10,
            },
          },
        },
      );
      return "resultType" in form ? form : cadResult(form);
    },
  );
  const readUi = async (uri: URL, surface: string) => {
    const preferredDisplayMode = surface === "thread" ? "fullscreen" : "inline";
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: html.replace(
            "<html",
            `<html data-surface="${surface}" data-persist-library="${!__LOCAL_FILESYSTEM__ && surface === "global"}"`,
          ),
          _meta: {
            "openai/ui": {
              preferredDisplayMode,
              availableDisplayModes:
                surface === "widget"
                  ? ["inline", "fullscreen"]
                  : [preferredDisplayMode],
            } satisfies OpenAIUiResourceMetadata,
            ...(assetOrigin
              ? {
                  "openai/widgetCSP": {
                    connect_domains: [assetOrigin],
                    resource_domains: [assetOrigin],
                  },
                }
              : {}),
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: assetOrigin ? [assetOrigin] : [],
                resourceDomains: assetOrigin ? [assetOrigin] : [],
              },
            },
          },
        },
      ],
    };
  };
  for (const [surface, resourceUri] of [
    ["global", UI],
    ["thread", THREAD],
    ["file", FILE],
    ["widget", WIDGET],
  ]) {
    server.registerResource(
      `bits-and-bolts-${surface}`,
      resourceUri,
      { title, mimeType: "text/html;profile=mcp-app" },
      (uri) => readUi(uri, surface),
    );
    // Published app metadata still points to the v32 resources.
    const publishedUri = `ui://bits-and-bolts/${surface}-v32`;
    if (resourceUri !== publishedUri) {
      server.registerResource(
        `bits-and-bolts-${surface}-v32`,
        publishedUri,
        { title, mimeType: "text/html;profile=mcp-app" },
        (uri) => readUi(uri, surface),
      );
    }
  }
  server.registerResource(
    "occt-wasm",
    "cad-resource://bits-and-bolts/occt-import-js.wasm",
    { title: "OpenCascade STEP importer", mimeType: "application/wasm" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/wasm",
          ...wasm,
        },
      ],
    }),
  );
}

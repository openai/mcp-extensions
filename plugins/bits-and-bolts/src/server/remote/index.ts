import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  McpServer,
  ResourceTemplate,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import {
  accountFromAuthorization,
  demoAccounts,
  handleDemoOAuth,
  requireAccountResponse,
} from "./auth.js";
import { createMemoryLibrary, uploadLimit, type Seed } from "./memory-store.js";
import { registerCadServer, cadImportSchema, cadResult } from "../register.js";
import { requestFormInput } from "@openai/mcp-extensions/server";
import { z } from "zod/v4";

const root = new URL("./", import.meta.url);
const seeds: Seed[] = JSON.parse(
  await readFile(new URL("catalog.json", root), "utf8"),
);
const library = createMemoryLibrary(seeds);
const html = await readFile(new URL("app.html", root), "utf8");
const icons = [
  {
    src:
      "data:image/svg+xml," +
      encodeURIComponent(await readFile(new URL("icon.svg", root), "utf8")),
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];
const assets = new Map<string, { url: URL; type: string }>([
  [
    "/occt-import-js.wasm",
    { url: new URL("occt-import-js.wasm", root), type: "application/wasm" },
  ],
]);
for (const seed of seeds) {
  for (const path of [
    seed.assetPath,
    seed.assetPath.replace(/\.stl$/i, ".glb"),
  ]) {
    assets.set(`/models/${path}`, {
      url: new URL(`models/${path}`, root),
      type: path.endsWith(".glb")
        ? "model/gltf-binary"
        : "application/octet-stream",
    });
  }
}
// Give shared SDK tools CAD descriptions and app submission annotations.
const toolMetadata = {
  "settings.read": {
    description: "Read your units, grid, and default camera preferences.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  "settings.update": {
    description: "Update your units, grid, and default camera preferences.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  search_mentions: {
    description: "Find library parts to mention in a message.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
};
const mcp = createMcpHandler(
  async ({ requestInfo }) => {
    if (!requestInfo) throw Error("HTTP request context is required.");
    const authorization = requestInfo.headers.get("Authorization");
    const account = accountFromAuthorization(authorization);
    if (!account || !authorization)
      throw Error("Connect a demo library first.");
    const origin = new URL(requestInfo.url).origin;
    const server = new McpServer({
      name: "bits-and-bolts-remote",
      title: "Bits & Bolts Remote",
      version: "1.0.1",
      icons,
    });
    const store = library.connect(origin, account, authorization);
    server.registerTool(
      "cad.importPart",
      {
        title: "Add CAD file",
        description: "Add an uploaded CAD file to your library.",
        inputSchema: cadImportSchema.extend({ uploadPath: z.string() }),
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
      server: {
        server: server.server,
        registerResource: server.registerResource.bind(server),
        registerTool(name, definition, handler) {
          return server.registerTool(
            name,
            {
              ...definition,
              ...toolMetadata[name as keyof typeof toolMetadata],
            },
            handler,
          );
        },
      },
      title: "Bits & Bolts Remote",
      html,
      icons,
      store,
      resourceTemplate: ResourceTemplate,
      partUriTemplate: "cad://bits-and-bolts/{id}",
      formats: ["stl", "3mf", "step", "stp"],
      assetOrigin: origin,
      wasm: { text: `${origin}/occt-import-js.wasm` },
      elicit: (context, params) =>
        requestFormInput(context, { ...params, key: "form" }),
      requestMeta: (context) => context.mcpReq._meta,
    });
    return server;
  },
  { legacy: "stateless" },
);

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const oauth = await handleDemoOAuth(request);
  if (oauth) return oauth;
  if (url.pathname === "/bits-and-bolts/mcp") {
    return accountFromAuthorization(request.headers.get("Authorization"))
      ? mcp.fetch(request)
      : requireAccountResponse(url.origin);
  }
  if (url.pathname === "/bits-and-bolts/upload" && request.method === "POST") {
    const reader = request.body?.getReader();
    if (!reader) return new Response("No CAD file supplied.", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > uploadLimit) {
        await reader.cancel();
        return new Response("CAD file exceeds 50 MB.", { status: 413 });
      }
      chunks.push(chunk.value);
    }
    try {
      return Response.json({
        uploadPath: library.upload(
          url.searchParams.get("fileName") ?? "",
          Buffer.concat(chunks),
        ),
      });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Upload failed.",
        { status: 400 },
      );
    }
  }
  const account = demoAccounts.find(
    (item) => item.id === url.searchParams.get("account"),
  );
  if (account && request.method === "GET") {
    const preview = /^\/bits-and-bolts\/previews\/([^/]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    if (preview) {
      const image = library.preview(account, preview[1], preview[2]);
      return image
        ? new Response(image.bytes, {
            headers: { "Content-Type": image.mimeType },
          })
        : new Response("Not found", { status: 404 });
    }
    const file = /^\/bits-and-bolts\/files\/([^/]+)$/.exec(url.pathname);
    if (file) {
      const bytes = library.file(account, file[1]);
      return bytes
        ? new Response(bytes, {
            headers: { "Content-Type": "application/octet-stream" },
          })
        : new Response("Not found", { status: 404 });
    }
  }
  const asset = assets.get(url.pathname);
  if (asset && request.method === "GET")
    return new Response(
      Readable.toWeb(createReadStream(asset.url)) as ReadableStream,
      { headers: { "Content-Type": asset.type } },
    );
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(
      "Bits & Bolts Remote\nConnect with OAuth at /bits-and-bolts/mcp.\nSettings, imported parts, and previews reset when this server restarts.\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  }
  return new Response("Not found", { status: 404 });
}

const publicOrigin = process.env.PUBLIC_URL
  ? new URL(process.env.PUBLIC_URL).origin
  : null;
const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name, Last-Event-ID",
    "Access-Control-Expose-Headers":
      "MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const request = new Request(
      new URL(req.url ?? "/", publicOrigin ?? `http://${req.headers.host}`),
      {
        method: req.method,
        headers,
        ...(!["GET", "HEAD"].includes(req.method ?? "GET")
          ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }
          : {}),
      },
    );
    const response = await route(request);
    res.writeHead(response.status, {
      ...cors,
      ...Object.fromEntries(response.headers),
    });
    if (response.body)
      await pipeline(Readable.fromWeb(response.body as any), res);
    else res.end();
  } catch (error) {
    console.error("Remote request failed", { error });
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(500, cors);
      res.end("The remote CAD service could not complete the request.");
    }
  }
}).listen(port, process.env.HOST ?? "0.0.0.0", () => {
  console.log("Remote server started", {
    port,
    origin: publicOrigin,
    persistence: "memory",
  });
});

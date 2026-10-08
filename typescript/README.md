# OpenAI MCP Extensions for TypeScript and JavaScript

This SDK provides TypeScript APIs that extend the official [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) and [@modelcontextprotocol/ext-apps](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps) SDKs to make it easier to implement the [OpenAI MCP Extensions spec](../docs/spec.md) for TypeScript MCP Servers and MCP Apps.

Use `@openai/mcp-extensions` for shared types and schemas, `@openai/mcp-extensions/server` for server code and `@openai/mcp-extensions/app` for app code. This SDK and README contain examples that run in MCP Apps and on MCP Servers. You can identify where a given code block should be used from its imports.

## Installation

Install the SDK from npm:

```sh
pnpm add @openai/mcp-extensions
```

## MCP Server Setup

Enable OpenAI extensions for an MCP Server created with the MCP TypeScript SDK.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

const server = new McpServer({ name: "my-server", version: "1.0.0" });
const openaiExtensions = new OpenAIExtensions(server);
```

## MCP App Setup

Enable OpenAI extensions for an MCP App.

```ts
import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const app = new App({ name: "my-app", version: "1.0.0" });
const openaiExtensions = new OpenAIExtensions(app);

app.ontoolresult = (result) => render(result.structuredContent);
await app.connect();
```

Register `app.ontoolresult` before `app.connect()` to render the initial result instead of calling the tool again, which delays rendering and causes visible flicker.

OpenAI extension categories (`message`, `modelContext`, `files`, and `resources`) are set as fields on `openaiExtensions`. They are undefined until initialization completes. If a given extension is unsupported on the current host, it may remain undefined even after initialization.

## App Styling

MCP Apps work best when they match the look and feel of ChatGPT. To help with this, this SDK provides a stylesheet you can use to make your components feel more native.

Apply the host’s theme and styles when your app connects and whenever they change.

```ts
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import "@openai/mcp-extensions/app/styles.css";

const app = new App({ name: "my-app", version: "1.0.0" });
const openaiExtensions = new OpenAIExtensions(app);

function applyHostContext(context: ReturnType<App["getHostContext"]>): void {
  if (context?.theme != null) applyDocumentTheme(context.theme);
  if (context?.styles?.variables != null) {
    applyHostStyleVariables(context.styles.variables);
  }
}

app.addEventListener("hostcontextchanged", applyHostContext);
app.ontoolresult = (result) => render(result.structuredContent);
await app.connect();
applyHostContext(app.getHostContext());
```

Style a card with a labeled input and button using the app stylesheet.

```html
<section class="card">
  <h2>New issue</h2>
  <label class="form-label" for="title">Title</label>
  <input class="form-control" id="title" placeholder="What needs attention?" />
  <button class="btn btn-primary" type="button">Create issue</button>
</section>
```

See [styles.css](styles.css) for the available styles. Use wrappers for app-specific layout to preserve the controls' appearance.

ChatGPT Desktop lets users choose `default` or `pointer` for interactive controls. To match that setting in your app, use the `cursor-interaction` CSS class. If the host omits its cursor preference or sends an unsupported value, the cursor defaults to `pointer`.

```html
<button class="cursor-interaction" type="button">Run</button>
```

Bundle or inline the CSS in your app's HTML. The default iframe CSP can block external stylesheets. Without a frontend build, extract `package/styles.css` from the release tarball and inline it in your app resource.

For a complete React plugin, see [the Bits & Bolts sidebar and file viewer](../plugins/bits-and-bolts/README.md).

## [UI Entrypoints](../docs/spec.md#mcp-app-entrypoints)

> **Deprecated:** `type: "settings"` app entrypoints are retained for compatibility. Use [structured settings](#structured-settings) instead.

```ts
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import type {
  OpenAIUiResourceMetadata,
  OpenAIUiToolMetadata,
} from "@openai/mcp-extensions/server";

const TABLE_URI = "ui://table/viewer";

registerAppResource(server, "table", TABLE_URI, {}, async () => ({
  contents: [
    {
      uri: TABLE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: TABLE_HTML,
      _meta: {
        "openai/ui": {
          preferredDisplayMode: "fullscreen",
          availableDisplayModes: ["inline", "fullscreen"],
        } satisfies OpenAIUiResourceMetadata,
      },
    },
  ],
}));

registerAppTool(
  server,
  "table.open",
  {
    icons: [
      {
        src: "https://example.com/cad-library.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
    _meta: {
      ui: { resourceUri: TABLE_URI, visibility: ["app"] },
      "openai/ui": {
        // Include one or more entrypoints.
        entrypoints: [
          {
            type: "global",
            quickAction: {
              title: "New table",
              icons: [{ src: "https://example.com/plus.svg" }],
              target: { type: "tool", name: "create_table", arguments: {} },
            },
          },
          { type: "file", extensions: [".csv", ".tsv"] },
        ],
      } satisfies OpenAIUiToolMetadata,
    },
  },
  async () => ({ content: [] }),
);
```

## [File Extension Handlers](../docs/spec.md#file-extension-entrypoint)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { OpenAIFileEntrypointInputSchema } from "@openai/mcp-extensions/app";

const openaiExtensions = new OpenAIExtensions(app);

app.addEventListener("toolinput", async ({ arguments: args }) => {
  const input = OpenAIFileEntrypointInputSchema.safeParse(args);
  if (!input.success) {
    return;
  }

  if (openaiExtensions.resources == null) {
    return;
  }
  const resource = await openaiExtensions.resources.read({
    uri: input.data.file.resourceUri,
  });
  const content = resource.contents[0];
});

// Register before connecting so the initial tool input is not missed.
await app.connect();
```

### [Resource Metadata](../docs/spec.md#resource-writes)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const resource = await openaiExtensions.resources?.read({
  uri: resourceUri,
});

const content = resource?.contents[0];
if (content?.openaiMetadata) {
  const { etag, writable } = content.openaiMetadata;
  console.log({ etag, writable });
}
```

### [Resource Representation](../docs/spec.md#resourcesread-representation)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const resource = await openaiExtensions.resources?.read({
  uri: resourceUri,
  representation: "blob",
});

const content = resource?.contents[0];
const blob = content != null && "blob" in content ? content.blob : null;
```

### [Resource Subscriptions](../docs/spec.md#resource-subscriptions)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const disposeUpdateHandler = openaiExtensions.resources?.addUpdateHandler(
  async ({ params }) => {
    if (params.uri === resourceUri) {
      await reloadFile(resourceUri);
    }
  },
);

await openaiExtensions.resources?.subscribe({ uri: resourceUri });

// Stop receiving updates when the file is no longer being viewed.
disposeUpdateHandler?.();
await openaiExtensions.resources?.unsubscribe({ uri: resourceUri });
```

### [Resource Writes](../docs/spec.md#resource-writes)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const resource = await openaiExtensions.resources?.read({
  uri: resourceUri,
});
const metadata = resource?.contents[0]?.openaiMetadata;

if (metadata?.writable) {
  const result = await openaiExtensions.resources?.write(resourceUri, {
    text: updatedText,
    ...(metadata.etag == null ? {} : { ifMatch: metadata.etag }),
  });

  switch (result?.outcome) {
    case "saved":
      break;
    case "conflict":
      await reloadFile(resourceUri);
      break;
    case "too-large":
      showError(`File exceeds the ${result.maxBytes}-byte write limit.`);
  }
}
```

## [Structured Settings](../docs/spec.md#structured-settings)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { z } from "zod";

import { loadPreferences, updatePreferences } from "./preferences.js";

const server = new McpServer({ name: "viewer", version: "1.0.0" });
const extensions = new OpenAIExtensions(server);
extensions.settings?.register({
  fields: {
    units: {
      schema: z.enum(["mm", "in"]),
      title: "Measurement units",
    },
    showGrid: {
      schema: z.boolean(),
      title: "Show grid",
    },
  },
  // Optionally arrange fields into groups.
  // Omitted properties are included in an "Other settings" group below all listed groups.
  layout: [
    {
      kind: "group",
      title: "Display",
      items: [
        { kind: "property", property: "units" },
        { kind: "property", property: "showGrid" },
      ],
    },
  ],
  read: (extra) => loadPreferences(extra.authInfo),
  update: (set, extra) => updatePreferences(set, extra.authInfo),
});
```

## [Deep Links](../docs/spec.md#deep-links)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const openaiExtensions = new OpenAIExtensions(app);

function applyDeepLink(url: string): void {
  // Validate the app-specific route, then update the app's navigation state.
  console.log({ url });
}

function handleDeepLink(): void {
  const deepLink = openaiExtensions.deepLink.getCurrent();
  if (deepLink === undefined) {
    return;
  }

  applyDeepLink(deepLink.url);
}

app.addEventListener("hostcontextchanged", handleDeepLink);
await app.connect();
handleDeepLink();
```

## [ui/update-model-context](../docs/spec.md#context-changed-notifications)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const openaiExtensions = new OpenAIExtensions(app);

function syncCart(): void {
  const current = openaiExtensions.modelContext?.getCurrent();
  if (current !== undefined) {
    const items = current?.structuredContent?.items;
    restoreCart(
      Array.isArray(items)
        ? items.filter((item): item is string => typeof item === "string")
        : [],
    );
  }
}

app.addEventListener("hostcontextchanged", syncCart);
await app.connect();
syncCart();

const modelContext = openaiExtensions.modelContext;
if (modelContext != null) {
  const items = ["Coffee", "Tea"];
  const update = await modelContext.update({
    content: [
      {
        type: "text",
        text: `Selected shopping cart items: ${items.join(", ")}.`,
      },
    ],
    structuredContent: { items },
  });

  console.log(update?.updateId);
}
```

## [ui/message](../docs/spec.md#uimessage-extensions)

Send app content without changing the user's existing draft.

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const openaiExtensions = new OpenAIExtensions(app);
await app.connect();

const message = openaiExtensions.message;
if (message != null) {
  await message.send({
    role: "user",
    content: [{ type: "text", text: "Compare the items in my shopping cart." }],
  });
}
```

Open a fresh editable draft:

```ts
await openaiExtensions.message?.send({
  role: "user",
  content: [{ type: "text", text: "Help me design a bracket." }],
  _meta: {
    "openai/message": { target: "new", send: false },
  },
});
```

## [Opening Local Files](../docs/spec.md#opening-local-files)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const openaiExtensions = new OpenAIExtensions(app);
await app.connect();

await openaiExtensions.files?.open("/workspace/docs/index.html");
```

## [Filesystem Access](../docs/spec.md#filesystem-access)

**MCP App**

Read a related file through a server tool using a path relative to the opened file.

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/app";

const result = await app.callServerTool({
  name: "files.read-relative",
  arguments: { relativePath: "./Callout.tsx" },
});

if (result.isError) {
  throw new Error("Unable to read the related file.");
}
const content = result.content.find((item) => item.type === "text");
if (content == null) {
  throw new Error("The tool did not return text.");
}
const text = content.text;
```

**MCP Server**

Read files relative to an opened file while keeping access within its directory.

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/server";
import { getResourcePath } from "@openai/mcp-extensions/server";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

function isWithin(baseDirectory: string, candidatePath: string): boolean {
  const pathWithinBase = relative(baseDirectory, candidatePath);
  return (
    pathWithinBase !== ".." &&
    !pathWithinBase.startsWith(`..${sep}`) &&
    !isAbsolute(pathWithinBase)
  );
}

server.registerTool(
  "files.read-relative",
  {
    inputSchema: {
      relativePath: z.string(),
    },
  },
  async ({ relativePath }, extra) => {
    const openedFilePath = getResourcePath(extra._meta);

    if (openedFilePath == null) {
      throw new Error("Missing resource path.");
    }

    try {
      const baseDirectory = await realpath(dirname(openedFilePath));
      const requestedPath = resolve(baseDirectory, relativePath);
      if (!isWithin(baseDirectory, requestedPath)) {
        throw new Error();
      }

      const siblingPath = await realpath(requestedPath);
      if (!isWithin(baseDirectory, siblingPath)) {
        throw new Error();
      }

      const text = await readFile(siblingPath, "utf8");
      return { content: [{ type: "text", text }] };
    } catch {
      // Do not expose the host filesystem path to the app.
      throw new Error("Unable to read the requested file.");
    }
  },
);
```

## [Composer Mentions](../docs/spec.md#composer-at-mentions)

```ts
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

openaiExtensions.mentions.setHandler(async ({ query }) => ({
  items: await searchMentions({ query }),
}));
```

## [Form Elicitation](../docs/spec.md#openai-form-elicitation)

### Multi-round-trip Requests

**NOTE:** OpenAI-registered MCP servers require MCP `2026-07-28` or later and multi-round-trip requests for form elicitation. Direct MCP connections still support legacy forms.

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { requestFormInput } from "@openai/mcp-extensions/server";

const server = new McpServer({ name: "forms", version: "1" });
server.registerTool("choose_image", {}, (context) => {
  const result = requestFormInput(context, {
    key: "image",
    mode: "form",
    message: "Choose a reference image",
    requestedSchema: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string", format: "uri" },
          minItems: 1,
          maxItems: 1,
          "x-openai-input": {
            type: "resource",
            options: [{ uri: "file:///image.png", name: "image.png" }],
          },
        },
      },
      required: ["images"],
    },
  });
  if ("resultType" in result) return result;
  return { content: [], structuredContent: result };
});
```

### Legacy requests

MCP Servers that do not yet support `2026-07-28` MUST use the legacy `openai/elicitation/create` flow.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenAIExtensions } from "@openai/mcp-extensions/server";

const server = new McpServer({ name: "forms", version: "1" });
const openaiExtensions = new OpenAIExtensions(server);

server.registerTool("choose_image", {}, async () => {
  const result = await openaiExtensions.elicitInputLegacy({
    mode: "form",
    message: "Choose reference images",
    requestedSchema: {
      type: "object",
      properties: {
        images: {
          type: "array",
          items: { type: "string", format: "uri" },
          minItems: 1,
          maxItems: 1,
          "x-openai-input": {
            type: "resource",
            options: [{ uri: "file:///image.png", name: "image.png" }],
          },
        },
      },
      required: ["images"],
    },
  });

  return { content: [], structuredContent: result };
});
```

### Examples

The following examples work with multi round-trip requests and legacy requests.

#### Suggested Values

Users can enter values that are not listed. The same field constraints apply to suggested and entered values.

```ts
import type { OpenAIForm } from "@openai/mcp-extensions/server";

const reviewSchema = {
  type: "object",
  properties: {
    purpose: {
      type: "string",
      minLength: 1,
      "x-openai-suggestions": [{ const: "prototype", title: "Prototype" }],
    },
    checks: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        "x-openai-suggestions": [{ const: "clearance", title: "Clearance" }],
      },
    },
  },
} satisfies OpenAIForm;
```

#### Resource Selection

```ts
import type { OpenAIForm } from "@openai/mcp-extensions/server";

const requestedSchema = {
  type: "object",
  properties: {
    images: {
      type: "array",
      items: { type: "string", format: "uri" },
      maxItems: 5,
      default: ["file:///images/sales.png"],
      "x-openai-input": {
        type: "resource",
        options: [
          {
            uri: "file:///images/sales.png",
            name: "sales.png",
            title: "Sales image",
            _meta: {
              "openai/thumbnail": { src: "https://example.com/sales.png" },
              "openai/preview": {
                target: {
                  type: "resource_link",
                  uri: "file:///images/sales.png",
                  name: "sales.png",
                  mimeType: "image/png",
                },
              },
            },
          },
        ],
        userOptions: { accept: ["image/*"] },
      },
    },
  },
  required: ["images"],
} satisfies OpenAIForm;
```

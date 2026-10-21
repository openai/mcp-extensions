# Patterns

These patterns complement [spec.md](spec.md) with optional guidance for building Extensions that provide a good user experience.

## Versioning

Older desktop versions may lack the Extensions APIs your app needs. For apps using the extensions introduced at DevDay 2026, use `26.928.20710` as the minimum desktop version. Check it when the app opens from any entrypoint and show an update message on older builds.

Use this minimum version for desktop only. Check ChatGPT's advertised capabilities for individual features, and update compatibility checks when the APIs your app uses change or are deprecated.

For example, see how Bits & Bolts [checks the desktop version](../plugins/bits-and-bolts/src/app/controller.ts#L1287) before enabling the app.

## MCP App UI

### Responsive layouts

Consider how your app looks across devices. Extensions work across platforms, but your UI still needs to adapt to the available space. Check entrypoint views at a few representative sizes, such as 375 × 812, 768 × 1024, and 1440 × 900.

For example, see how Bits & Bolts [adjusts its layout for narrow screens](../plugins/bits-and-bolts/src/app/index.html#L520), wrapping the toolbar and placing the inspector below the viewer.

### Safe areas

Respect ChatGPT's safe-area insets, as defined in the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx). Keep content and controls clear of those edges.

For example, see how Bits & Bolts [applies ChatGPT's insets](../plugins/bits-and-bolts/src/app/controller.ts#L680) at startup and whenever they change, then [uses them as padding on a safe-area wrapper](../plugins/bits-and-bolts/src/app/index.html#L27).

### Display modes

Use `requestDisplayMode` to change modes in response to a user interaction, such as opening a selected image fullscreen. Do not add dedicated buttons for changing display modes. ChatGPT provides these out of the box.

Set `preferredDisplayMode` and `availableDisplayModes` in your [resource metadata](spec.md#display-modes) so ChatGPT can choose a display mode before rendering the app.

Prefer `fullscreen` for most interactive apps, especially those that should remain open across conversation turns. Use `inline` sparingly for brief interactions, such as a visualization, confirmation, or one-time action.

For example, see how Bits & Bolts shows a single part inline and opens the full Parts Tray in fullscreen when the user selects [**View library**](../plugins/bits-and-bolts/src/app/controller.ts#L1088).

### Host styles

Use `@openai/mcp-extensions/app/styles.css` for controls that follow ChatGPT's appearance. ChatGPT provides color and style values through `hostContext.styles.variables`. Your app applies them to its document when it connects and whenever they change.

For example, see how Bits & Bolts [applies ChatGPT's theme and style variables](../plugins/bits-and-bolts/src/app/controller.ts#L695) throughout the library and parts view.

## Model Context and Interaction

Design your MCP App so the model can use it like another user, with visibility into everything the user sees and the ability to take the same actions on their behalf.

ChatGPT supports providing context to the model both visibly in the composer and invisibly as background context.

### Explicit context

Use `content` when the user selects something to include in the chat, such as annotating or highlighting a specific part.

For example, Bits & Bolts sends the annotation in [`content`](../plugins/bits-and-bolts/src/app/controller.ts#L707), with its [text and metadata](../plugins/bits-and-bolts/src/app/point-annotations.ts#L188):

```json
{
  "content": [
    {
      "type": "text",
      "text": "Point 1 on Yeet keycap: Make this edge rounder"
    }
  ]
}
```

### Background context

Use `structuredContent` as the user interacts with the app normally, such as navigating to a specific part.

For example, Bits & Bolts sends the current view in [`structuredContent`](../plugins/bits-and-bolts/src/app/controller.ts#L720):

```json
{
  "structuredContent": {
    "page": "viewer",
    "schematic": "Yeet keycap",
    "camera": "isometric"
  }
}
```

### WebMCP app tools

Use [WebMCP app tools](spec.md#webmcp) to let the model interact directly with the app like a user.

For example, register a tool that reads the app's current page title:

```js
document.modelContext?.registerTool({
  name: "get_title",
  description: "Read the current page title.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async execute() {
    return JSON.stringify({ title: document.title });
  },
});
```

### MCP server tools

Use MCP server tools to provide additional details about a resource or change it on the server.

For example, Bits & Bolts' [`cad.search`](../plugins/bits-and-bolts/src/server/register.ts#L278) returns part details and links to notes:

```json
{
  "query": "Yeet"
}
```

## Global Entrypoint

### Icons

Use the [Figma icon template](https://www.figma.com/design/k1TPwkpYDbcRQrU34nUnNL/Plugin-icon-template?node-id=3933-543&t=25xd5JgJ3UgQGsFi-0) as a starting point for an icon with:

- A simple, single-color stroke design.
- A transparent background.
- A 20 × 20 viewport and 1.33px strokes.

For example, refer to Bits & Bolts' [light](../plugins/bits-and-bolts/assets/icon.svg) and [dark](../plugins/bits-and-bolts/assets/icon-dark.svg) entrypoint icons below:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../plugins/bits-and-bolts/assets/icon-dark.svg">
  <img src="../plugins/bits-and-bolts/assets/icon.svg" alt="Bits & Bolts icon" width="64" height="64">
</picture>

### Caching

Prioritize fast loading for global entrypoints and your MCP Apps so they feel native in ChatGPT. Displaying a global entrypoint when Desktop starts requires three pieces:

| Piece                                                                                                                                                | Cached by ChatGPT? |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Sidebar menu item / icon                                                                                                                              | Yes                |
| [UI resource (HTML)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx#ui-resource-format)                           | Yes                |
| [Tool result](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx#2-tool-result-via-uinotificationstool-result-notification) | No                 |

Persist tool results in `localStorage`, which survives Desktop restarts. Use a stale-while-revalidate pattern: render cached data as soon as the app loads, then replace it when fresh tool results arrive.

For example, Bits & Bolts Remote renders its [cached Parts Library](../plugins/bits-and-bolts/src/app/library-cache.ts), then [refreshes it in the background](../plugins/bits-and-bolts/src/app/controller.ts#L31):

```ts
localStorage.setItem(
  "bits-and-bolts:library:v1",
  JSON.stringify({
    parts: parts.map((part) => ({
      ...part,
      previews: { isometric: part.previews.isometric },
    })),
  }),
);
```

## Entrypoint Declaration

Prefer a dedicated tool for each entrypoint. Giving the same tool multiple entrypoints can confuse users.

For example, Bits & Bolts uses [`cad.browse`](../plugins/bits-and-bolts/src/server/register.ts#L204) for its global entrypoint and [`cad.tray`](../plugins/bits-and-bolts/src/server/register.ts#L245) for its thread entrypoint.

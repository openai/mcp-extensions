# Patterns

These patterns complement [spec.md](spec.md) with optional guidance for building Extensions that provide a good user experience.

## Versioning

Check ChatGPT's advertised capabilities for the features your app uses, and show an update message when the host is too old.

For example, see how Bits & Bolts [checks the desktop version](../plugins/bits-and-bolts/src/app/controller.ts#L1287) before enabling the app.

## MCP App UI

### Responsive layouts

Consider how your app looks across devices. Extensions work across platforms, but your UI still needs to adapt to the available space. Check entrypoint views at a few representative sizes, such as 375 × 812, 768 × 1024, and 1440 × 900.

For example, see how Bits & Bolts [adjusts its layout for narrow screens](../plugins/bits-and-bolts/src/app/index.html#L520), wrapping the toolbar and placing the inspector below the viewer.

### Safe areas

Respect ChatGPT's safe-area insets, as defined in the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx). Keep content and controls clear of those edges.

For example, see how Bits & Bolts [applies ChatGPT's insets](../plugins/bits-and-bolts/src/app/controller.ts#L680) at startup and whenever they change, then [uses them as body padding](../plugins/bits-and-bolts/src/app/index.html#L20).

### Display modes

Use `requestDisplayMode` to change modes in response to a user interaction, such as opening a selected image fullscreen. Do not add dedicated buttons for changing display modes. ChatGPT provides these out of the box.

Set `preferredDisplayMode` and `availableDisplayModes` in your [resource metadata](spec.md#display-modes) so ChatGPT can choose a display mode before rendering the app.

Prefer `fullscreen` for most interactive apps, especially those that should remain open across conversation turns. Use `inline` sparingly for brief interactions, such as a visualization, confirmation, or one-time action.

For example, see how Bits & Bolts shows a single part inline and opens the full Parts Tray in fullscreen when the user selects [**View library**](../plugins/bits-and-bolts/src/app/controller.ts#L1088).

### Host styles

Use `@openai/mcp-extensions/app/styles.css` for controls that follow ChatGPT's appearance. ChatGPT provides color and style values through `hostContext.styles.variables`. Your app applies them to its document when it connects and whenever they change.

For example, see how Bits & Bolts [applies ChatGPT's theme and style variables](../plugins/bits-and-bolts/src/app/controller.ts#L695) throughout the library and parts view.

## Model Context

Users should feel that the model understands what they see and do in an MCP App. Use the decision table below to keep the user, MCP App, and model aligned on the app's current state.

| Mechanism | When to use it |
| --- | --- |
| `ui/update-model-context`: `content` | Attach content the user explicitly selects, such as an item they add to chat. |
| `ui/update-model-context`: `structuredContent` | Provide high-level background context the model needs to understand what has changed this turn, such as a page navigation. |
| Server-side MCP tools | Let the model fetch additional details about changes reported in model context or perform mutations. |

For example, see how Bits & Bolts handles a user opening the Yeet keycap:

1. The user adds the part as a chat attachment. The app [adds the selected part](../plugins/bits-and-bolts/src/app/controller.ts#L586) as a `content` block and [sends it through `ui/update-model-context`](../plugins/bits-and-bolts/src/app/controller.ts#L651).
2. As the user navigates or adjusts the view, the app [updates `structuredContent`](../plugins/bits-and-bolts/src/app/controller.ts#L605) with the page, part, camera, and other view details so the model knows what the user is looking at.
3. If the model needs more information about the part, the server's [`cad.search` tool](../plugins/bits-and-bolts/src/server/register.ts#L271) returns part details and links to notes.
4. If the user asks to change the view, the model can call the server's [`cad.configureView` tool](../plugins/bits-and-bolts/src/server/register.ts#L305) to select a camera preset or render mode. The app applies the returned settings.

![Yeet keycap attached to chat and identified by the model](https://github.com/user-attachments/assets/664fb0a9-64e6-4d2d-ae45-3c750c285358)

## Entrypoints

### Global entrypoint caching

Consider caching the data needed to render your global entrypoint so it opens immediately on subsequent visits. MCP App local storage is persistent on desktop restart and browser page refresh, so you can show cached results immediately after restarting ChatGPT and refresh them in the background. Your global entrypoint's sidebar tab and widget HTML are already cached by default.

For example, Bits & Bolts restores its cached Parts Library before fetching fresh results. It stores part metadata and isometric previews under `bits-and-bolts:library:v1`:

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

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L39)

[plugins/bits-and-bolts/src/app/library-cache.ts](../plugins/bits-and-bolts/src/app/library-cache.ts)

### Global icons

Use the [Figma icon template](https://www.figma.com/design/k1TPwkpYDbcRQrU34nUnNL/Plugin-icon-template?node-id=3933-543&t=25xd5JgJ3UgQGsFi-0) as a starting point for an icon with:

- A simple, single-color stroke design.
- A transparent background.
- A 20 × 20 viewport and 1.33px strokes.

For example, refer to Bits & Bolts' [entrypoint icon](../plugins/bits-and-bolts/src/server/remote/assets/icon.svg) below:

<img src="../plugins/bits-and-bolts/src/server/remote/assets/icon.svg" alt="Bits & Bolts Remote icon" width="64" height="64">

### Declaration

Declare at most one entrypoint per tool, and give each entrypoint a distinct `title`. Thread and file entrypoint titles should describe the view they open rather than repeat the plugin name.

For example, see how Bits & Bolts names its global entrypoint [Bits & Bolts](../plugins/bits-and-bolts/src/server/register.ts#L204) for the full library and its thread entrypoint [Parts Tray](../plugins/bits-and-bolts/src/server/register.ts#L245) for a parts list alongside the conversation.

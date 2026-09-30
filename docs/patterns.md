# MCP App Patterns

These recommendations help apps fit naturally into ChatGPT. For an MVP, prioritize the majority experience and keep the whole implementation simple; avoid adding machinery for rare edge cases. The Bits & Bolts examples below illustrate integration with the host.

## Host compatibility

For an app that depends on DevDay desktop extensions, `26.928.20710` is a compatibility baseline. Apply a minimum version only to the features your app requires. Show an update message on older desktop builds before users can interact with the app. Compare version components numerically. Web and mobile use different version formats; keep the desktop threshold scoped to desktop and check advertised capabilities for individual features.

Relevant fields from the `ui/initialize` result:

```json
{
  "hostInfo": { "name": "ChatGPT", "version": "26.928.20710" },
  "hostContext": { "platform": "desktop", "displayMode": "fullscreen" }
}
```

Read `hostInfo` and `hostContext` from the initialization handshake before enabling features that need a newer host. Bits & Bolts illustrates receiving these fields during initialization.

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L1097)

## Responsive layouts

Adapt to the available space in every display mode: inline widgets, narrow thread panels, fullscreen views, and mobile screens. Keep controls reachable without horizontal scrolling. Wrap toolbars, collapse columns, provide touch-sized controls, and respect safe-area insets. Resize embedded content when its container changes. Verify the app at 375 × 812, 768 × 1024, and 1440 × 900, including its controls and defined behavior at each width.

Bits & Bolts uses viewport breakpoints and display-mode styles for its library and viewer, applies host safe-area insets, and observes container size changes.

[plugins/bits-and-bolts/src/app/index.html](../plugins/bits-and-bolts/src/app/index.html#L120)

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L456)

## Display modes

Choose supported and preferred display modes for each view. Default persistent workspaces to fullscreen, which opens in the side panel in a Codex conversation. Use inline for confirmations, one-time actions, or simple ephemeral visuals. A compact layout alone is not a reason to support inline; support both modes only when each provides a useful experience.

Declare supported modes on the UI resource as well as during app initialization so the host can choose a mode before loading the app. Verify actual placement: a preference is a hint. If fullscreen is intended but the app starts inline, request fullscreen once after connecting only when the host advertises it, and accept the returned mode. Do not expand deliberately inline views or reopen a panel the user closed.

Bits & Bolts declares resource display modes and adapts its controls to the current host mode.

[plugins/bits-and-bolts/src/server/register.ts](../plugins/bits-and-bolts/src/server/register.ts#L494)

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L513)

## Choose the surfaces

Use global entrypoints for a full library, thread entrypoints for the current conversation's working set, and settings for persistent preferences. Add views and navigation when the workflow needs them; keep search and data tools usable without opening a view. Adapt the example to the app's language and workflow rather than copying its full stack.

Bits & Bolts provides a global Parts Library, a thread Parts Tray, and measurement settings.

[plugins/bits-and-bolts/src/server/register.ts](../plugins/bits-and-bolts/src/server/register.ts#L113)

## Launch data

Use the initial tool result delivered by the host for the first render instead of calling the opener again for the same data. Handle later activations and host-context changes. Verify the rendered controls, placement, and data changes in the intended host; an opener returning JSON alone does not prove the view rendered.

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L733)

## File editing

Use the host's resource bridge for opened files; sending a local filesystem path to a remote server does not grant access. Respect the host's write capability, preserve unsaved edits when a file changes elsewhere, and use version checks when saving.

Bits & Bolts keeps unsaved geometry on external changes and offers explicit reload and discard actions.

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L306)

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L750)

## Conversation context

Attach relevant selections and resolve mentioned records under their existing access rules. Track submitted or removed context without clearing newer selections. Attaching context does not send a message or authorize an action on that data.

Bits & Bolts attaches selected parts and view state, and handles model-context changes.

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L418)

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L490)

## Entrypoint icons

Provide SVG entrypoint icons with a transparent background, monochrome shapes, and `currentColor`. Use a 20 × 20 viewport and 1.33px strokes for stroke icons. Follow the [sidebar icon template](https://www.figma.com/design/k1TPwkpYDbcRQrU34nUnNL/Plugin-icon-template?node-id=0-1).

Navigation icons are separate from the app's registered logo. Bits & Bolts illustrates supplying icons to its entrypoint tools.

[plugins/bits-and-bolts/assets/icon.svg](../plugins/bits-and-bolts/assets/icon.svg)

[plugins/bits-and-bolts/src/server/index.ts](../plugins/bits-and-bolts/src/server/index.ts#L16)

## Entrypoint titles

Give entrypoint tools human-readable titles. Use a distinct title that describes a thread view's contents, such as `Parts Tray`, rather than repeating the plugin name.

[plugins/bits-and-bolts/src/server/register.ts](../plugins/bits-and-bolts/src/server/register.ts#L179)

## Host appearance

Use the SDK app stylesheet and host theme variables so your app follows the user's appearance. 

Bits & Bolts uses the SDK stylesheet and applies host theme updates.

[plugins/bits-and-bolts/scripts/build-app.mjs](../plugins/bits-and-bolts/scripts/build-app.mjs#L29)

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L456)


## Thumbnails

Use square images of at least 128 × 128 pixels for context thumbnails. When adding thumbnails to form choices, provide them consistently across the choices so users do not see a mix of previews and fallback images.

Bits & Bolts attaches rendered part previews to model context and form choices.

[plugins/bits-and-bolts/src/app/controller.ts](../plugins/bits-and-bolts/src/app/controller.ts#L418)

[plugins/bits-and-bolts/src/server/register.ts](../plugins/bits-and-bolts/src/server/register.ts#L375)

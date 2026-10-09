# Changelog

## 0.2.0 — Unreleased

This release adds editable chat drafts and forms that can continue across multiple exchanges. It also updates mention search and settings, moves TypeScript server helpers to MCP SDK 2, and clarifies SDK imports and replacements for older APIs.

### Spec changes

- **Editable chat drafts:** In `ui/message`, add `_meta["openai/message"].send: false` to append content to the active draft or open an editable draft with `target: "new"` on desktop and the Work browser.
- **Mention search:** Advertise `openai/mentions: { searchTool: string }` in server capabilities. The search tool must set `annotations.readOnlyHint: true`. The old `_meta["openai/extensions"]["mentions/search"]: {}` declaration is deprecated but remains supported when the capability is absent.
- **Multi-round-trip forms:** Require both client capabilities, `elicitation.form` and `extensions["openai/elicitation"].form`. Put the form schema in `_meta["openai/elicitation"].requestedSchema` and set the core `requestedSchema` to `{ "type": "object", "properties": {} }`. Use TypeScript's new `requestFormInput` or Python's `request_form_input`, also available as `OpenAIExtensions.request_input`.
- **Settings buttons:** In `openai/settings`, make `title` optional, deprecated and ignored on `kind: "tool"` layout items. Set `title` on the referenced tool.

### SDK changes

- **Server SDK:** Move TypeScript server helpers to MCP SDK 2. Import `McpServer` from `@modelcontextprotocol/server`. Settings and mention handlers receive `ServerContext` instead of `RequestHandlerExtra`.
- **Shared imports:** Import shared TypeScript schemas and types from `@openai/mcp-extensions`. Existing `@openai/mcp-extensions/server` imports remain supported.
- **Legacy forms:** Add TypeScript's `OpenAIExtensions.elicitInputLegacy` and Python's `OpenAIExtensions.elicit_input_legacy`. The old `elicitInput` and `elicit_input` methods remain supported as deprecated aliases. Both TypeScript methods now take `(context, params, options?)`.
- **App transport:** Deprecate `createAppTransport`. Use `App` from `@modelcontextprotocol/ext-apps` with `OpenAIExtensions`.
- **Structured settings:** Remove settings entrypoints (`type: "settings"`) from both SDKs and remove Python's `OpenAISettingsEntrypoint`. Declare structured settings with `openai/settings`.

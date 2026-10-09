# Changelog

## 0.2.0 — Unreleased

This release added editable chat drafts and forms that can continue across multiple exchanges. It also updated mention search and settings, migrated TypeScript server helpers to MCP SDK 2, and clarified SDK imports and replacements for older APIs.

### Spec changes

- **Editable chat drafts:** Added `_meta["openai/message"].send: false` support to `ui/message` for appending content to the active draft or opening an editable draft with `target: "new"` on desktop and the Work browser.
- **Mention search:** Added the server capability `openai/mentions: { searchTool: string }`. The search tool must set `annotations.readOnlyHint: true`. Deprecated `_meta["openai/extensions"]["mentions/search"]: {}`, which remains supported when the capability is absent.
- **Multi-round-trip forms:** Added forms requiring both client capabilities, `elicitation.form` and `extensions["openai/elicitation"].form`. The form schema goes in `_meta["openai/elicitation"].requestedSchema`, with `{ "type": "object", "properties": {} }` in the core `requestedSchema`. Added TypeScript's `requestFormInput` and Python's `request_form_input`, also available as `OpenAIExtensions.request_input`.
- **Settings buttons:** Made `title` optional, deprecated and ignored on `openai/settings` layout items with `kind: "tool"`. Set `title` on the referenced tool.

### SDK changes

- **Server SDK:** Migrated TypeScript server helpers to MCP SDK 2. Import `McpServer` from `@modelcontextprotocol/server`. Changed settings and mention handlers to receive `ServerContext` instead of `RequestHandlerExtra`.
- **Shared imports:** Exported shared TypeScript schemas and types from `@openai/mcp-extensions`. Existing `@openai/mcp-extensions/server` imports remain supported.
- **Legacy forms:** Added TypeScript's `OpenAIExtensions.elicitInputLegacy` and Python's `OpenAIExtensions.elicit_input_legacy`. Deprecated `elicitInput` and `elicit_input`, which remain supported as aliases. Changed both TypeScript methods to take `(context, params, options?)`.
- **App transport:** Deprecated `createAppTransport`. Use `App` from `@modelcontextprotocol/ext-apps` with `OpenAIExtensions`.
- **Structured settings:** Removed settings entrypoints (`type: "settings"`) from both SDKs and removed Python's `OpenAISettingsEntrypoint`. Declare structured settings with `openai/settings`.

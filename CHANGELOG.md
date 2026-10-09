# Changelog

## 0.2.0 — Unreleased

### Spec changes

- `ui/message`: allow `_meta["openai/message"].send: false` for editable drafts in the active or a new conversation.
- Mention search: add the server capability `openai/mentions: { searchTool: string }`. Require the referenced tool's `annotations.readOnlyHint: true`. Deprecate `_meta["openai/extensions"]["mentions/search"]: {}` as a fallback when the capability is absent.
- Multi-round-trip forms: require `elicitation.form` and `extensions["openai/elicitation"].form`. Put the extended schema in `_meta["openai/elicitation"].requestedSchema`, with `{ "type": "object", "properties": {} }` in the core `requestedSchema`. Add TypeScript's `requestFormInput` and Python's `request_form_input`, also exposed as `OpenAIExtensions.request_input`.
- Settings `kind: "tool"` layout items: make `title` optional, deprecated and ignored. Set the display title on the referenced tool.

### SDK changes

- TypeScript server helpers: accept `McpServer` from `@modelcontextprotocol/server`. Settings and mention handlers receive `ServerContext` instead of SDK 1's `RequestHandlerExtra`. Legacy form helpers now take `(context, params, options?)`.
- Export shared TypeScript schemas and types from `@openai/mcp-extensions`. Keep the existing `@openai/mcp-extensions/server` exports.
- Add TypeScript's `OpenAIExtensions.elicitInputLegacy` and Python's `OpenAIExtensions.elicit_input_legacy`. Deprecate `elicitInput` and `elicit_input` as aliases.
- Deprecate `createAppTransport`. Use `App` from `@modelcontextprotocol/ext-apps` with `OpenAIExtensions`.
- Remove `type: "settings"` from both SDKs' entrypoint unions and remove Python's `OpenAISettingsEntrypoint`. Use `openai/settings` for structured settings.

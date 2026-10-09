# Changelog

## Unreleased

### Spec API changes

- Multi-round-trip forms: put the extended schema in `_meta["openai/elicitation"].requestedSchema` and an empty object schema in core `requestedSchema`. Use `requestFormInput` from `@openai/mcp-extensions/server` for MCP `2026-07-28` or later.

### SDK-only API changes

- Server helpers use MCP SDK 2. Legacy form helpers take `ServerContext`: `elicitInputLegacy(context, params, options)`. Settings and mention handlers also receive `ServerContext`.
- Server-only installations use `@modelcontextprotocol/server`. MCP Apps retain the SDK 1 peer required by `@modelcontextprotocol/ext-apps`.
- Add `OpenAIExtensions.elicitInputLegacy` for connections that predate MCP `2026-07-28`. Deprecate `elicitInput` as an alias.
- `createElicitInput` takes an SDK 2 `McpServer` directly instead of a minimal `{ server: client }` wrapper.

## [0.1.0](https://github.com/openai/mcp-extensions/compare/node-v0.1.0...node-v0.1.0) (2026-09-29)


### Miscellaneous Chores

* prepare initial Python and Node releases ([#6](https://github.com/openai/mcp-extensions/issues/6)) ([479487f](https://github.com/openai/mcp-extensions/commit/479487f14f839d9a9fcb083d69fcd31701496c29))

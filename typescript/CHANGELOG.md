# Changelog

## Unreleased

### Changes

- Server helpers now use MCP SDK 2. Pass `ServerContext` to `elicitInputLegacy(context, params, options)` and its deprecated `elicitInput` alias. Settings and mention handlers also receive `ServerContext`.
- Server-only installations use `@modelcontextprotocol/server`. MCP Apps retain the SDK 1 peer required by `@modelcontextprotocol/ext-apps`.

- Added `OpenAIExtensions.elicitInputLegacy` for connections that predate MCP `2026-07-28`. `elicitInput` remains supported as a deprecated alias.
- Added `requestFormInput` from `@openai/mcp-extensions/server` for multi round-trip openai form extension elicitations.

## [0.2.0](https://github.com/openai/mcp-extensions/compare/node-v0.1.0...node-v0.2.0) (2026-10-09)


### Features

* Update extension SDKs ([#31](https://github.com/openai/mcp-extensions/issues/31)) ([faf1c46](https://github.com/openai/mcp-extensions/commit/faf1c46830c4b43bf8f9d69b79798335adba86b5))

## [0.1.0](https://github.com/openai/mcp-extensions/compare/node-v0.1.0...node-v0.1.0) (2026-09-29)


### Miscellaneous Chores

* prepare initial Python and Node releases ([#6](https://github.com/openai/mcp-extensions/issues/6)) ([479487f](https://github.com/openai/mcp-extensions/commit/479487f14f839d9a9fcb083d69fcd31701496c29))

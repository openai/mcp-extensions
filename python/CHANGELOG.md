# Changelog

## [0.2.0](https://github.com/openai/mcp-extensions/compare/python-v0.1.0...python-v0.2.0) (2026-10-10)

### Changes

- Require MCP SDK 2 and its matching protocol types. Both legacy and multi-round-trip forms use this SDK generation.

- Added `OpenAIExtensions.elicit_input_legacy` for connections that predate MCP `2026-07-28`. `elicit_input` remains supported as a deprecated alias.
- For connections that negotiate MCP `2026-07-28` or later, use `OpenAIExtensions.request_input` and register `OpenAIExtensions.middleware` for multi-round-trip form elicitation.

### Features

* Update extension SDKs ([#31](https://github.com/openai/mcp-extensions/issues/31)) ([faf1c46](https://github.com/openai/mcp-extensions/commit/faf1c46830c4b43bf8f9d69b79798335adba86b5))

## [0.1.0](https://github.com/openai/mcp-extensions/compare/python-v0.1.0...python-v0.1.0) (2026-09-29)


### Documentation

* use relative SDK links ([#3](https://github.com/openai/mcp-extensions/issues/3)) ([585bc51](https://github.com/openai/mcp-extensions/commit/585bc5165d07601d3f0673f6156634e9199de7fd))


### Miscellaneous Chores

* prepare initial Python and Node releases ([#6](https://github.com/openai/mcp-extensions/issues/6)) ([479487f](https://github.com/openai/mcp-extensions/commit/479487f14f839d9a9fcb083d69fcd31701496c29))

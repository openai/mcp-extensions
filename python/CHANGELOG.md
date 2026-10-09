# Changelog

## Unreleased

### Spec API changes

- Multi-round-trip forms: put the extended schema in `_meta["openai/elicitation"].requestedSchema` and an empty object schema in core `requestedSchema`. Use `OpenAIExtensions.request_input` and register `OpenAIExtensions.middleware` for MCP `2026-07-28` or later.

### SDK-only API changes

- Require MCP SDK 2 and its matching protocol types for both legacy and multi-round-trip forms.
- Add `OpenAIExtensions.elicit_input_legacy` for connections that predate MCP `2026-07-28`. Deprecate `elicit_input` as an alias.

## [0.1.0](https://github.com/openai/mcp-extensions/compare/python-v0.1.0...python-v0.1.0) (2026-09-29)


### Documentation

* use relative SDK links ([#3](https://github.com/openai/mcp-extensions/issues/3)) ([585bc51](https://github.com/openai/mcp-extensions/commit/585bc5165d07601d3f0673f6156634e9199de7fd))


### Miscellaneous Chores

* prepare initial Python and Node releases ([#6](https://github.com/openai/mcp-extensions/issues/6)) ([479487f](https://github.com/openai/mcp-extensions/commit/479487f14f839d9a9fcb083d69fcd31701496c29))

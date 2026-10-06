# Changelog

## Unreleased

### Changes

- Added `OpenAIExtensions.elicit_input_legacy` for connections that predate MCP `2026-07-28`. `elicit_input` remains supported as a deprecated alias.
- For connections that negotiate MCP `2026-07-28` or later, use `OpenAIExtensions.request_input` and register `OpenAIExtensions.middleware` for multi-round-trip form elicitation.

## [0.1.0](https://github.com/openai/mcp-extensions/compare/python-v0.1.0...python-v0.1.0) (2026-09-29)

DevDay host versions:

- Desktop: `26.928.20755`
- iOS: `1.2026.265`
- Android: `1.2026.265`

Feature availability varies by platform. See [platform support](../docs/spec.md#platform-support).

Changes:

- Released the initial Python SDK for MCP servers.
- Defined global, thread and file entrypoints, settings and onboarding.
- Defined display modes, deep links, model context and messages.
- Defined local file access, composer mentions and extended forms.

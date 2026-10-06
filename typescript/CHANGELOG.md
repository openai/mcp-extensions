# Changelog

## Unreleased

### Changes

- Added `OpenAIExtensions.elicitInputLegacy` for MCP Servers that have not upgraded to `2026-07-28`. `elicitInput` remains supported as a deprecated alias.
- Added `requestFormInput` from `@openai/mcp-extensions/server` for multi round-trip openai form extension elicitations.

## [0.1.0](https://github.com/openai/mcp-extensions/compare/node-v0.1.0...node-v0.1.0) (2026-09-29)

DevDay host versions:

- Desktop: `26.928.20755`
- iOS: `1.2026.265`
- Android: `1.2026.265`

Feature availability varies by platform. See [platform support](../docs/spec.md#platform-support).

Changes:

- Released the initial TypeScript SDK for MCP servers and apps.
- Defined global, thread and file entrypoints, settings and onboarding.
- Defined display modes, deep links, model context and messages.
- Defined local file access, composer mentions and extended forms.

import type { McpServer } from "@modelcontextprotocol/server";

import {
  createElicitInput,
  type OpenAIElicitInput,
} from "./forms/elicitation.js";
import { createMentions, type OpenAIMentions } from "./mentions.js";
import { createSettings, type OpenAISettings } from "./settings.js";

/** Adds OpenAI-specific extensions to one MCP server. */
export class OpenAIExtensions {
  /**
   * Request a form elicitation with OpenAI form extensions on connections that predate MCP 2026-07-28.
   * Pass the current tool handler context.
   */
  readonly elicitInputLegacy: OpenAIElicitInput;
  /** @deprecated Use elicitInputLegacy. */
  readonly elicitInput: OpenAIElicitInput;
  readonly mentions: OpenAIMentions;
  readonly settings: OpenAISettings;

  constructor(server: McpServer) {
    this.elicitInputLegacy = createElicitInput(server);
    this.elicitInput = this.elicitInputLegacy;
    this.mentions = createMentions(server);
    this.settings = createSettings(server);
  }
}

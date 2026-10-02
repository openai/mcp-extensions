import { randomBytes } from "node:crypto";

import {
  createRequestStateCodec,
  McpServer,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import type { OpenAIForm, OpenAIFormResult } from "../../src/server/index.js";
import { requestFormInput } from "../../src/server/index.js";

const submissionSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      pattern: "^[A-Z]{3}$",
      "x-openai-suggestions": [{ const: "ABC", title: "Example" }],
    },
    images: {
      type: "array",
      items: { type: "string", format: "uri" },
      minItems: 1,
      maxItems: 2,
      "x-openai-input": {
        type: "resource",
        options: [
          {
            uri: "file:///image.png",
            name: "image.png",
            _meta: {
              "openai/thumbnail": { src: "https://example.com/image.png" },
            },
          },
        ],
      },
    },
  },
  required: ["code", "images"],
} satisfies OpenAIForm;

serveStdio(() => {
  const state = createRequestStateCodec<OpenAIFormResult>({
    key: randomBytes(32),
  });
  const server = new McpServer(
    { name: "mrtr-typescript", version: "1" },
    { requestState: { verify: state.verify } },
  );
  server.registerTool(
    "choose",
    {
      inputSchema: z.object({
        label: z.string().default("form"),
        confirm: z.boolean().default(false),
      }),
    },
    async ({ label, confirm }, context) => {
      let submission = context.mcpReq.requestState<OpenAIFormResult>();
      if (submission === undefined) {
        const result = requestFormInput(context, {
          key: "details",
          mode: "form",
          message: label,
          requestedSchema: submissionSchema,
        });
        if ("resultType" in result) return result;
        if (result.action !== "accept" || !confirm)
          return { content: [], structuredContent: result };
        submission = result;
      }
      const confirmation = requestFormInput(context, {
        key: "confirmation",
        mode: "form",
        message: "Confirm",
        requestedSchema: {
          type: "object",
          properties: { confirmed: { type: "boolean" } },
          required: ["confirmed"],
        },
        requestState: await state.mint(submission),
      });
      if ("resultType" in confirmation) return confirmation;
      return {
        content: [],
        structuredContent: {
          ...submission,
          action: confirmation.action,
          confirmed:
            confirmation.action === "accept" &&
            confirmation.content["confirmed"],
        },
      };
    },
  );
  return server;
});

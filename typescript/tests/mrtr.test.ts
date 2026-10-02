import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  Client,
  type ElicitResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

import { OpenAIFormSchema } from "../src/server/index.js";

const content = { code: "ABC", images: ["file:///image.png"] };
const capabilities: ClientCapabilities = {
  elicitation: { form: {} },
  extensions: { "openai/elicitation": { form: {} } },
};
const metadataSchema = z.object({
  "openai/elicitation": z.object({ requestedSchema: OpenAIFormSchema }),
});

for (const language of ["typescript", "python"]) {
  describe(
    `${language} server with TypeScript client`,
    { skip: language === "python" && !process.env["MCP_MRTR_PYTHON"] },
    () => {
      async function connect(
        t: TestContext,
        answer: ElicitResult,
        options: { capabilities?: ClientCapabilities; legacy?: boolean } = {},
      ) {
        const client = new Client(
          { name: "mrtr-test", version: "1" },
          {
            capabilities: options.capabilities ?? capabilities,
            versionNegotiation: {
              mode: options.legacy ? "legacy" : { pin: "2026-07-28" },
            },
          },
        );
        const requests: string[] = [];
        client.setRequestHandler("elicitation/create", (request) => {
          assert.notEqual(request.params.mode, "url");
          const form = metadataSchema.parse(request.params._meta)[
            "openai/elicitation"
          ].requestedSchema;
          requests.push(request.params.message);
          if (request.params.message === "Confirm") {
            return { action: "accept", content: { confirmed: true } };
          }
          const code = form.properties["code"];
          assert.ok(
            code?.type === "string" &&
              "pattern" in code &&
              "x-openai-suggestions" in code,
          );
          assert.equal(code.pattern, "^[A-Z]{3}$");
          assert.deepEqual(code["x-openai-suggestions"], [
            { const: "ABC", title: "Example" },
          ]);
          assert.deepEqual(
            form.properties["images"]?.["x-openai-input"]?.options[0]?._meta?.[
              "openai/thumbnail"
            ],
            { src: "https://example.com/image.png" },
          );
          return answer;
        });
        const transport = new StdioClientTransport(
          language === "typescript"
            ? {
                command: process.execPath,
                args: [
                  fileURLToPath(
                    new URL("./fixtures/mrtr-server.js", import.meta.url),
                  ),
                ],
              }
            : {
                command: process.env["MCP_MRTR_PYTHON"] ?? "python",
                args: [
                  fileURLToPath(
                    new URL(
                      "../../../../openai_mcp_extensions/tests/fixtures/mrtr_server.py",
                      import.meta.url,
                    ),
                  ),
                ],
              },
        );
        t.after(() => client.close());
        await client.connect(transport);
        return { client, requests };
      }

      for (const action of ["accept", "decline", "cancel"] as const) {
        test(`${action} completes one MRTR round`, async (t) => {
          const answer: ElicitResult =
            action === "accept" ? { action, content } : { action };
          const { client, requests } = await connect(t, answer);
          const result = await client.callTool({ name: "choose" });
          assert.ok(!result.isError, JSON.stringify(result));
          assert.deepEqual(result.structuredContent, answer);
          assert.deepEqual(requests, ["form"]);
        });
      }

      test("two rounds preserve answers in requestState", async (t) => {
        const { client, requests } = await connect(t, {
          action: "accept",
          content,
        });
        const result = await client.callTool({
          name: "choose",
          arguments: { confirm: true },
        });
        assert.ok(!result.isError, JSON.stringify(result));
        assert.deepEqual(result.structuredContent, {
          action: "accept",
          content,
          confirmed: true,
        });
        assert.deepEqual(requests, ["form", "Confirm"]);
      });

      for (const invalid of [
        { ...content, code: "bad" },
        { ...content, images: ["not-a-uri"] },
        { ...content, images: ["file:///unlisted.png"] },
        { code: "ABC" },
      ]) {
        test(`rejects invalid answer ${JSON.stringify(invalid)}`, async (t) => {
          const { client, requests } = await connect(t, {
            action: "accept",
            content: invalid,
          });
          const result = await client.callTool({ name: "choose" });
          assert.equal(result.isError, true);
          assert.deepEqual(requests, ["form"]);
        });
      }

      test("requires OpenAI form extension support", async (t) => {
        const { client, requests } = await connect(
          t,
          { action: "accept", content },
          {
            capabilities: {
              elicitation: { form: {} },
            },
          },
        );
        assert.equal((await client.callTool({ name: "choose" })).isError, true);
        assert.deepEqual(requests, []);
      });

      test("rejects MRTR on a legacy connection", async (t) => {
        const { client, requests } = await connect(
          t,
          { action: "accept", content },
          { legacy: true },
        );
        assert.equal((await client.callTool({ name: "choose" })).isError, true);
        assert.deepEqual(requests, []);
      });

      test("concurrent calls keep their forms separate", async (t) => {
        const { client, requests } = await connect(t, {
          action: "accept",
          content,
        });
        const results = await Promise.all(
          ["first", "second"].map((label) =>
            client.callTool({
              name: "choose",
              arguments: { label, confirm: true },
            }),
          ),
        );
        for (const result of results) {
          assert.ok(!result.isError, JSON.stringify(result));
          assert.deepEqual(result.structuredContent, {
            action: "accept",
            content,
            confirmed: true,
          });
        }
        assert.deepEqual(requests.sort(), [
          "Confirm",
          "Confirm",
          "first",
          "second",
        ]);
      });
    },
  );
}

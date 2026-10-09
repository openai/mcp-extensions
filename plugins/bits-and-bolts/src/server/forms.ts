import {
  createElicitInput,
  createOpenAIFormContentSchema,
  OpenAIFormResultSchema,
  requestFormInput,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

export type RequestClient = Parameters<typeof createElicitInput>[0]["server"];

const RequestEnvelopeSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.string().optional(),
});

/** Keep compatibility with older dev-app image dialogs at the demo boundary. */
export async function elicitCadForm(
  client: RequestClient,
  context: ServerContext,
  params: OpenAIFormRequestParams,
) {
  const envelope = RequestEnvelopeSchema.parse(context.mcpReq.envelope ?? {});
  const protocolVersion =
    envelope["io.modelcontextprotocol/protocolVersion"] ??
    client.getNegotiatedProtocolVersion();
  if (protocolVersion !== undefined && protocolVersion >= "2026-07-28") {
    return requestFormInput(context, { ...params, key: "form" });
  }
  const capabilities = client.getClientCapabilities();
  if (
    capabilities?.extensions?.["openai/elicitation"] != null ||
    capabilities?.extensions?.["openai/form"] == null
  )
    return createElicitInput({ server: client })(context, params, {
      timeout: 300000,
    });
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(
    params.requestedSchema.properties,
  )) {
    const field = value as Record<string, unknown>;
    if (field["x-openai-input"] != null)
      throw Error("File inputs require openai/elicitation form support.");
    if (
      value.type === "array" &&
      !("enum" in value.items && value.items.enum != null) &&
      !("anyOf" in value.items && value.items.anyOf != null)
    ) {
      if (params.requestedSchema.required?.includes(name))
        throw Error("Custom values require openai/elicitation form support.");
      continue;
    }
    const choices = field["oneOf"] as
      Array<Record<string, unknown>> | undefined;
    properties[name] = choices?.some(
      (option) => option["x-openai-thumbnail"] != null,
    )
      ? {
          type: "openai/imagePicker",
          title: field["title"],
          items: choices.map((option) => ({
            id: option["const"],
            title: option["title"],
            image: (
              option["x-openai-thumbnail"] as { src?: string } | undefined
            )?.src,
          })),
        }
      : field;
  }
  const result = await context.mcpReq.send(
    {
      method: "openai/form",
      params: {
        message: params.message,
        requestedSchema: { ...params.requestedSchema, properties },
      },
    },
    OpenAIFormResultSchema,
    { timeout: 300000 },
  );
  return result.action === "accept"
    ? {
        ...result,
        content: createOpenAIFormContentSchema(params.requestedSchema).parse(
          result.content,
        ),
      }
    : result;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAIFormSchema,
  createOpenAIFormContentSchema,
  getResourcePath,
} from "../src/index.js";

test("resource context tolerates unrelated metadata and rejects malformed paths", () => {
  assert.equal(getResourcePath(undefined), undefined);
  assert.equal(
    getResourcePath({
      future: true,
      "openai/resource": { path: "/workspace/drawing.stl", future: true },
    }),
    "/workspace/drawing.stl",
  );
  assert.throws(() => getResourcePath({ "openai/resource": { path: 1 } }));
});

test("form answers enforce required fields, constraints, and supplied resource choices", () => {
  const form = OpenAIFormSchema.parse({
    type: "object",
    required: ["name", "quantity", "source"],
    properties: {
      name: { type: "string", minLength: 1 },
      quantity: { type: "integer", minimum: 1 },
      grid: { type: "boolean", default: true },
      source: {
        type: "string",
        format: "uri",
        "x-openai-input": {
          type: "resource",
          options: [{ uri: "file:///drawing.stl", name: "Drawing" }],
        },
      },
    },
  });
  const schema = createOpenAIFormContentSchema(form);
  const answer = { name: "bolt", quantity: 2, source: "file:///drawing.stl" };
  assert.deepEqual(schema.parse(answer), answer);
  for (const invalid of [
    { ...answer, quantity: 0 },
    { ...answer, quantity: "2" },
    { ...answer, name: "" },
    { ...answer, source: "file:///other.stl" },
    { name: "bolt" },
  ]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
  const missing = schema.safeParse({});
  assert.equal(missing.success, false);
  if (!missing.success)
    assert.ok(missing.error.issues.some((issue) => issue.path[0] === "name"));
});

test("form suggestions allow free input and resource selection modes remain distinct", () => {
  const suggested = OpenAIFormSchema.parse({
    type: "object",
    properties: {
      name: {
        type: "string",
        "x-openai-suggestions": [{ const: "bolt", title: "Bolt" }],
      },
      tags: { type: "array", items: { type: "string" } },
    },
  });
  assert.deepEqual(
    createOpenAIFormContentSchema(suggested).parse({
      name: "nut",
      tags: ["hardware", "metal"],
    }),
    { name: "nut", tags: ["hardware", "metal"] },
  );
  for (const extra of [{ userOptions: {} }, { selection: "implicit" }]) {
    const form = OpenAIFormSchema.parse({
      type: "object",
      properties: {
        source: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": { type: "resource", options: [], ...extra },
        },
      },
    });
    assert.deepEqual(
      createOpenAIFormContentSchema(form).parse({
        source: ["file:///uploaded.stl"],
      }),
      { source: ["file:///uploaded.stl"] },
    );
  }
  assert.equal(
    OpenAIFormSchema.safeParse({
      type: "object",
      properties: {
        source: {
          type: "array",
          items: { type: "string", format: "uri" },
          default: ["file:///drawing.stl"],
          "x-openai-input": {
            type: "resource",
            options: [],
            selection: "implicit",
          },
        },
      },
    }).success,
    false,
  );
});

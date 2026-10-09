import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";

import {
  OpenAIExtensions,
  OpenAISettingsReadResultSchema,
  type OpenAISettingsTool,
  type OpenAISettingsLayoutItem,
} from "../src/server/index.js";

for (const names of [
  {},
  { readTool: "custom.read" },
  { updateTool: "custom.update" },
  { readTool: "custom.read", updateTool: "custom.update" },
]) {
  const expectedReadTool = names.readTool ?? "settings.read";
  const expectedUpdateTool = names.updateTool ?? "settings.update";
  test(`settings registration validates ${expectedReadTool} and ${expectedUpdateTool}`, async () => {
    const server = new McpServer({ name: "settings", version: "1" });
    const extensions = new OpenAIExtensions(server);
    const schema = z.object({
      units: z.enum(["mm", "in"]).meta({ title: "Units" }),
      showGrid: z.boolean().meta({ title: "Grid" }),
    });
    let values: z.infer<typeof schema> = {
      units: "mm",
      showGrid: true,
    };
    let writes = 0;
    extensions.settings.register({
      ...names,
      fields: {
        units: { schema: schema.shape.units, title: "Units" },
        showGrid: { schema: schema.shape.showGrid, title: "Grid" },
      },
      layout: [
        {
          kind: "group",
          title: "Display",
          items: [
            { kind: "property", property: "units" },
            { kind: "tool", tool: "connection.test" },
          ],
        },
      ],
      read: (context) => {
        assert.ok(context.mcpReq.signal);
        return values;
      },
      update: (set, context) => {
        // This assignment verifies that the public handler infers the partial value type.
        const patch: Partial<z.infer<typeof schema>> = set;
        assert.ok(context.mcpReq.signal);
        writes++;
        values = { ...values, ...patch };
        return values;
      },
    });
    const client = new Client({ name: "settings-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 2);
      const readTool = tools[0];
      const updateTool = tools[1];
      assert.ok(readTool && updateTool);
      assert.equal(readTool.name, expectedReadTool);
      assert.equal(updateTool.name, expectedUpdateTool);
      assert.deepEqual(
        client.getServerCapabilities()?.extensions?.["openai/settings"],
        {
          readTool: expectedReadTool,
          updateTool: expectedUpdateTool,
        },
      );
      assert.deepEqual(
        client.getServerCapabilities()?.experimental?.["openai/settings"],
        { readTool: expectedReadTool, updateTool: expectedUpdateTool },
      );
      assert.equal(readTool.annotations?.readOnlyHint, true);
      assert.ok(readTool.outputSchema && updateTool.outputSchema);
      const read = CallToolResultSchema.parse(
        await client.callTool({ name: readTool.name, arguments: {} }),
      );
      const result = OpenAISettingsReadResultSchema.parse(
        read.structuredContent,
      );
      assert.deepEqual(result.values, values);
      assert.deepEqual(Object.keys(result.schema.properties ?? {}), [
        "units",
        "showGrid",
      ]);
      assert.deepEqual(result.schema.properties?.["units"], {
        type: "string",
        enum: ["mm", "in"],
        title: "Units",
      });
      assert.equal(result.schema["additionalProperties"], false);
      assert.deepEqual(result.layout, [
        {
          kind: "group",
          title: "Display",
          items: [
            { kind: "property", property: "units" },
            { kind: "tool", tool: "connection.test" },
          ],
        },
      ]);
      for (const args of [
        { set: {} },
        { set: { unknown: true } },
        { set: { units: "cm" } },
        { set: { units: "in" }, extra: true },
      ]) {
        assert.equal(
          (await client.callTool({ name: updateTool.name, arguments: args }))
            .isError,
          true,
        );
      }
      assert.equal(writes, 0);
      const saved = CallToolResultSchema.parse(
        await client.callTool({
          name: updateTool.name,
          arguments: { set: { units: "in" } },
        }),
      );
      assert.deepEqual(saved.structuredContent, {
        values: { units: "in", showGrid: true },
      });
      assert.equal(writes, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("settings registration is shared across wrappers for the same server", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  const first = new OpenAIExtensions(server).settings;
  const second = new OpenAIExtensions(server).settings;
  const options = {
    fields: { units: { schema: z.string(), title: "Units" } },
    read: () => ({ units: "mm" }),
    update: () => ({ units: "in" }),
  };
  first.register(options);
  for (const settings of [
    first,
    second,
    new OpenAIExtensions(server).settings,
  ]) {
    assert.throws(
      () =>
        settings.register({
          ...options,
          readTool: "other.read",
          updateTool: "other.update",
        }),
      /Settings are already registered on this server/,
    );
  }
  const client = new Client({ name: "settings-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["settings.read", "settings.update"],
    );
    for (const capabilities of [
      client.getServerCapabilities()?.extensions,
      client.getServerCapabilities()?.experimental,
    ]) {
      assert.deepEqual(capabilities?.["openai/settings"], {
        readTool: "settings.read",
        updateTool: "settings.update",
      });
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("invalid definitions fail before registering tools", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  const extensions = new OpenAIExtensions(server);
  const register = (
    schema: z.ZodObject,
    readTool = "read",
    updateTool = "update",
  ) =>
    extensions.settings.register({
      fields: Object.fromEntries(
        Object.entries(schema.shape).map(([name, field]) => [
          name,
          { schema: field, title: field.meta()?.title ?? "" },
        ]),
      ),
      readTool,
      updateTool,
      read: () => ({}),
      update: () => ({}),
    });
  assert.throws(() => register(z.object({ units: z.string() })), /title/);
  assert.throws(
    () =>
      register(
        z.object({ units: z.string().default("mm").meta({ title: "Units" }) }),
      ),
    /defaults/,
  );
  assert.throws(
    () => register(z.object({}), "same", "same"),
    /different names/,
  );
});

test("dynamic layout references are validated before either tool is registered", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  server.registerTool("existing", {}, () => ({ content: [] }));
  const settings = new OpenAIExtensions(server).settings;
  const fields: Record<string, { schema: z.ZodString; title: string }> = {
    units: { schema: z.string(), title: "Units" },
  };
  const invalidLayouts: OpenAISettingsLayoutItem[][] = [
    ...["missing", "toString", ""].map((key): OpenAISettingsLayoutItem[] => [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: key }],
      },
    ]),
    [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
    ],
  ];
  for (const layout of invalidLayouts) {
    assert.throws(
      () =>
        settings.register({
          fields,
          layout,
          read: () => ({ units: "mm" }),
          update: () => ({ units: "mm" }),
        }),
      /Unknown or duplicate settings key/,
    );
  }
  const client = new Client({ name: "settings-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["existing"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

for (const refinement of ["refine", "superRefine"]) {
  test(`partial updates preserve field rules with ${refinement} in the persistence handler`, async () => {
    const baseSchema = z.object({
      min: z
        .number()
        .nonnegative()
        .refine((value) => value % 2 === 0)
        .meta({ title: "Minimum" }),
      max: z.number().positive().meta({ title: "Maximum" }),
    });
    const schema =
      refinement === "refine"
        ? baseSchema.refine(
            (values) => values.min < values.max,
            "Minimum must be below maximum",
          )
        : baseSchema.superRefine((values, context) => {
            if (values.min >= values.max) {
              context.addIssue({
                code: "custom",
                message: "Minimum must be below maximum",
              });
            }
          });
    let values = { min: 0, max: 10 };
    let handlerCalls = 0;
    const server = new McpServer({ name: "settings", version: "1" });
    new OpenAIExtensions(server).settings.register({
      fields: {
        min: { schema: baseSchema.shape.min, title: "Minimum" },
        max: { schema: baseSchema.shape.max, title: "Maximum" },
      },
      read: () => values,
      update: (set) => {
        handlerCalls += 1;
        values = schema.parse({ ...values, ...set });
        return values;
      },
    });
    const client = new Client({ name: "settings-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const set of [{ min: -2 }, { min: 3 }, {}, { unknown: 4 }]) {
        assert.equal(
          (
            await client.callTool({
              name: "settings.update",
              arguments: { set },
            })
          ).isError,
          true,
        );
      }
      assert.equal(handlerCalls, 0);
      const result = await client.callTool({
        name: "settings.update",
        arguments: { set: { min: 4 } },
      });
      assert.deepEqual(result.structuredContent, {
        values: { min: 4, max: 10 },
      });
      assert.equal(handlerCalls, 1);
      assert.equal(
        (
          await client.callTool({
            name: "settings.update",
            arguments: { set: { min: 12 } },
          })
        ).isError,
        true,
      );
      assert.equal(handlerCalls, 2);
      assert.deepEqual(values, { min: 4, max: 10 });
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("failed update registration removes the read tool and allows retry", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  server.registerTool("settings.update", {}, async () => ({
    content: [{ type: "text", text: "Existing tool" }],
  }));
  const settings = new OpenAIExtensions(server).settings;
  const options = {
    fields: { units: { schema: z.string(), title: "Units" } },
    read: () => ({ units: "mm" }),
    update: () => ({ units: "in" }),
  };
  assert.throws(() => settings.register(options), /already registered/);
  settings.register({ ...options, updateTool: "settings.save" });

  const client = new Client({ name: "settings-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["settings.update", "settings.read", "settings.save"],
    );
    assert.deepEqual(
      (await client.callTool({ name: "settings.update", arguments: {} }))
        .content,
      [{ type: "text", text: "Existing tool" }],
    );
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "settings.read",
      "settings.save",
      "settings.update",
    ]);
    assert.deepEqual(
      client.getServerCapabilities()?.extensions?.["openai/settings"],
      { readTool: "settings.read", updateTool: "settings.save" },
    );
    const result = await client.callTool({
      name: "settings.save",
      arguments: { set: { units: "in" } },
    });
    assert.deepEqual(result.structuredContent, { values: { units: "in" } });
  } finally {
    await client.close();
    await server.close();
  }
});

test("protocol result schemas retain tool action metadata and declaration order", () => {
  const result = {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        units: { type: "string", title: "Units" },
        grid: { type: "boolean", title: "Grid" },
      },
      required: ["units", "grid"],
    },
    layout: [
      {
        kind: "group",
        title: "Display",
        items: [
          {
            kind: "tool",
            tool: "connection.test",
            title: "Legacy action label",
          } satisfies OpenAISettingsTool,
        ],
      },
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "grid" }],
      },
    ],
    values: { units: "mm", grid: true },
  };
  assert.deepEqual(OpenAISettingsReadResultSchema.parse(result), result);
});

test("layout validation permits omitted settings and rejects unknown or duplicate references", () => {
  const result = {
    schema: {
      type: "object",
      properties: { units: { type: "string" }, grid: { type: "boolean" } },
    },
    values: { units: "mm", grid: true },
  };
  assert.doesNotThrow(() => OpenAISettingsReadResultSchema.parse(result));
  for (const layout of [
    [],
    [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
    ],
  ]) {
    assert.deepEqual(
      OpenAISettingsReadResultSchema.parse({ ...result, layout }).layout,
      layout,
    );
  }
  for (const layout of [
    [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "missing" }],
      },
    ],
    [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
    ],
  ])
    assert.throws(
      () => OpenAISettingsReadResultSchema.parse({ ...result, layout }),
      /Unknown or duplicate/,
    );
});

test("handler results must contain every effective value", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  new OpenAIExtensions(server).settings.register({
    readTool: "read",
    updateTool: "update",
    fields: { units: { schema: z.string(), title: "Units" } },
    read: () => JSON.parse("{}"),
    update: () => JSON.parse("{}"),
  });
  const client = new Client({ name: "settings-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.equal(
      (await client.callTool({ name: "read", arguments: {} })).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "update",
          arguments: { set: { units: "mm" } },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("unsupported native fields fail before either tool is registered", async () => {
  const server = new McpServer({ name: "settings", version: "1" });
  server.registerTool("existing", {}, () => ({ content: [] }));
  const settings = new OpenAIExtensions(server).settings;
  for (const schema of [
    z.array(z.string()),
    z.object({ name: z.string() }),
    z.union([z.string(), z.boolean()]),
    z.string().nullable(),
    z.literal([1, 2]),
    z.intersection(z.string(), z.string().min(1)),
  ]) {
    assert.throws(
      () =>
        settings.register({
          fields: { unsupported: { schema, title: "Unsupported" } },
          read: () => ({ unsupported: "unused" }),
          update: () => ({ unsupported: "unused" }),
        }),
      /Unsupported native setting "unsupported"/,
    );
  }
  const client = new Client({ name: "settings-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["existing"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("layouts reject ungrouped entries and nested groups", () => {
  const property = { kind: "property", property: "units" };
  const tool = { kind: "tool", tool: "connection.test" };
  const group = { kind: "group", title: "Display", items: [property, tool] };
  const result = {
    schema: { type: "object", properties: { units: { type: "string" } } },
    values: { units: "mm" },
  };
  for (const layout of [[property], [tool], [{ ...group, items: [group] }]]) {
    assert.equal(
      OpenAISettingsReadResultSchema.safeParse({ ...result, layout }).success,
      false,
    );
  }
});

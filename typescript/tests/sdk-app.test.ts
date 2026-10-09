import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OpenAIExtensions } from "../src/app/index.js";

const features = Object.fromEntries(
  [
    "openai/files",
    "openai/message",
    "openai/modelContext",
    "openai/resource",
  ].map((key) => [key, {}]),
);

async function host(
  t: TestContext,
  experimental = features,
  hostContext: McpUiHostContext = {},
) {
  const app = new App(
    { name: "sdk-consumer", version: "1" },
    {},
    { autoResize: false },
  );
  const extensions = new OpenAIExtensions(app);
  const bridge = new AppBridge(
    null,
    { name: "sdk-host", version: "1" },
    {
      experimental,
      serverResources: {},
      message: { text: {} },
      updateModelContext: { structuredContent: {} },
    },
    { hostContext },
  );
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await app.close();
    await bridge.close();
  });
  const requests: JSONRPCRequest[] = [];
  for (const transport of [appTransport, hostTransport]) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      const wire = JSON.parse(JSON.stringify(message));
      if (transport === appTransport && "method" in wire && "id" in wire)
        requests.push(wire);
      await send(wire, options);
    };
  }
  let reply: Record<string, unknown> = {};
  let failure: Error | undefined;
  for (const method of [
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "openai/resources/write",
    "openai/files/open",
    "ui/message",
    "ui/update-model-context",
  ]) {
    bridge.setRequestHandler(
      z.object({
        method: z.literal(method),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      async () => {
        if (failure) throw failure;
        return reply;
      },
    );
  }
  // Follow the documented setup: register the initial result before connecting.
  let received!: (value: unknown) => void;
  const initialResult = new Promise<unknown>((resolve) => {
    received = resolve;
  });
  app.ontoolresult = received;
  const initial = { content: [], structuredContent: { part: "bolt" } };
  bridge.oninitialized = () => {
    void bridge
      .sendToolInput({ arguments: {} })
      .then(() => bridge.sendToolResult(initial));
  };
  for (const feature of [
    "files",
    "message",
    "modelContext",
    "resources",
  ] as const)
    assert.equal(extensions[feature], undefined);
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  assert.deepEqual(await initialResult, initial);
  return {
    app,
    extensions,
    requests,
    reply(value: Record<string, unknown>) {
      reply = value;
    },
    fail(error: Error) {
      failure = error;
    },
    async context(value: McpUiHostContext) {
      const changed = new Promise<void>((resolve) => {
        const listener = () => {
          app.removeEventListener("hostcontextchanged", listener);
          resolve();
        };
        app.addEventListener("hostcontextchanged", listener);
      });
      await bridge.sendHostContextChange(value);
      await changed;
    },
    notify: (method: string, params: Record<string, unknown>) =>
      hostTransport.send({ jsonrpc: "2.0", method, params }),
  };
}

test("documented app setup receives its initial result and negotiated capabilities", async (t) => {
  const h = await host(t);
  assert.equal(h.requests[0]?.method, "ui/initialize");
  assert.deepEqual(h.requests[0]?.params?.appInfo, {
    name: "sdk-consumer",
    version: "1",
  });
  for (const feature of [
    "files",
    "message",
    "modelContext",
    "resources",
  ] as const)
    assert.ok(h.extensions[feature]);
  const unsupported = await host(t, {});
  for (const feature of [
    "files",
    "message",
    "modelContext",
    "resources",
  ] as const)
    assert.equal(unsupported.extensions[feature], undefined);
});

test("resource reads serialize representation metadata and return contents with ETags", async (t) => {
  const h = await host(t);
  const content = {
    uri: "file:///drawing.stl",
    blob: "Y2Fk",
    _meta: { "openai/resource": { etag: "v1", writable: true } },
  };
  h.reply({ contents: [content] });
  const result = await h.extensions.resources!.read({
    uri: content.uri,
    representation: "blob",
    _meta: { trace: "read-1", "openai/resource": { representation: "text" } },
  });
  assert.deepEqual(h.requests.at(-1)?.params, {
    uri: content.uri,
    _meta: { trace: "read-1", "openai/resource": { representation: "blob" } },
  });
  assert.equal(h.requests.at(-1)?.method, "resources/read");
  assert.deepEqual(result.contents, [
    { ...content, openaiMetadata: { etag: "v1", writable: true } },
  ]);
  h.reply({
    contents: [
      {
        uri: content.uri,
        text: "cad",
        _meta: { "openai/resource": { etag: 1 } },
      },
    ],
  });
  const text = await h.extensions.resources!.read({ uri: content.uri });
  const item = text.contents[0];
  assert.ok(item && "text" in item);
  assert.equal(item.text, "cad");
  assert.equal(item.openaiMetadata, undefined);
  h.reply({ contents: "malformed" });
  await assert.rejects(h.extensions.resources!.read({ uri: content.uri }));
});

test("resource writes preserve outcomes and reject malformed replies and host errors", async (t) => {
  const h = await host(t);
  const resources = h.extensions.resources!;
  for (const outcome of [
    { outcome: "saved", etag: "v2" },
    { outcome: "conflict", etag: "v3" },
    { outcome: "too-large", maxBytes: 1024 },
  ]) {
    h.reply(outcome);
    assert.deepEqual(
      await resources.write("file:///drawing.stl", {
        text: "cad",
        ifMatch: "v1",
      }),
      outcome,
    );
    assert.equal(h.requests.at(-1)?.method, "openai/resources/write");
    assert.deepEqual(h.requests.at(-1)?.params, {
      uri: "file:///drawing.stl",
      text: "cad",
      ifMatch: "v1",
    });
  }
  h.reply({ outcome: "saved", etag: "v4" });
  assert.deepEqual(
    await resources.write("file:///drawing.stl", { blob: "Y2Fk" }),
    { outcome: "saved", etag: "v4" },
  );
  assert.deepEqual(h.requests.at(-1)?.params, {
    uri: "file:///drawing.stl",
    blob: "Y2Fk",
  });
  const count = h.requests.length;
  assert.throws(() => resources.write("", { text: "cad" }));
  assert.equal(h.requests.length, count);
  h.reply({ outcome: "saved" });
  await assert.rejects(resources.write("file:///drawing.stl", { text: "cad" }));
  h.fail(new Error("Host declined"));
  await assert.rejects(
    resources.write("file:///drawing.stl", { text: "cad" }),
    /Host declined/,
  );
});

test("resource subscriptions deliver updates only to current listeners", async (t) => {
  const h = await host(t);
  const resources = h.extensions.resources!;
  assert.deepEqual(
    await resources.subscribe({ uri: "file:///drawing.stl" }),
    {},
  );
  assert.equal(h.requests.at(-1)?.method, "resources/subscribe");
  assert.deepEqual(h.requests.at(-1)?.params, { uri: "file:///drawing.stl" });
  const first: unknown[] = [],
    second: unknown[] = [];
  const remove = resources.addUpdateHandler((value) => {
    first.push(value);
  });
  let delivered!: () => void;
  resources.addUpdateHandler((value) => {
    second.push(value);
    delivered();
  });
  const params = { uri: "file:///drawing.stl" };
  for (let index = 0; index < 2; index++) {
    const completion = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    await h.notify("notifications/resources/updated", params);
    await completion;
    remove();
  }
  assert.deepEqual(first, [
    { method: "notifications/resources/updated", params },
  ]);
  assert.equal(second.length, 2);
  assert.deepEqual(await resources.unsubscribe(params), {});
  assert.equal(h.requests.at(-1)?.method, "resources/unsubscribe");
  assert.deepEqual(h.requests.at(-1)?.params, params);
});

test("messages, model context, and file opening serialize their extension payloads", async (t) => {
  const h = await host(t);
  const params = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Explain this drawing" }],
    _meta: {
      trace: "message-1",
      "openai/message": { target: "new" as const, send: false },
    },
  };
  h.reply({ isError: false });
  assert.deepEqual(await h.extensions.message!.send(params), {
    isError: false,
  });
  assert.equal(h.requests.at(-1)?.method, "ui/message");
  assert.deepEqual(h.requests.at(-1)?.params, params);
  h.reply({ _meta: { "openai/modelContext": { updateId: "context-1" } } });
  const context = { structuredContent: { part: "bolt" } };
  assert.deepEqual(await h.extensions.modelContext!.update(context), {
    updateId: "context-1",
  });
  assert.equal(h.requests.at(-1)?.method, "ui/update-model-context");
  assert.deepEqual(h.requests.at(-1)?.params, context);
  h.reply({});
  assert.equal(await h.extensions.modelContext!.update(context), undefined);
  assert.deepEqual(
    await h.extensions.files!.open("/workspace/drawing.stl"),
    {},
  );
  assert.equal(h.requests.at(-1)?.method, "openai/files/open");
  assert.deepEqual(h.requests.at(-1)?.params, {
    path: "/workspace/drawing.stl",
  });
  assert.throws(() => h.extensions.files!.open(""));
  h.fail(new Error("Host declined"));
  await assert.rejects(h.extensions.message!.send(params), /Host declined/);
});

test("host context notifications preserve clearing and normalize older deep links", async (t) => {
  const h = await host(t);
  assert.equal(h.extensions.deepLink.getCurrent(), undefined);
  await h.context({
    "openai/deepLink": { url: "/parts/bolt?view=mesh" },
    "openai/modelContext": {
      updateId: "context-1",
      structuredContent: { part: "bolt" },
    },
  });
  assert.deepEqual(h.extensions.deepLink.getCurrent(), {
    url: "/parts/bolt?view=mesh",
  });
  assert.equal(h.extensions.modelContext!.getCurrent()?.updateId, "context-1");
  await h.context({
    "openai/deepLink": {
      path: ["parts", "hex bolt"],
      query: [["view", "mesh"]],
    },
    "openai/modelContext": null,
  });
  assert.deepEqual(h.extensions.deepLink.getCurrent(), {
    url: "/parts/hex%20bolt?view=mesh",
  });
  assert.equal(h.extensions.modelContext!.getCurrent(), null);
  await h.context({
    "openai/deepLink": 1,
    "openai/modelContext": { updateId: "" },
  });
  assert.equal(h.extensions.deepLink.getCurrent(), undefined);
  assert.equal(h.extensions.modelContext!.getCurrent(), undefined);
});

test("cursor preference applies during initialization and after context notifications", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const styles: unknown[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        style: { setProperty: (...args: unknown[]) => styles.push(args) },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const h = await host(t, features, { "openai/interactionCursor": "default" });
  assert.deepEqual(styles[0], ["--cursor-interaction", "pointer"]);
  assert.deepEqual(styles.at(-1), ["--cursor-interaction", "default"]);
  await h.context({ "openai/interactionCursor": "future-value" });
  assert.deepEqual(styles.at(-1), ["--cursor-interaction", "pointer"]);
});

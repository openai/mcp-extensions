import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createAppTransport, type AppMessage } from "../src/app/transport.js";

function frame(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sent: AppMessage[] = [];
  let receive: ((event: MessageEvent) => Promise<void>) | undefined;
  const parent = { postMessage: (message: AppMessage) => sent.push(message) };
  const window = {
    parent,
    addEventListener: (_name: string, listener: typeof receive) => {
      receive = listener;
    },
    removeEventListener: () => {
      receive = undefined;
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  const transport = createAppTransport();
  t.after(() => {
    transport.dispose();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return {
    transport,
    sent,
    deliver: (message: AppMessage, source: unknown = parent) =>
      receive?.({ source, data: message } as MessageEvent),
  };
}

test("transport correlates out-of-order replies and ignores foreign messages", async (t) => {
  const h = frame(t);
  let completed = false;
  const first = h.transport
    .request("resources/read", { uri: "file:///drawing.stl" })
    .then((value) => {
      completed = true;
      return value;
    });
  const second = h.transport.request("tools/call", { name: "cad.listParts" });
  const error = assert.rejects(second, /Host declined/);
  const firstId = h.sent[0]!.id,
    secondId = h.sent[1]!.id;
  assert.notEqual(firstId, secondId);
  await h.deliver({ jsonrpc: "2.0", id: firstId, result: "foreign" }, {});
  assert.equal(completed, false);
  await h.deliver({
    jsonrpc: "2.0",
    id: secondId,
    error: { code: -32603, message: "Host declined" },
  });
  await error;
  await h.deliver({ jsonrpc: "2.0", id: firstId, result: { contents: [] } });
  assert.deepEqual(await first, { contents: [] });
});

test("transport serves app methods and removes notification subscribers", async (t) => {
  const h = frame(t);
  h.transport.handle("app/title", ({ title }) => ({ title }));
  await h.deliver({
    jsonrpc: "2.0",
    id: "host-1",
    method: "app/title",
    params: { title: "Drawing" },
  });
  assert.deepEqual(h.sent.at(-1), {
    jsonrpc: "2.0",
    id: "host-1",
    result: { title: "Drawing" },
  });
  h.transport.handle("app/fail", () => {
    throw new Error("Unavailable");
  });
  await h.deliver({ jsonrpc: "2.0", id: "host-2", method: "app/fail" });
  assert.equal(h.sent.at(-1)?.error?.code, -32603);
  await h.deliver({ jsonrpc: "2.0", id: "host-3", method: "app/unknown" });
  assert.equal(h.sent.at(-1)?.error?.code, -32601);
  const updates: unknown[] = [];
  const remove = h.transport.on("app/changed", (params) => {
    updates.push(params);
  });
  await h.deliver({
    jsonrpc: "2.0",
    method: "app/changed",
    params: { title: "Drawing" },
  });
  remove();
  await h.deliver({
    jsonrpc: "2.0",
    method: "app/changed",
    params: { title: "Other" },
  });
  assert.deepEqual(updates, [{ title: "Drawing" }]);
  h.transport.notify("app/ready", { title: "Drawing" });
  assert.deepEqual(h.sent.at(-1), {
    jsonrpc: "2.0",
    method: "app/ready",
    params: { title: "Drawing" },
  });
});

test("transport rejects timed-out and disposed requests", async (t) => {
  const h = frame(t);
  await assert.rejects(
    h.transport.request("resources/read", {}, 0),
    /timed out/,
  );
  const pending = assert.rejects(
    h.transport.request("resources/read"),
    /App disposed/,
  );
  h.transport.dispose();
  await pending;
  assert.equal(h.deliver({ jsonrpc: "2.0", method: "app/changed" }), undefined);
});

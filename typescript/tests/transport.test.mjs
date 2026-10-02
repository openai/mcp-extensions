import assert from "node:assert/strict";
import test from "node:test";

import { createAppTransport } from "../dist/app/transport.js";

function setup(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const messages = [];
  const receivers = new Set();
  const transports = [];
  const parent = { postMessage: (message) => messages.push(message) };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      parent,
      addEventListener: (_, receive) => receivers.add(receive),
      removeEventListener: (_, receive) => receivers.delete(receive),
    },
  });
  t.after(() => {
    for (const transport of transports) transport.dispose();
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  });
  return {
    messages,
    create() {
      const transport = createAppTransport();
      transports.push(transport);
      return transport;
    },
    async respond(message) {
      await Promise.all(
        [...receivers].map((receive) =>
          receive({ source: parent, data: { jsonrpc: "2.0", ...message } }),
        ),
      );
    },
  };
}

function observe(promise) {
  const observation = { settled: false };
  observation.result = promise.then(
    (value) => {
      observation.settled = true;
      return { value };
    },
    (error) => {
      observation.settled = true;
      return { error };
    },
  );
  return observation;
}

for (const [kind, response] of [
  ["result", { result: "old resource" }],
  ["error", { error: { code: -32603, message: "old failure" } }],
]) {
  test(`a recreated transport ignores a disposed transport's late ${kind}`, async (t) => {
    const host = setup(t);
    const oldTransport = host.create();
    const old = observe(oldTransport.request("resources/read", { uri: "old" }));
    oldTransport.dispose();
    assert.match((await old.result).error.message, /App disposed/);

    const current = observe(
      host.create().request("resources/read", { uri: "current" }),
    );
    const [oldMessage, currentMessage] = host.messages;
    await host.respond({ id: oldMessage.id, ...response });
    assert.equal(current.settled, false);
    await host.respond({ id: currentMessage.id, result: "current resource" });
    assert.deepEqual(await current.result, { value: "current resource" });
  });
}

test("simultaneous transports receive only their own responses", async (t) => {
  const host = setup(t);
  const first = observe(host.create().request("first"));
  const second = observe(host.create().request("second"));
  await host.respond({ id: host.messages[0].id, result: "first result" });
  assert.deepEqual(await first.result, { value: "first result" });
  assert.equal(second.settled, false);
  await host.respond({ id: host.messages[1].id, result: "second result" });
  assert.deepEqual(await second.result, { value: "second result" });
});

test("requests on one transport can complete out of order", async (t) => {
  const host = setup(t);
  const transport = host.create();
  const first = observe(transport.request("first"));
  const second = observe(transport.request("second"));
  await host.respond({ id: host.messages[1].id, result: "second result" });
  assert.deepEqual(await second.result, { value: "second result" });
  assert.equal(first.settled, false);
  await host.respond({
    id: host.messages[0].id,
    error: { code: -32603, message: "first failure" },
  });
  assert.equal((await first.result).error.message, "first failure");
});

test("a timed-out request does not consume a later response", async (t) => {
  const host = setup(t);
  const transport = host.create();
  await assert.rejects(transport.request("first", {}, 0), /first timed out/);
  const next = observe(transport.request("next"));
  await host.respond({ id: host.messages[0].id, result: "late result" });
  assert.equal(next.settled, false);
  await host.respond({ id: host.messages[1].id, result: "next result" });
  assert.deepEqual(await next.result, { value: "next result" });
});

test("disposing a transport rejects all pending requests", async (t) => {
  const host = setup(t);
  const transport = host.create();
  const requests = [
    observe(transport.request("first")),
    observe(transport.request("second")),
  ];
  transport.dispose();
  for (const request of requests) {
    assert.equal((await request.result).error.message, "App disposed");
  }
});

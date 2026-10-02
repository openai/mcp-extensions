/** Minimal JSON-RPC transport for embedded apps that supply their own UI.
 * Extension behavior belongs in the app's shared controller, not this transport.
 */
export type AppMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

/** @deprecated Use App from @modelcontextprotocol/ext-apps with OpenAIExtensions instead. */
export function createAppTransport<
  Payload extends Record<string, unknown> = Record<string, unknown>,
>() {
  let sequence = 0;
  const pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const handlers = new Map<string, (params: Payload) => unknown>();
  const listeners = new Map<string, Set<(params: Payload) => void>>();
  const send = (message: Omit<AppMessage, "jsonrpc">) =>
    window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const receive = async (event: MessageEvent) => {
    if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
    const message: AppMessage = event.data;
    if (!message.method && message.id != null) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method && message.id != null) {
      const handler = handlers.get(message.method);
      if (!handler) {
        send({
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported app method: ${message.method}`,
          },
        });
        return;
      }
      try {
        send({
          id: message.id,
          result: await handler((message.params ?? {}) as Payload),
        });
      } catch (error) {
        send({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? [])
        listener((message.params ?? {}) as Payload);
    }
  };
  window.addEventListener("message", receive);
  return {
    request<Result = Payload>(
      method: string,
      params: Record<string, unknown> = {},
      timeoutMs = 15000,
    ): Promise<Result> {
      if (window.parent === window)
        return Promise.reject(
          new Error(`Open this app in an MCP host to use ${method}`),
        );
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as Result),
          reject,
          timer,
        });
        send({ id, method, params });
      });
    },
    notify(method: string, params: Record<string, unknown> = {}) {
      send({ method, params });
    },
    handle(method: string, handler: (params: Payload) => unknown) {
      handlers.set(method, handler);
    },
    on(method: string, listener: (params: Payload) => void) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => {
        listeners.get(method)?.delete(listener);
      };
    },
    dispose() {
      window.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("App disposed"));
      }
      pending.clear();
      handlers.clear();
      listeners.clear();
    },
  };
}

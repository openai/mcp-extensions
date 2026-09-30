/* eslint-disable @typescript-eslint/no-explicit-any -- The demo handles dynamic JSON-RPC payloads and DOM controls. */
import { renderCadPreviews } from "./shared/preview.js";
import type { ModelFormat } from "../shared/contracts.js";
import { createAppTransport } from "@openai/mcp-extensions/app/transport";
import type { PublicCadPart } from "../shared/contracts.js";
import type {
  Renderer,
  RendererOptions,
  RenderState,
  ModelSource,
} from "./renderers/types.js";
type FileInfo = { name: string; resourceUri: string };
type AppState = RenderState & {
  part: PublicCadPart | null;
  file: FileInfo | null;
  etag: string | null;
  writable: boolean;
  dirty: boolean;
  page: string;
  defaultView: string;
  capabilities: Record<string, any>;
  host: Record<string, any>;
  connected: boolean;
  subscription: string | null;
  syncedSettings?: boolean;
};
export function startApp(
  createRenderer: (options: RendererOptions) => Renderer,
) {
  let catalog: PublicCadPart[] = [];
  let importedSource: ModelSource | null = null;
  let localFilesystem = false;
  let previewTask: Promise<void> | undefined;
  let disposed = false;
  const $ = (id: string): any => document.getElementById(id);
  const state: AppState = {
    part: null,
    file: null,
    etag: null,
    writable: false,
    dirty: false,
    page: "library",
    defaultView: "isometric",
    camera: "isometric",
    mode: "edges",
    yaw: -0.6,
    pitch: 0.6,
    zoom: 1,
    units: "mm",
    grid: true,
    host: {},
    capabilities: {},
    connected: false,
    subscription: null,
  };
  const transport = createAppTransport<Record<string, any>>();
  let generation = 0,
    readSequence = 0,
    editSequence = 0;
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  let resizing: number | undefined;
  let initialDeepLink: { url?: string } | null = null;
  const status = (message: string) => {
    $("status").textContent = message;
  };
  const request = (method: string, params: Record<string, any> = {}) =>
    transport.request(
      method,
      params,
      ["ui/message", "ui/download-file"].includes(method) ? 300000 : 15000,
    );
  const notify = (method: string, params: Record<string, any> = {}) => {
    if (state.connected) transport.notify(method, params);
  };
  const renderer = createRenderer({
    container: $("viewport"),
    onChange(change) {
      Object.assign(state, change);
      $("camera").value = state.camera;
      $("selection").textContent = state.selection
        ? "Selected surface: " + JSON.stringify(state.selection)
        : "";
      queueContext();
    },
    async readWasm() {
      const response = await request("resources/read", {
        uri: "cad-resource://bits-and-bolts/occt-import-js.wasm",
      });
      const content = response.contents?.[0];
      if (!content?.blob) throw Error("The STEP importer is unavailable.");
      return Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0));
    },
  });
  for (const [id, values] of [
    ["camera", renderer.cameras],
    ["mode", renderer.modes],
  ] as const) {
    const select = $(id);
    select.replaceChildren();
    if (id === "camera") {
      const custom = new Option("Custom", "custom");
      custom.disabled = true;
      select.add(custom);
    }
    for (const value of values)
      select.add(
        new Option(
          value === "transparent"
            ? "X-ray"
            : value[0].toUpperCase() + value.slice(1),
          value,
        ),
      );
  }
  $("import").accept = renderer.formats.map((format) => "." + format).join(",");
  function fail(error: unknown) {
    status(error instanceof Error ? error.message : String(error));
  }
  const act =
    (fn: (...args: any[]) => any) =>
    (...args: any[]) =>
      Promise.resolve()
        .then(() => fn(...args))
        .catch(fail);

  function draw() {
    renderer.draw(state);
    $("open-source").hidden = !(
      localFilesystem &&
      state.part?.id !== "imported" &&
      state.part &&
      state.capabilities.experimental?.["openai/files"] != null
    );
    const unit = state.units === "in" ? 25.4 : 1;
    $("dimensions").textContent = renderer.triangleCount()
      ? renderer
          .bounds()
          .size.map((v) => (v / unit).toFixed(2))
          .join(" × ") +
        " " +
        state.units +
        " · " +
        renderer.triangleCount() +
        " triangles"
      : "";
    $("selection").textContent = state.selection
      ? "Selected surface: " + JSON.stringify(state.selection)
      : "";
  }
  function ensureCanLeave(discardUnsaved = false) {
    if (state.dirty && !discardUnsaved)
      throw Error(
        "This view has unsaved geometry. Save it or explicitly discard changes before navigating.",
      );
  }
  function camera(name: string) {
    state.camera = name;
    if (name !== "custom") {
      state.yaw = name === "isometric" ? -0.6 : 0;
      state.pitch =
        name === "top" ? Math.PI / 2 : name === "isometric" ? 0.6 : 0;
    }
    $("camera").value = name;
    draw();
    queueContext();
  }
  function show(page: string) {
    state.page = page;
    $("library").hidden = page !== "library";
    $("viewer").hidden = page !== "viewer";
    $("settings").hidden = page !== "settings";
    $("heading").textContent =
      page === "viewer"
        ? state.part?.name || state.file?.name || "STL viewer"
        : page === "settings"
          ? "Viewer settings"
          : "Parts Library";
    draw();
    resize();
  }
  async function unsubscribe() {
    const uri = state.subscription;
    state.subscription = null;
    if (uri) await request("resources/unsubscribe", { uri });
  }
  async function openPart(part: PublicCadPart, discardUnsaved = false) {
    if (state.part?.id === part.id && !discardUnsaved) {
      show("viewer");
      return;
    }
    ensureCanLeave(discardUnsaved);
    const token = ++generation,
      edits = editSequence;
    const response = await request("tools/call", {
      name: "cad.readPart",
      arguments: { partId: part.id, representation: "display" },
    });
    if (response.isError)
      throw Error(response.content?.[0]?.text || "Could not load part.");
    if (token !== generation) return;
    const source = response.structuredContent;
    const bytes = source.blob
      ? Uint8Array.from(atob(source.blob), (c) => c.charCodeAt(0)).buffer
      : undefined;
    await renderer.load(
      { format: source.format, bytes, mesh: source.mesh },
      () => token === generation && edits === editSequence,
    );
    if (edits !== editSequence)
      throw Error("Loading canceled because you edited the current geometry.");
    if (token !== generation) return;
    void unsubscribe().catch(fail);
    state.selection = null;
    importedSource = null;
    state.part = part;
    state.file = null;
    state.etag = null;
    state.writable = false;
    state.dirty = false;
    state.zoom = 1;
    $("save").disabled = true;
    camera(state.camera);
    show("viewer");
    queueContext();
    if (!part.previews.isometric) {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (token !== generation || edits !== editSequence) return;
      const capture = renderer.capture();
      const previews = {
        isometric: "data:" + capture.mimeType + ";base64," + capture.data,
      };
      const saved = await request("tools/call", {
        name: "cad.savePreviews",
        arguments: { partId: part.id, previews },
      });
      if (saved.isError)
        throw Error(saved.content?.[0]?.text || "Preview could not be saved.");
      part.previews = previews;
    }
  }
  function renderLibrary(query = "") {
    const container = $("parts");
    container.replaceChildren();
    for (const part of catalog.filter((p) =>
      (p.name + " " + p.tags.join(" "))
        .toLowerCase()
        .includes(query.toLowerCase()),
    )) {
      const button = document.createElement("button"),
        title = document.createElement("strong"),
        description = document.createElement("small");
      button.className = "part";
      title.textContent = part.name;
      description.textContent = part.description;
      if (part.previews.isometric) {
        const image = document.createElement("img");
        image.src = part.previews.isometric;
        image.alt = "";
        button.append(image);
      }
      button.append(title, description);
      button.onclick = act(() => openPart(part));
      container.append(button);
    }
    if (!container.children.length)
      container.textContent = "No matching parts.";
  }
  async function generatePreviews() {
    for (const part of catalog) {
      if (disposed) return;
      if (part.previews.isometric || !["stl", "3mf"].includes(part.format))
        continue;
      try {
        const response = await request("tools/call", {
          name: "cad.readPart",
          arguments: { partId: part.id, representation: "display" },
        });
        if (disposed) return;
        if (response.isError) throw Error("Could not read preview source.");
        const source = response.structuredContent;
        const bytes = Uint8Array.from(atob(source.blob), (c) =>
          c.charCodeAt(0),
        ).buffer;
        const previews = await renderCadPreviews(
          source.format as ModelFormat,
          bytes,
        );
        if (disposed) return;
        const saved = await request("tools/call", {
          name: "cad.savePreviews",
          arguments: { partId: part.id, previews },
        });
        if (saved.isError) throw Error("Could not save preview.");
        const currentPart = catalog.find(
          (candidate) => candidate.id === part.id,
        );
        if (currentPart) currentPart.previews = previews;
        renderLibrary($("search").value);
      } catch (error) {
        if (!disposed) fail(error);
      }
    }
  }
  async function readFile(file: FileInfo, token: number) {
    const sequence = ++readSequence,
      edits = editSequence;
    const response = await request("resources/read", {
      uri: file.resourceUri,
      _meta: { "openai/resource": { representation: "blob" } },
    });
    if (token !== generation || sequence !== readSequence) return;
    if (edits !== editSequence) {
      status(
        "File read completed after a local edit. Reload to replace your edit.",
      );
      return;
    }
    const content =
      response.contents?.find((c: any) => c.uri === file.resourceUri) ||
      response.contents?.[0];
    if (!content) throw new Error("Host returned no file contents.");
    const bytes =
      content.blob !== undefined
        ? Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(content.text || "");
    await renderer.load(
      {
        format: file.name.split(".").pop()?.toLowerCase() || "stl",
        bytes: bytes.buffer,
      },
      () =>
        token === generation &&
        sequence === readSequence &&
        edits === editSequence,
    );
    if (edits !== editSequence)
      throw Error("Reload canceled because you edited the current geometry.");
    if (token !== generation || sequence !== readSequence) return;
    state.selection = null;
    importedSource = null;
    state.etag = content._meta?.["openai/resource"]?.etag || null;
    state.writable =
      file.name.toLowerCase().endsWith(".stl") &&
      content._meta?.["openai/resource"]?.writable === true;
    state.dirty = false;
    $("save").disabled = true;
    show("viewer");
    queueContext();
  }
  async function openFile(file: FileInfo, discardUnsaved = false) {
    if (state.file?.resourceUri === file.resourceUri) return;
    ensureCanLeave(discardUnsaved);
    if (state.capabilities.experimental?.["openai/resource"] == null)
      throw Error("This host does not advertise file resources.");
    const token = ++generation;
    await unsubscribe().catch(fail);
    if (token !== generation) return;
    state.part = null;
    state.file = file;
    renderer.clear();
    state.etag = null;
    state.writable = false;
    state.dirty = false;
    state.zoom = 1;
    $("save").disabled = true;
    try {
      await request("resources/subscribe", { uri: file.resourceUri });
      if (token === generation) state.subscription = file.resourceUri;
      else await request("resources/unsubscribe", { uri: file.resourceUri });
    } catch (error) {
      fail(error);
    }
    if (token === generation) await readFile(file, token);
  }
  async function save() {
    if (
      !state.file ||
      !state.file.name.toLowerCase().endsWith(".stl") ||
      !state.writable ||
      !state.etag
    )
      throw new Error("This host has not provided a writable, versioned file.");
    const token = generation,
      uri = state.file.resourceUri,
      version = state.etag,
      edits = editSequence;
    const response = await request("openai/resources/write", {
      uri,
      text: renderer.exportStl(),
      ifMatch: version,
    });
    if (token !== generation) return response;
    if (response.outcome === "saved") {
      state.etag = response.etag;
      state.dirty = edits !== editSequence;
      $("save").disabled = !state.dirty;
      status(
        state.dirty
          ? "Saved earlier rotation; newer edits are unsaved."
          : "Saved.",
      );
    } else if (response.outcome === "conflict")
      status(
        "File changed outside this viewer. Reload before editing again; your changes were not saved.",
      );
    else if (response.outcome === "too-large")
      status("Host rejected the file: limit " + response.maxBytes + " bytes.");
    else throw new Error("Unrecognized save response.");
    return response;
  }
  function queueContext() {
    clearTimeout(contextTimer);
    if (state.connected && state.page === "viewer")
      contextTimer = setTimeout(() => shareContext(false).catch(fail), 300);
  }
  function viewContext(withImage: boolean) {
    const data = {
      page: state.page,
      dirty: state.dirty,
      writable: state.writable,
      part: state.part?.id || null,
      file: state.file?.name || null,
      camera: state.camera,
      yawRadians: state.yaw,
      pitchRadians: state.pitch,
      zoom: state.zoom,
      mode: state.mode,
      grid: state.grid,
      displayUnits: state.units,
      dimensionsMm: renderer.triangleCount() ? renderer.bounds().size : null,
      note: $("note").value,
      selection: state.selection ?? null,
      renderer: renderer.context?.() ?? null,
    };
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: "Bits & Bolts selected view: " + JSON.stringify(data),
        annotations: { audience: ["assistant"] },
      },
    ];
    if (state.part)
      content.unshift({
        type: "text",
        text: `${state.part.name}: ${state.part.description}\nPart ID: ${state.part.id}\nResource: ${state.part.resourceUri}`,
        _meta: {
          "openai/title": state.part.name,
          ...(state.part.previews.isometric
            ? { "openai/thumbnail": { src: state.part.previews.isometric } }
            : {}),
        },
      });
    if (withImage)
      content.push({
        type: "image",
        ...renderer.capture(),
        _meta: {
          "openai/title": `View of ${state.part?.name || state.file?.name || "the part"}`,
        },
      });
    return { content, structuredContent: data };
  }
  async function shareContext(withImage: boolean) {
    if (!renderer.triangleCount()) return;
    await request("ui/update-model-context", viewContext(withImage));
    // Effective attached state is displayed only from hostContext below.
    if (withImage) status("View context sent to host.");
  }
  function applyHost(update: Record<string, any>) {
    Object.assign(state.host, update);
    document.documentElement.style.setProperty(
      "--cursor-interaction",
      state.host["openai/interactionCursor"] === "default"
        ? "default"
        : "pointer",
    );
    if (update.theme) {
      document.documentElement.style.colorScheme = update.theme;
      document.documentElement.dataset.theme = update.theme;
      window.dispatchEvent(new Event("cad-theme-change"));
    }
    if (typeof update.styles?.css?.fonts === "string") {
      let fonts = $("host-fonts");
      if (!fonts) {
        fonts = document.createElement("style");
        fonts.id = "host-fonts";
        document.head.append(fonts);
      }
      fonts.textContent = update.styles.css.fonts;
    }
    for (const [key, value] of Object.entries(update.styles?.variables || {}))
      if (key.startsWith("--") && typeof value === "string")
        document.documentElement.style.setProperty(key, value);
    if (
      Object.hasOwn(update, "openai/modelContext") &&
      update["openai/modelContext"] === null
    ) {
      clearTimeout(contextTimer);
      $("note").value = "";
      state.selection = null;
      renderer.clearSelection();
    }
    if (Object.hasOwn(update, "openai/modelContext"))
      $("attached").textContent =
        update["openai/modelContext"] === null
          ? "No view attached"
          : update["openai/modelContext"]?.updateId
            ? "View attached"
            : "Context state unavailable";
    if (update["openai/deepLink"]?.url) {
      const url = new URL(
        update["openai/deepLink"].url,
        "https://bits-and-bolts.invalid",
      );
      const id = decodeURIComponent(url.pathname.replace(/^\/parts\//, "")),
        part = catalog.find((p) => p.id === id);
      if (part) void openPart(part).catch(fail);
      else if (url.pathname === "/settings") {
        ensureCanLeave();
        show("settings");
      } else if (url.pathname === "/") {
        ensureCanLeave();
        show("library");
      }
    }
    $("fullscreen").hidden =
      !state.host.availableDisplayModes?.includes("fullscreen");
    $("fullscreen").textContent =
      state.host.displayMode === "fullscreen" ? "Return" : "Expand";
    draw();
  }
  async function toolResult(payload: any) {
    if (payload?.isError)
      throw new Error(
        payload.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n") || "Tool failed.",
      );
    const data = payload?.structuredContent;
    if (!data) return;
    if (data.parts) {
      catalog = data.parts;
      renderLibrary($("search").value);
      previewTask ??= generatePreviews().finally(() => {
        previewTask = undefined;
      });
    }
    if (data.localFilesystem !== undefined)
      localFilesystem = data.localFilesystem;
    if (data.settingsLifetime)
      $("settings-info").textContent = data.settingsLifetime;
    if (
      (data.file && state.file?.resourceUri !== data.file.resourceUri) ||
      (data.part && state.part?.id !== data.part.id) ||
      (data.page && data.page !== state.page)
    )
      ensureCanLeave();
    if (data.preferences) {
      state.syncedSettings = true;
      state.units = data.preferences.units;
      state.grid = data.preferences.showGrid;
      $("units").value = state.units;
      $("grid").checked = state.grid;
      state.defaultView = data.preferences.defaultView;
      $("default-camera").value = state.defaultView;
      camera(state.defaultView);
    }
    if (data.file) await openFile(data.file);
    else if (data.part) {
      await openPart(data.part);
    } else if (data.page) show(data.page);
    if (data.camera) camera(data.camera);
    if (data.mode) {
      state.mode = data.mode;
      $("mode").value = data.mode;
      draw();
      queueContext();
    }
    if (initialDeepLink) {
      const link = initialDeepLink;
      initialDeepLink = null;
      applyHost({ "openai/deepLink": link });
    }
  }
  function resize() {
    if (resizing !== undefined) cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() =>
      notify("ui/notifications/size-changed", {
        height: Math.ceil(document.body.getBoundingClientRect().height),
      }),
    );
  }
  type Rule = {
    type: string;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    maxLength?: number;
  };
  const liveTools: Array<{
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, Rule>;
      required?: string[];
      additionalProperties: boolean;
    };
    annotations?: { readOnlyHint: boolean };
  }> = [
    {
      name: "read_view",
      description:
        "Read the current mounted Bits & Bolts view, including part, camera, zoom, note and unsaved edits.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "open_part",
      description:
        "Open a catalog part in this mounted view. Refuses to discard unsaved geometry unless discardUnsaved is true.",
      inputSchema: {
        type: "object",
        properties: {
          partId: { type: "string" },
          discardUnsaved: { type: "boolean" },
        },
        required: ["partId"],
        additionalProperties: false,
      },
    },
    {
      name: "configure_view",
      description:
        "Change this mounted viewer's camera or display while preserving its current part and geometry.",
      inputSchema: {
        type: "object",
        properties: {
          camera: { type: "string", enum: renderer.cameras },
          mode: { type: "string", enum: renderer.modes },
          zoom: { type: "number", minimum: 0.3, maximum: 3 },
          grid: { type: "boolean" },
          units: { type: "string", enum: ["mm", "in"] },
          yawRadians: { type: "number" },
          pitchRadians: { type: "number" },
          note: { type: "string", maxLength: 8192 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "rotate_geometry",
      description:
        "Rotate the current geometry 90 degrees around X, marking an unsaved edit. Does not write the file.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "save_file",
      description:
        "Save this viewer's edited file with its current ETag. A conflict preserves unsaved edits and does not overwrite the external change.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  async function callLiveTool(params: any) {
    const tool = liveTools.find((t) => t.name === params?.name);
    if (!tool) throw new Error("Unknown app tool.");
    const args = params.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Arguments must be an object.");
    for (const key of tool.inputSchema.required || [])
      if (!Object.hasOwn(args, key))
        throw new Error("Missing argument: " + key);
    for (const [key, value] of Object.entries(args)) {
      const rule = tool.inputSchema.properties[key];
      if (
        !rule ||
        typeof value !== rule.type ||
        (rule.enum && !rule.enum.includes(value)) ||
        (typeof value === "number" &&
          (!Number.isFinite(value) ||
            (rule.minimum !== undefined && value < rule.minimum) ||
            (rule.maximum !== undefined && value > rule.maximum))) ||
        (rule.maxLength !== undefined &&
          typeof value === "string" &&
          value.length > rule.maxLength)
      )
        throw new Error("Invalid argument: " + key);
    }
    if (tool.name === "open_part") {
      if (state.dirty && !args.discardUnsaved)
        throw new Error(
          "The view has unsaved geometry. Save it first or explicitly discard it.",
        );
      const part = catalog.find((p) => p.id === args.partId);
      if (!part) throw Error("Unknown part: " + args.partId);
      await openPart(part, args.discardUnsaved === true);
    } else if (tool.name === "configure_view") {
      if (state.page !== "viewer" || !renderer.triangleCount())
        throw new Error("Open a part first.");
      if (args.camera !== undefined) camera(args.camera);
      if (args.yawRadians !== undefined || args.pitchRadians !== undefined) {
        state.yaw = args.yawRadians ?? state.yaw;
        state.pitch = args.pitchRadians ?? state.pitch;
        camera("custom");
      }
      if (args.mode !== undefined) {
        state.mode = args.mode;
        $("mode").value = args.mode;
      }
      if (args.zoom !== undefined) state.zoom = args.zoom;
      if (args.grid !== undefined) {
        state.grid = args.grid;
        $("grid").checked = args.grid;
      }
      if (args.units !== undefined) {
        state.units = args.units;
        $("units").value = args.units;
      }
      if (args.note !== undefined) $("note").value = args.note;
      draw();
      queueContext();
    } else if (tool.name === "rotate_geometry") rotateGeometry();
    else if (tool.name === "save_file") {
      const result = await save();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.outcome !== "saved",
      };
    }
    return viewContext(false);
  }
  transport.on("ui/notifications/tool-result", (payload) => {
    void toolResult(payload).catch(fail);
  });
  transport.on("ui/notifications/tool-input", (payload) => {
    if (payload?.arguments?.file)
      void openFile(payload.arguments.file).catch(fail);
  });
  transport.on("ui/notifications/host-context-changed", (payload) => {
    try {
      applyHost(payload);
    } catch (error) {
      fail(error);
    }
  });
  transport.on("notifications/resources/updated", (payload) => {
    if (!state.file || state.file.resourceUri !== payload.uri) return;
    if (state.dirty)
      status(
        "File changed externally. Your unsaved geometry is preserved; reload explicitly to discard it.",
      );
    else void readFile(state.file, generation).catch(fail);
  });
  transport.handle("ui/resource-teardown", async () => {
    disposed = true;
    clearTimeout(contextTimer);
    await unsubscribe().catch(() => {});
    renderer.dispose();
    setTimeout(() => transport.dispose(), 0);
    return {};
  });
  transport.handle("tools/list", () => ({ tools: liveTools }));
  transport.handle("tools/call", async (params) => {
    try {
      return await callLiveTool(params);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });
  transport.handle("ping", () => ({}));
  $("back").onclick = act(() => {
    ensureCanLeave();
    generation++;
    clearTimeout(contextTimer);
    unsubscribe().catch(fail);
    state.file = null;
    state.part = null;
    renderer.clear();
    state.dirty = false;
    show("library");
    if (state.connected)
      request("ui/update-model-context", {
        content: [],
        structuredContent: { page: "library" },
      }).catch(fail);
  });
  $("search").oninput = (e: any) => renderLibrary(e.target.value);
  $("host-file-open").onclick = act(async () => {
    if (state.capabilities.experimental?.["openai/files"] == null)
      throw new Error("This host does not support opening local files.");
    await request("openai/files/open", { path: $("host-file-path").value });
    status("Opened in Codex.");
  });
  $("host-file-path").onkeydown = (event: any) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("host-file-open").click();
    }
  };
  $("camera").onchange = (e: any) => camera(e.target.value);
  $("mode").onchange = (e: any) => {
    state.mode = e.target.value;
    draw();
    queueContext();
  };
  $("share").onclick = act(() => {
    clearTimeout(contextTimer);
    return shareContext(true);
  });
  $("ask").onclick = act(async () => {
    clearTimeout(contextTimer);
    await shareContext(false);
    status("Continue in Codex to confirm the follow-up.");
    const reply = await request("ui/message", {
      role: "user",
      content: [
        {
          type: "text",
          text: $("note").value || "Explain the CAD part in my attached view.",
        },
        ...viewContext(true).content,
      ],
    });
    if (reply.isError) throw new Error("Host declined the message.");
    status("Continue in chat.");
  });
  $("note").oninput = () => queueContext();
  $("save").onclick = act(save);
  $("reload").onclick = act(() => {
    if (state.file) return readFile(state.file, generation);
  });
  function rotateGeometry() {
    if (!renderer.triangleCount()) throw new Error("Open a part first.");
    editSequence++;
    renderer.rotate();
    state.selection = null;
    state.dirty = true;
    $("save").disabled = !(state.writable && state.etag);
    draw();
    queueContext();
  }
  $("fit").onclick = act(() => {
    state.zoom = 1;
    renderer.fit();
    draw();
    queueContext();
  });
  $("settings-button").onclick = act(() => {
    ensureCanLeave();
    show("settings");
  });
  $("open-source").onclick = act(async () => {
    if (!state.part || !localFilesystem)
      throw Error("A local catalog part is required.");
    const result = await request("tools/call", {
      name: "cad.partPath",
      arguments: { partId: state.part.id },
    });
    if (result.isError)
      throw Error(result.content?.[0]?.text || "Source unavailable.");
    await request("openai/files/open", { path: result.structuredContent.path });
  });
  $("rotate").onclick = act(rotateGeometry);
  $("fullscreen").onclick = act(async () => {
    if (!state.host.availableDisplayModes?.includes("fullscreen"))
      throw new Error("Host does not advertise fullscreen support.");
    const response = await request("ui/request-display-mode", {
      mode: state.host.displayMode === "fullscreen" ? "inline" : "fullscreen",
    });
    status("Display mode: " + response.mode);
  });
  $("download").onclick = act(async () => {
    if (!state.capabilities.downloadFile)
      throw new Error("This host does not support file downloads.");
    const name = (state.part?.id || "part") + ".stl";
    const response = await request("ui/download-file", {
      contents: [
        {
          type: "resource",
          resource: {
            uri: "file:///" + encodeURIComponent(name),
            mimeType: "model/stl",
            text: renderer.exportStl(),
          },
        },
      ],
    });
    status(response.isError ? "Download canceled." : "STL saved.");
  });
  $("import").onchange = act(async (event: any) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) throw new Error("File exceeds 16 MiB.");
    ensureCanLeave();
    const token = ++generation;
    await unsubscribe().catch(fail);
    const edits = editSequence;
    const source = {
      format: file.name.split(".").pop()?.toLowerCase() || "stl",
      bytes: await file.arrayBuffer(),
    };
    await renderer.load(
      source,
      () => token === generation && edits === editSequence,
    );
    if (edits !== editSequence)
      throw Error("Import canceled because you edited the current geometry.");
    if (token !== generation) return;
    importedSource = source;
    state.selection = null;
    state.part = {
      name: file.name,
      id: "imported",
      tags: [],
      description: "Imported file",
      fileName: file.name,
      resourceUri: "",
      format: file.name
        .split(".")
        .pop()
        ?.toLowerCase() as PublicCadPart["format"],
      previews: {},
      sizeBytes: file.size,
      sourceLabel: file.name,
      updatedAt: new Date().toISOString(),
    };
    state.file = null;
    state.writable = false;
    state.etag = null;
    state.dirty = false;

    $("save").disabled = true;
    show("viewer");
    queueContext();
  });
  async function savePreferences(key: string, value: unknown) {
    if (state.syncedSettings) {
      const response = await request("tools/call", {
        name: "settings.update",
        arguments: { set: { [key]: value } },
      });
      if (response.isError)
        throw new Error(
          response.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n") || "Settings could not be saved.",
        );
      status("Viewer defaults updated.");
      return;
    }
    status("Preferences apply to this preview only.");
  }
  async function changePreference(
    element: HTMLInputElement,
    key: string,
    value: unknown,
    apply: () => void,
    previous: any,
  ) {
    element.disabled = true;
    try {
      await savePreferences(key, value);
      apply();
      draw();
      queueContext();
    } catch (error) {
      if (element.type === "checkbox") element.checked = previous;
      else element.value = previous;
      fail(error);
    } finally {
      element.disabled = false;
    }
  }
  $("units").onchange = (e: any) =>
    changePreference(
      e.target,
      "units",
      e.target.value,
      () => {
        state.units = e.target.value;
      },
      state.units,
    );
  $("grid").onchange = (e: any) =>
    changePreference(
      e.target,
      "showGrid",
      e.target.checked,
      () => {
        state.grid = e.target.checked;
      },
      state.grid,
    );
  $("default-camera").onchange = (e: any) =>
    changePreference(
      e.target,
      "defaultView",
      e.target.value,
      () => {
        state.defaultView = e.target.value;
        camera(state.defaultView);
      },
      state.defaultView,
    );
  $("skills").onclick = act(async () => {
    const response = await request("ui/open-link", { url: "codex://skills" });
    if (response.isError) throw new Error("The host could not open skills.");
  });
  $("discard").onclick = act(async () => {
    if (state.file) await readFile(state.file, generation);
    else if (importedSource) {
      const token = ++generation,
        edits = editSequence;
      await renderer.load(
        importedSource,
        () => token === generation && edits === editSequence,
      );
      if (token !== generation || edits !== editSequence) return;
      state.dirty = false;
      state.selection = null;
      draw();
      queueContext();
    } else if (state.part) await openPart(state.part, true);
    status("Unsaved geometry discarded.");
  });
  $("add-library").onclick = act(async () => {
    if (!renderer.triangleCount()) throw Error("Open a model first.");
    if (state.dirty)
      throw Error(
        "Save or discard geometry edits before adding the source to your library. Download STL exports your edited geometry.",
      );
    const fileName = state.part?.fileName || state.file?.name || "imported.stl";
    let result;
    if (state.file && localFilesystem)
      result = await request("tools/call", {
        name: "cad.addOpenFile",
        arguments: { fileName },
      });
    else {
      let blob;
      if (importedSource?.bytes) {
        let binary = "";
        for (const byte of new Uint8Array(importedSource.bytes))
          binary += String.fromCharCode(byte);
        blob = btoa(binary);
      } else if (state.file) {
        const response = await request("resources/read", {
          uri: state.file.resourceUri,
          _meta: { "openai/resource": { representation: "blob" } },
        });
        const content = response.contents?.[0];
        if (!content) throw Error("No source file returned.");
        if (content.blob) blob = content.blob;
        else {
          let binary = "";
          for (const byte of new TextEncoder().encode(content.text))
            binary += String.fromCharCode(byte);
          blob = btoa(binary);
        }
      } else {
        status("This part is already in the library.");
        return;
      }
      result = await request("tools/call", {
        name: "cad.importPart",
        arguments: { fileName, blob },
      });
    }
    if (result.isError)
      throw Error(result.content?.[0]?.text || "Import failed");
    await toolResult(
      await request("tools/call", { name: "cad.listParts", arguments: {} }),
    );
    status("Added to library.");
  });
  $("units").value = state.units;
  $("grid").checked = state.grid;
  $("default-camera").value = state.defaultView;
  camera(state.camera);
  new ResizeObserver(() => {
    draw();
    resize();
  }).observe(document.body);
  renderLibrary();
  show("library");
  if (parent !== window)
    request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "bits-and-bolts", version: "0.1.0" },
      appCapabilities: {
        tools: {},
        availableDisplayModes: ["inline", "fullscreen"],
      },
    })
      .then(async (response) => {
        if (response.protocolVersion !== "2026-01-26")
          throw new Error(
            "Unsupported UI protocol: " + response.protocolVersion,
          );
        state.connected = true;
        state.capabilities = response.hostCapabilities || {};
        $("skills").hidden =
          state.capabilities.experimental?.["openai/skillsDeepLinks"] == null;
        $("host-file").hidden =
          state.capabilities.experimental?.["openai/files"] == null;
        initialDeepLink = response.hostContext?.["openai/deepLink"] || null;
        const oldNote =
          response.hostContext?.["openai/modelContext"]?.structuredContent
            ?.note;
        if (typeof oldNote === "string") $("note").value = oldNote;
        applyHost(response.hostContext || {});
        notify("ui/notifications/initialized");
        resize();
        status("Connected to " + (response.hostInfo?.name || "host"));
        const listing = await request("tools/call", {
          name: "cad.listParts",
          arguments: {},
        });
        await toolResult(listing);
      })
      .catch(fail);
  else status("Standalone preview. Host features require an MCP app host.");
}

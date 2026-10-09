import { createRenderer } from "./renderers/three.js";
import { createLibrary, filterParts } from "./library.js";
import { createPointAnnotations } from "./point-annotations.js";
import { readLibraryCache, writeLibraryCache } from "./library-cache.js";
import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod/v4";
import {
  OpenAIExtensions,
  type OpenAIModelContextHostState,
  type OpenAIDeepLinkHostState,
} from "@openai/mcp-extensions/app";
import {
  partSourceResultSchema,
  previewImagesSchema,
  publicCadPartSchema,
  type CadPartMetadata,
  type PublicCadPart,
  type CadPreferences,
} from "../shared/contracts.js";
import type { RenderState, ModelSource } from "./renderers/types.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
type FileInfo = { name: string; resourceUri: string };
type AppState = RenderState & {
  part: PublicCadPart | null;
  file: FileInfo | null;
  etag: string | null;
  writable: boolean;
  dirty: boolean;
  page: "library" | "viewer";
  defaultView: string;
  capabilities: NonNullable<ReturnType<App["getHostCapabilities"]>>;
  host: NonNullable<ReturnType<App["getHostContext"]>>;
  connected: boolean;
  subscription: string | null;
};
export function startApp() {
  const surface = document.documentElement.dataset.surface;
  const persistLibrary =
    document.documentElement.dataset.persistLibrary === "true";
  const cachedCatalog = persistLibrary ? readLibraryCache() : null;
  let catalog: PublicCadPart[] = cachedCatalog ?? [];
  let catalogLoaded = false;
  let catalogError = false;
  let catalogRequest: Promise<void> | undefined;
  let catalogRevision = 0;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  const canShare = () =>
    state.connected &&
    ["widget", "thread", "global"].includes(surface || "") &&
    openai.modelContext != null;
  let initialToolResultPending = true;
  let importedSource: ModelSource | null = null;
  let importPending = false;
  let localFilesystem = false;
  let uploadUrl: string | undefined;
  type ElementFor<Id extends string> = Id extends "camera" | "mode"
    ? HTMLSelectElement
    : Id extends "part-prompt"
      ? HTMLTextAreaElement
      : Id extends "create-part-dialog"
        ? HTMLDialogElement
        : Id extends "search" | "import"
          ? HTMLInputElement
          : Id extends "part-tools"
            ? HTMLDetailsElement
            : Id extends "unsaved-dialog"
              ? HTMLDialogElement
              : Id extends
                    | "add-library"
                    | "save"
                    | "new-part"
                    | "create-part"
                    | "cancel-create-part"
                ? HTMLButtonElement
                : HTMLElement;
  const $ = <Id extends string>(id: Id) =>
    document.getElementById(id) as ElementFor<Id>;
  const state: AppState = {
    part: null,
    file: null,
    etag: null,
    writable: false,
    dirty: false,
    page: "library",
    defaultView: "isometric",
    get camera(): string {
      return renderer.camera()?.camera ?? state.defaultView;
    },
    mode: "solid",
    get yaw(): number {
      return renderer.camera()?.yaw ?? -0.6;
    },
    get pitch(): number {
      return renderer.camera()?.pitch ?? 0.6;
    },
    get zoom(): number {
      return renderer.camera()?.zoom ?? 1;
    },
    units: "mm",
    grid: true,
    host: {},
    capabilities: {},
    connected: false,
    subscription: null,
  };
  const app = new App(
    { name: "bits-and-bolts", version: "0.1.0" },
    { tools: {} },
    { autoResize: false },
  );
  const openai = new OpenAIExtensions(app);
  let generation = 0,
    readSequence = 0,
    editSequence = 0;
  let contextTimer: ReturnType<typeof setTimeout> | undefined;
  let resizing: number | undefined;
  let pendingDeepLink: { url?: string } | null = null;
  let selectedParts: ContentBlock[] = [];
  let contextPending = false;
  let ownContextUpdateId: string | undefined;
  let pendingHostContext: OpenAIModelContextHostState | undefined;
  let submittedContext: ReturnType<typeof viewContext> | undefined;
  let createPartPending = false;
  let contextQueued = false;
  const status = (message: string) => {
    $("status").textContent = message;
  };
  const renderer = createRenderer({
    container: $("viewport"),
    onChange(change) {
      Object.assign(state, change);
      if (change.selection != null && canShare()) {
        pointAnnotations.add({
          partName: state.part?.name || state.file?.name || "Part",
          selection: change.selection,
          dimensionsMm: renderer.bounds().size,
          camera: state.camera,
          image:
            state.capabilities.updateModelContext?.image != null
              ? renderer.capture()
              : undefined,
        });
        if (!catalogLoaded) void loadCatalog().catch(fail);
      }
      $("camera").value = state.camera;
      $("selection").textContent = state.selection
        ? "Point selected"
        : "Click a point to annotate";
      queueContext();
    },
    async readWasm() {
      const response = await app.readServerResource({
        uri: "cad-resource://bits-and-bolts/occt-import-js.wasm",
      });
      const content = response.contents?.[0];
      if (content && "text" in content && /^https?:\/\//.test(content.text)) {
        const download = await fetch(content.text);
        if (!download.ok) throw Error("The STEP importer is unavailable.");
        return new Uint8Array(await download.arrayBuffer());
      }
      if (!content || !("blob" in content))
        throw Error("The STEP importer is unavailable.");
      return Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0));
    },
  });
  const pointAnnotations = createPointAnnotations({
    container: $("point-annotations"),
    getParts: () =>
      state.capabilities.updateModelContext?.resourceLink != null
        ? catalog.filter((part) => part.id !== state.part?.id)
        : [],
    onChange: () => queueContext(0),
  });
  const library = createLibrary({
    openPart: (part) => openPart(part).catch(fail),
    canOpen: () => state.connected,
    isSelected: (partId) =>
      selectedParts.some(
        (block) => block._meta?.["bits-and-bolts/partId"] === partId,
      ),
    showSelection: canShare,
    canSelect: () => !contextPending && canShare(),
    toggleSelection: (part) => togglePart(part).catch(fail),
    async loadPreviews(part) {
      if (!state.connected || !["stl", "3mf"].includes(part.format)) return;
      const source = await readPart(part);
      const previews = await renderer.previews(source.format, source.bytes);
      part.previews = previews;
      if (persistLibrary) writeLibraryCache(catalog);
      // Display the preview even if persistence is unavailable in this host.
      void app
        .callServerTool({
          name: "cad.savePreviews",
          arguments: { partId: part.id, previews },
        })
        .catch(() => {});
      return previews;
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
  $("mode").value = state.mode;
  $("import").accept = renderer.formats.map((format) => "." + format).join(",");
  function fail(error: unknown) {
    status(error instanceof Error ? error.message : String(error));
    $("status").scrollIntoView({ block: "nearest" });
  }
  const act =
    <Args extends unknown[]>(fn: (...args: Args) => unknown) =>
    (...args: Args) =>
      Promise.resolve()
        .then(() => fn(...args))
        .catch(fail);

  function draw() {
    $("open-source").hidden = !(
      localFilesystem &&
      state.part?.id !== "imported" &&
      state.part &&
      openai.files != null
    );
    const unit = state.units === "in" ? 25.4 : 1;
    $("dimensions").textContent = renderer.triangleCount()
      ? renderer
          .bounds()
          .size.map((v) => (v / unit).toFixed(2))
          .join(" × ") +
        " " +
        state.units
      : "—";
    $("model-format").textContent = (
      state.part?.format ||
      state.file?.name.split(".").pop() ||
      "—"
    ).toUpperCase();
    $("model-file").textContent =
      state.part?.fileName || state.file?.name || "—";
    $("part-description").textContent = state.part?.description || "";
    $("part-description").parentElement!.hidden = !state.part?.description;
    $("dirty-indicator").hidden = !state.dirty;
    $("dimension-note").hidden = !renderer.bounds().assumedMillimeters;
    $("selection").textContent = state.selection
      ? "Point selected"
      : "Click a point to annotate";
    $("add-library").disabled = importPending;
    $("add-library").hidden = !!state.part && state.part.id !== "imported";
    $("add-library").textContent = importPending ? "Adding…" : "Add to library";
    $("download").hidden = !state.capabilities.downloadFile;
    $("save").hidden = !state.writable || !state.dirty;
    $("reload").hidden = !state.file;
    $("discard").hidden = !state.dirty;
    $("part-tools").hidden = !$("part-tools").querySelector(
      "button:not([hidden])",
    );
  }
  function ensureCanLeave(discardUnsaved = false) {
    if (state.dirty && !discardUnsaved)
      throw Error(
        "This view has unsaved geometry. Save it or explicitly discard changes before navigating.",
      );
  }
  function camera(name: string) {
    if (!renderer.camera()) state.defaultView = name;
    renderer.configure({ camera: name });
    $("camera").value = state.camera;
    draw();
    queueContext();
  }
  function show(page: AppState["page"]) {
    if (page !== state.page) resetContext();
    updateCreatePartForm();
    state.page = page;
    document.documentElement.dataset.page = page;
    $("part-tools").open = false;
    $("viewer-actions").hidden = page !== "viewer";
    $("library").hidden = page !== "library";
    $("viewer").hidden = page !== "viewer";
    $("heading").textContent =
      page === "viewer"
        ? state.part?.name || state.file?.name || "STL viewer"
        : "Bits & Bolts";
    updateLibraryNavigation();
    $("view-toolbar").hidden = page === "library" && surface === "global";
    $("add-part").hidden = page !== "library";
    if (page === "library") renderLibrary();
    updateSelection();
    draw();
    resize();
    queueContext(0);
  }
  function updateLibraryNavigation() {
    const inlinePart =
      surface === "widget" &&
      state.page === "viewer" &&
      state.host.displayMode !== "fullscreen";
    $("back").hidden = state.page === "library" || inlinePart;
    $("view-library").hidden =
      !inlinePart || !state.host.availableDisplayModes?.includes("fullscreen");
  }
  function showLibrary() {
    ensureCanLeave();
    generation++;
    pendingDeepLink = null;
    clearTimeout(contextTimer);
    void unsubscribe().catch(fail);
    state.file = null;
    state.part = null;
    importedSource = null;
    state.selection = null;
    state.etag = null;
    state.writable = false;
    resetContext();
    renderer.clear();
    status("");
    show("library");
    if (!catalogLoaded && state.connected) void loadCatalog();
  }
  async function unsubscribe() {
    const uri = state.subscription;
    state.subscription = null;
    if (uri) await openai.resources!.unsubscribe({ uri });
  }
  async function readPart(part: PublicCadPart) {
    let source: ReturnType<typeof partSourceResultSchema.parse> | undefined =
      part.displaySource;
    if (!source) {
      const response = await app.callServerTool({
        name: "cad.readPart",
        arguments: { partId: part.id, representation: "display" },
      });
      if (response.isError)
        throw Error(
          response.content.find((block) => block.type === "text")?.text ||
            "Could not load part.",
        );
      source = partSourceResultSchema.parse(response.structuredContent);
    }
    if ("url" in source) {
      const response = await fetch(source.url);
      if (!response.ok)
        throw Error(`Could not load CAD part (${response.status}).`);
      return { format: source.format, bytes: await response.arrayBuffer() };
    }
    return {
      format: source.format,
      bytes: Uint8Array.from(atob(source.blob), (c) => c.charCodeAt(0)).buffer,
    };
  }
  async function openPart(part: PublicCadPart, discardUnsaved = false) {
    pendingDeepLink = null;
    if (state.part?.id === part.id && !discardUnsaved) {
      generation++;
      show("viewer");
      return;
    }
    ensureCanLeave(discardUnsaved);
    const token = ++generation,
      edits = editSequence;
    const source = await readPart(part);
    if (token !== generation) return;
    await renderer.load(
      source,
      () => token === generation && edits === editSequence,
      state,
    );
    if (edits !== editSequence)
      throw Error("Loading canceled because you edited the current geometry.");
    if (token !== generation) return;
    void unsubscribe().catch(fail);
    state.selection = null;
    importedSource = null;
    if (state.part?.id !== part.id) {
      resetContext();
    }
    state.part = part;
    state.file = null;
    state.etag = null;
    state.writable = false;
    state.dirty = false;
    renderer.configure({ zoom: 1 });
    $("save").disabled = true;
    camera(state.camera);
    show("viewer");
    if (!part.previews.isometric) {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (token !== generation || edits !== editSequence) return;
      const previews = renderer.capturePreviews();
      const saved = await app.callServerTool({
        name: "cad.savePreviews",
        arguments: { partId: part.id, previews },
      });
      if (saved.isError)
        throw Error(
          saved.content.find((block) => block.type === "text")?.text ||
            "Preview could not be saved.",
        );
      part.previews = previews;
    }
  }
  function renderLibrary() {
    pointAnnotations.refreshReferences();
    library.render(
      catalog,
      $("search").value,
      catalogLoaded || cachedCatalog !== null
        ? "ready"
        : catalogError
          ? "error"
          : "loading",
    );
    $("retry-library").hidden = !catalogError || catalogLoaded;
    if (state.page === "library") queueContext();
  }
  function loadCatalog(): Promise<void> {
    if (catalogLoaded || !state.connected) return Promise.resolve();
    if (catalogRequest) return catalogRequest;
    if (catalogError) status("");
    catalogError = false;
    renderLibrary();
    const revision = catalogRevision;
    catalogRequest = app
      .callServerTool({ name: "cad.listParts", arguments: {} })
      .then((listing) => {
        if (state.connected && revision === catalogRevision)
          return toolResult(listing);
      })
      .catch((error) => {
        if (state.connected && !catalogLoaded) {
          catalogError = true;
          renderLibrary();
          fail(error);
        }
      })
      .finally(() => {
        catalogRequest = undefined;
      });
    return catalogRequest;
  }
  async function readFile(file: FileInfo, token: number) {
    const sequence = ++readSequence,
      edits = editSequence;
    const response = await openai.resources!.read({
      uri: file.resourceUri,
      representation: "blob",
    });
    if (token !== generation || sequence !== readSequence) return;
    if (edits !== editSequence) {
      status(
        "File read completed after a local edit. Reload to replace your edit.",
      );
      return;
    }
    const content =
      response.contents?.find((c) => c.uri === file.resourceUri) ||
      response.contents?.[0];
    if (!content) throw new Error("Host returned no file contents.");
    const bytes =
      "blob" in content
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
      state,
    );
    if (edits !== editSequence)
      throw Error("Reload canceled because you edited the current geometry.");
    if (token !== generation || sequence !== readSequence) return;
    state.selection = null;
    importedSource = null;
    state.etag = content.openaiMetadata?.etag || null;
    state.writable =
      file.name.toLowerCase().endsWith(".stl") &&
      content.openaiMetadata?.writable === true;
    state.dirty = false;
    $("save").disabled = true;
    show("viewer");
  }
  async function openFile(file: FileInfo, discardUnsaved = false) {
    pendingDeepLink = null;
    if (state.file?.resourceUri === file.resourceUri) {
      if (renderer.triangleCount()) {
        generation++;
        show("viewer");
      }
      return;
    }
    ensureCanLeave(discardUnsaved);
    if (openai.resources == null)
      throw Error("This host does not advertise file resources.");
    const token = ++generation;
    await unsubscribe().catch(fail);
    if (token !== generation) return;
    state.part = null;
    resetContext();
    state.file = file;
    renderer.clear();
    state.etag = null;
    state.writable = false;
    state.dirty = false;
    renderer.configure({ zoom: 1 });
    $("save").disabled = true;
    try {
      await openai.resources!.subscribe({ uri: file.resourceUri });
      if (token === generation) state.subscription = file.resourceUri;
      else await openai.resources!.unsubscribe({ uri: file.resourceUri });
    } catch (error) {
      fail(error);
    }
    if (token === generation) {
      const reading = readFile(file, token);
      const sequence = readSequence;
      try {
        await reading;
      } catch (error) {
        if (token === generation && sequence === readSequence) {
          state.file = null;
          void unsubscribe().catch(fail);
        }
        throw error;
      }
    }
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
    const response = await openai.resources!.write(uri, {
      text: renderer.exportStl(),
      ifMatch: version,
    });
    if (token !== generation) return response;
    if (response.outcome === "saved") {
      state.etag = response.etag;
      state.dirty = edits !== editSequence;
      $("save").disabled = !state.dirty;
      draw();
      queueContext(0);
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
  function queueContext(delay = 300) {
    clearTimeout(contextTimer);
    if (state.connected)
      contextTimer = setTimeout(() => shareContext().catch(fail), delay);
  }
  function partContent(part: PublicCadPart): ContentBlock {
    return {
      ...(state.capabilities.updateModelContext?.resourceLink != null
        ? {
            type: "resource_link" as const,
            uri: part.resourceUri,
            name: part.fileName,
            title: part.name,
            mimeType: "text/markdown",
          }
        : {
            type: "text" as const,
            text: `${part.name}: ${part.description}${part.resourceUri ? `\nPart ID: ${part.id}\nResource: ${part.resourceUri}` : ""}`,
          }),
      _meta: {
        "bits-and-bolts/partId": part.id,
        "openai/group": { title: "Parts" },
        ...(part.previews.isometric
          ? { "openai/thumbnail": { src: part.previews.isometric } }
          : {}),
      },
    };
  }
  function updateSelection() {
    library.updateSelection();
    $("point-annotations").parentElement!.hidden = !canShare();
  }
  function resetContext() {
    selectedParts = [];
    pointAnnotations.clear();
    state.selection = null;
    renderer.clearSelection();
  }
  async function togglePart(part: PublicCadPart) {
    if (contextPending || !canShare()) return;
    clearTimeout(contextTimer);
    const previous = selectedParts;
    selectedParts = previous.some(
      (block) => block._meta?.["bits-and-bolts/partId"] === part.id,
    )
      ? previous.filter(
          (block) => block._meta?.["bits-and-bolts/partId"] !== part.id,
        )
      : [...previous, partContent(part)];
    try {
      await shareContext();
    } catch (error) {
      selectedParts = previous;
      updateSelection();
      throw error;
    }
  }
  function viewContext() {
    const data = {
      page: state.page,
      schematic: state.part?.name || state.file?.name || "Parts library",
      dirty: state.dirty,
      writable: state.writable,
      part: state.part?.id || null,
      file: state.file?.name || null,
      library:
        state.page === "library"
          ? {
              query: $("search").value,
              status: catalogLoaded
                ? "ready"
                : catalogError
                  ? "error"
                  : "loading",
              parts: filterParts(catalog, $("search").value).map(
                ({ id, name }) => ({ id, name }),
              ),
            }
          : null,
      camera: state.camera,
      yawRadians: state.yaw,
      pitchRadians: state.pitch,
      zoom: state.zoom,
      mode: state.mode,
      grid: state.grid,
      displayUnits: state.units,
      dimensionsMm: renderer.triangleCount() ? renderer.bounds().size : null,
      selection: state.selection ?? null,
      renderer: state.page === "viewer" ? (renderer.context?.() ?? null) : null,
    };
    return {
      content: [...selectedParts, ...pointAnnotations.content()].map((block) =>
        block.type === "resource" &&
        state.capabilities.updateModelContext?.resource == null &&
        "text" in block.resource
          ? {
              type: "text" as const,
              text: block.resource.text,
              _meta: block._meta,
            }
          : block,
      ),
      structuredContent: data,
    };
  }
  async function shareContext() {
    if (!state.connected || !canShare()) return;
    if (contextPending) {
      contextQueued = true;
      return;
    }
    contextPending = true;
    updateSelection();
    submittedContext = viewContext();
    try {
      ownContextUpdateId = (await openai.modelContext!.update(submittedContext))
        ?.updateId;
    } finally {
      contextPending = false;
      if (pendingHostContext !== undefined) {
        const context = pendingHostContext;
        pendingHostContext = undefined;
        reconcileContext(context);
      }
      updateSelection();
      if (contextQueued) {
        contextQueued = false;
        void shareContext().catch(fail);
      }
    }
  }
  function reconcileContext(context: OpenAIModelContextHostState) {
    if (
      !submittedContext ||
      (context !== null && context.updateId === ownContextUpdateId)
    )
      return;
    if (
      context !== null &&
      (context.structuredContent?.page !== state.page ||
        context.structuredContent?.part !== (state.part?.id || null) ||
        context.structuredContent?.file !== (state.file?.name || null))
    )
      return;
    const content = context?.content ?? [];
    const sent = submittedContext.content;
    pointAnnotations.reconcile(content, sent);
    selectedParts = selectedParts.filter((block) => {
      const id = block._meta?.["bits-and-bolts/partId"];
      return (
        !sent.some((sent) => sent._meta?.["bits-and-bolts/partId"] === id) ||
        content.some((kept) => kept._meta?.["bits-and-bolts/partId"] === id)
      );
    });
    if (
      context === null &&
      state.selection === submittedContext.structuredContent.selection
    ) {
      state.selection = null;
      renderer.clearSelection();
    }
  }
  function applyHost(update: NonNullable<ReturnType<App["getHostContext"]>>) {
    Object.assign(state.host, update);
    if (Object.hasOwn(update, "safeAreaInsets")) {
      for (const edge of ["top", "right", "bottom", "left"] as const) {
        const value = update.safeAreaInsets?.[edge];
        if (value == null)
          document.documentElement.style.removeProperty(`--safe-area-${edge}`);
        else
          document.documentElement.style.setProperty(
            `--safe-area-${edge}`,
            `${Math.max(0, value)}px`,
          );
      }
    }
    updateSelection();
    if (update.theme) {
      document.documentElement.style.colorScheme = update.theme;
      document.documentElement.dataset.theme = update.theme;
      window.dispatchEvent(new Event("cad-theme-change"));
    }
    if (typeof update.styles?.css?.fonts === "string") {
      let fonts = document.getElementById("host-fonts");
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
    if (Object.hasOwn(update, "openai/modelContext")) {
      const context = update["openai/modelContext"] as
        OpenAIModelContextHostState | undefined;
      if (
        context !== undefined &&
        (context === null || context.updateId !== ownContextUpdateId)
      ) {
        if (contextPending) pendingHostContext = context;
        else reconcileContext(context);
      }
      updateSelection();
    }
    const deepLink = update["openai/deepLink"] as
      OpenAIDeepLinkHostState | undefined;
    if (deepLink?.url) {
      pendingDeepLink = null;
      const url = new URL(deepLink.url, "https://bits-and-bolts.invalid");
      const id = decodeURIComponent(url.pathname.replace(/^\/parts\//, "")),
        part = catalog.find((p) => p.id === id);
      if (!catalogLoaded && url.pathname.startsWith("/parts/")) {
        ensureCanLeave();
        generation++;
        pendingDeepLink = deepLink;
      } else if (part) void openPart(part).catch(fail);
      else if (url.pathname === "/") {
        showLibrary();
      }
    }
    document.documentElement.dataset.displayMode =
      state.host.displayMode || "inline";
    updateLibraryNavigation();
    draw();
  }
  async function toolResult(
    payload: Awaited<ReturnType<App["callServerTool"]>>,
    initial = false,
  ) {
    if (payload?.isError)
      throw new Error(
        payload.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") || "Tool failed.",
      );
    const data = payload?.structuredContent as
      | Partial<{
          parts: PublicCadPart[];
          localFilesystem: boolean;
          uploadUrl: string;
          file: FileInfo;
          part: CadPartMetadata & { previews?: PublicCadPart["previews"] };
          page: AppState["page"];
          preferences: CadPreferences;
          camera: string;
          mode: string;
        }>
      | undefined;
    if (!data) return;
    if (data.parts && (!initial || !catalogLoaded)) {
      catalogRevision++;
      catalogLoaded = true;
      catalogError = false;
      catalog = data.parts;
      if (persistLibrary) writeLibraryCache(catalog);
      renderLibrary();
    }
    if (data.localFilesystem !== undefined)
      localFilesystem = data.localFilesystem;
    if (typeof data.uploadUrl === "string") uploadUrl = data.uploadUrl;
    if (
      (data.file && state.file?.resourceUri !== data.file.resourceUri) ||
      (data.part && state.part?.id !== data.part.id) ||
      (data.page === "library" && data.page !== state.page)
    )
      ensureCanLeave();
    if (data.preferences) {
      state.units = data.preferences.units;
      state.grid = data.preferences.showGrid;
      state.defaultView = data.preferences.defaultView;
      renderer.configure({ units: state.units, grid: state.grid });
      camera(state.defaultView);
    }
    // A startup link owns initial routing, but newer user navigation wins.
    if (!initial || (generation === 0 && !pendingDeepLink)) {
      if (data.file || data.part) {
        const opening = data.file
          ? openFile(data.file)
          : openPart({
              ...data.part!,
              previews: previewImagesSchema.parse(
                payload._meta?.previews ?? data.part?.previews ?? {},
              ),
            });
        const token = generation;
        await opening;
        if (token !== generation) return;
      } else if (data.page === "library") showLibrary();
      if (data.camera) camera(data.camera);
      if (data.mode) {
        state.mode = data.mode;
        renderer.configure({ mode: state.mode });
        $("mode").value = state.mode;
        draw();
        queueContext();
      }
    }
    if (pendingDeepLink && catalogLoaded && !initialToolResultPending) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      applyHost({ "openai/deepLink": link });
    }
  }
  function resize() {
    if (resizing !== undefined) cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => {
      if (state.connected)
        void app
          .sendSizeChanged({
            height: Math.ceil(document.body.getBoundingClientRect().height),
          })
          .catch(fail);
    });
  }

  app.registerTool(
    "read_view",
    {
      description: "Read the current part, camera, zoom, and unsaved edits.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    () => viewContext(),
  );
  app.registerTool(
    "open_part",
    {
      description: "Open a library part in the current viewer.",
      inputSchema: z.strictObject({
        partId: z.string(),
        discardUnsaved: z.boolean().optional(),
      }),
    },
    async (args) => {
      if (state.dirty && !args.discardUnsaved)
        throw Error(
          "The view has unsaved geometry. Save it first or explicitly discard it.",
        );
      const part = catalog.find((part) => part.id === args.partId);
      if (!part) throw Error("Unknown part: " + args.partId);
      await openPart(part, args.discardUnsaved === true);
      return viewContext();
    },
  );
  app.registerTool(
    "configure_view",
    {
      description:
        "Adjust the current viewer's camera, display, zoom, grid, and units.",
      inputSchema: z.strictObject({
        camera: z.enum(renderer.cameras).optional(),
        mode: z.enum(renderer.modes).optional(),
        zoom: z.number().min(0.3).max(3).optional(),
        grid: z.boolean().optional(),
        units: z.enum(["mm", "in"]).optional(),
        yawRadians: z.number().optional(),
        pitchRadians: z.number().optional(),
      }),
    },
    (args) => {
      if (state.page !== "viewer" || !renderer.triangleCount())
        throw Error("Open a part first.");
      if (args.camera !== undefined) camera(args.camera);
      if (args.yawRadians !== undefined || args.pitchRadians !== undefined) {
        renderer.configure({ yaw: args.yawRadians, pitch: args.pitchRadians });
      }
      if (args.mode !== undefined) {
        state.mode = args.mode;
        $("mode").value = args.mode;
      }
      if (args.zoom !== undefined) renderer.configure({ zoom: args.zoom });
      if (args.grid !== undefined) state.grid = args.grid;
      if (args.units !== undefined) state.units = args.units;
      renderer.configure({
        mode: args.mode,
        grid: args.grid,
        units: args.units,
      });
      draw();
      queueContext();
      return viewContext();
    },
  );
  app.registerTool(
    "rotate_geometry",
    {
      description:
        "Rotate the current part 90 degrees around X as an unsaved edit.",
      inputSchema: z.strictObject({}),
    },
    () => {
      rotateGeometry();
      return viewContext();
    },
  );
  app.registerTool(
    "save_file",
    {
      description:
        "Save edits to the open STL file without overwriting external changes.",
      inputSchema: z.strictObject({}),
    },
    async () => {
      const result = await save();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.outcome !== "saved",
      };
    },
  );
  app.ontoolresult = (payload) => {
    const initial = initialToolResultPending;
    initialToolResultPending = false;
    void toolResult(payload, initial).catch(fail);
  };
  app.ontoolinput = (payload) => {
    if (payload?.arguments?.file)
      void openFile(payload.arguments.file as FileInfo).catch(fail);
  };
  app.onhostcontextchanged = (payload) => {
    try {
      applyHost(payload);
    } catch (error) {
      fail(error);
    }
  };
  function resourceUpdated(payload: { uri: string }) {
    if (!state.file || state.file.resourceUri !== payload.uri) return;
    if (state.dirty)
      status(
        "File changed externally. Your unsaved geometry is preserved; reload explicitly to discard it.",
      );
    else void readFile(state.file, generation).catch(fail);
  }
  app.onteardown = async () => {
    generation++;
    state.connected = false;
    clearTimeout(catalogTimer);
    clearTimeout(contextTimer);
    bodyObserver.disconnect();
    if (resizing !== undefined) cancelAnimationFrame(resizing);
    await unsubscribe().catch(() => {});
    library.dispose();
    renderer.dispose();
    return {};
  };
  const callTool = app.oncalltool!;
  app.oncalltool = async (params, extra) => {
    try {
      return await callTool(params, extra);
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
  };
  $("keep-editing").onclick = () => $("unsaved-dialog").close();
  $("discard-and-leave").onclick = act(() => {
    $("unsaved-dialog").close();
    state.dirty = false;
    showLibrary();
  });
  $("back").onclick = act(() => {
    if (state.dirty) $("unsaved-dialog").showModal();
    else showLibrary();
  });
  $("retry-library").onclick = act(loadCatalog);
  $("search").oninput = renderLibrary;
  function updateCreatePartForm() {
    $("new-part").hidden = !state.connected || openai.message == null;
    $("new-part").disabled = createPartPending;
    $("part-prompt").readOnly = createPartPending;
    $("create-part").disabled =
      createPartPending || !$("part-prompt").value.trim();
    $("cancel-create-part").disabled = createPartPending;
    $("create-part").textContent = createPartPending ? "Creating…" : "Create";
  }
  async function createPart() {
    const prompt = $("part-prompt").value.trim();
    if (!prompt || createPartPending || !state.connected || !openai.message)
      return;
    createPartPending = true;
    updateCreatePartForm();
    $("part-prompt-error").textContent = "";
    try {
      const result = await openai.message.send({
        role: "user",
        content: [
          {
            type: "text",
            text: `Create a new CAD part with Bits & Bolts: ${prompt}`,
          },
        ],
        _meta: { "openai/message": { target: "new", send: true } },
      });
      if (result.isError) throw Error("Could not start a new chat. Try again.");
      $("part-prompt").value = "";
      $("create-part-dialog").close();
    } catch (error) {
      $("part-prompt-error").textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      createPartPending = false;
      updateCreatePartForm();
    }
  }
  $("new-part").onclick = () => {
    $("part-prompt-error").textContent = "";
    $("create-part-dialog").showModal();
  };
  $("cancel-create-part").onclick = () => $("create-part-dialog").close();
  $("create-part-dialog").oncancel = (event: Event) => {
    if (createPartPending) event.preventDefault();
  };
  $("part-prompt").oninput = updateCreatePartForm;
  $("create-part-form").onsubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void createPart();
  };
  $("add-part").onclick = () => $("import").click();
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const menu = $("part-tools");
    if (!menu.contains(event.target) || event.target.closest("button"))
      menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = $("part-tools");
    if (!menu.open) return;
    menu.open = false;
    menu.querySelector("summary")!.focus();
  });
  $("camera").onchange = () => camera($("camera").value);
  $("mode").onchange = () => {
    state.mode = $("mode").value;
    renderer.configure({ mode: state.mode });
    draw();
    queueContext();
  };
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
    renderer.configure({ zoom: 1 });
    renderer.fit();
    draw();
    queueContext();
  });
  $("open-source").onclick = act(async () => {
    if (!state.part || !localFilesystem)
      throw Error("A local catalog part is required.");
    const result = await app.callServerTool({
      name: "cad.partPath",
      arguments: { partId: state.part.id },
    });
    if (result.isError)
      throw Error(
        result.content.find((block) => block.type === "text")?.text ||
          "Source unavailable.",
      );
    const path = result.structuredContent?.path;
    if (typeof path !== "string") throw Error("Source path unavailable.");
    await openai.files!.open(path);
  });
  $("view-library").onclick = act(async () => {
    ensureCanLeave();
    await loadCatalog();
    if (!catalogLoaded) return;
    const response = await app.requestDisplayMode({ mode: "fullscreen" });
    applyHost({ displayMode: response.mode });
    if (response.mode === "fullscreen") showLibrary();
  });
  $("download").onclick = act(async () => {
    if (!state.capabilities.downloadFile)
      throw new Error("This host does not support file downloads.");
    const name = (state.part?.id || "part") + ".stl";
    const response = await app.downloadFile(
      {
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
      },
      { timeout: 300000 },
    );
    status(response.isError ? "Download canceled." : "STL saved.");
  });
  $("import").onchange = act(async (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const format = file.name.split(".").pop()?.toLowerCase() || "";
    if (!renderer.formats.includes(format))
      throw new Error("Choose an STL, 3MF, STEP, or STP file.");
    if (file.size > 16 * 1024 * 1024) throw new Error("File exceeds 16 MiB.");
    ensureCanLeave();
    status(`Opening ${file.name}…`);
    pendingDeepLink = null;
    const token = ++generation;
    await unsubscribe().catch(fail);
    const edits = editSequence;
    const source = {
      format,
      bytes: await file.arrayBuffer(),
    };
    await renderer.load(
      source,
      () => token === generation && edits === editSequence,
      state,
    );
    if (edits !== editSequence)
      throw Error("Import canceled because you edited the current geometry.");
    if (token !== generation) return;
    importedSource = source;
    state.selection = null;
    resetContext();
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
    status("");
    show("viewer");
  });
  $("discard").onclick = act(async () => {
    if (state.file) await readFile(state.file, generation);
    else if (importedSource) {
      const token = ++generation,
        edits = editSequence;
      await renderer.load(
        importedSource,
        () => token === generation && edits === editSequence,
        state,
      );
      if (token !== generation || edits !== editSequence) return;
      state.dirty = false;
      state.selection = null;
      draw();
      queueContext();
    } else if (state.part) await openPart(state.part, true);
    status("Changes discarded.");
  });
  $("add-library").onclick = act(async () => {
    if (importPending) return;
    if (!renderer.triangleCount()) throw Error("Open a model first.");
    if (state.dirty)
      throw Error(
        "Save or discard geometry edits before adding the source to your library. Download STL exports your edited geometry.",
      );
    const fileName = state.part?.fileName || state.file?.name || "imported.stl";
    const sourceAtStart = importedSource;
    const token = generation;
    importPending = true;
    draw();
    status("Adding to library…");
    try {
      let result;
      if (state.file && localFilesystem)
        result = await app.callServerTool({
          name: "cad.addOpenFile",
          arguments: { fileName },
        });
      else {
        let bytes: Uint8Array<ArrayBuffer>;
        if (importedSource?.bytes) {
          bytes = new Uint8Array(importedSource.bytes);
        } else if (state.file) {
          const response = await openai.resources!.read({
            uri: state.file.resourceUri,
            representation: "blob",
          });
          const content = response.contents?.[0];
          if (!content) throw Error("No source file returned.");
          bytes =
            "blob" in content
              ? Uint8Array.from(atob(content.blob), (character) =>
                  character.charCodeAt(0),
                )
              : new TextEncoder().encode(content.text);
        } else {
          status("This part is already in the library.");
          return;
        }
        let args: { fileName: string; blob?: string; uploadPath?: string };
        if (uploadUrl) {
          const url = new URL(uploadUrl);
          url.searchParams.set("fileName", fileName);
          const uploaded = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: bytes,
          });
          if (!uploaded.ok) throw Error(await uploaded.text());
          args = { fileName, uploadPath: (await uploaded.json()).uploadPath };
        } else {
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          args = { fileName, blob: btoa(binary) };
        }
        result = await app.callServerTool({
          name: "cad.importPart",
          arguments: args,
        });
      }
      if (result.isError)
        throw Error(
          result.content.find((block) => block.type === "text")?.text ||
            "Import failed",
        );
      if (
        sourceAtStart &&
        token === generation &&
        importedSource === sourceAtStart &&
        result.structuredContent?.part
      ) {
        state.part = publicCadPartSchema.parse(result.structuredContent.part);
        importedSource = null;
        updateSelection();
        queueContext();
      }
      await toolResult(
        await app.callServerTool({ name: "cad.listParts", arguments: {} }),
      );
      status("Added to library.");
    } finally {
      importPending = false;
      draw();
    }
  });
  camera(state.camera);
  const bodyObserver = new ResizeObserver(() => {
    draw();
    resize();
  });
  bodyObserver.observe(document.body, { box: "border-box" });
  renderLibrary();
  show("library");
  if (parent !== window)
    app
      .connect()
      .then(async () => {
        const host = app.getHostVersion();
        if (
          app.getHostContext()?.platform === "desktop" &&
          (!host?.version ||
            host.version.localeCompare("26.928.20710", undefined, {
              numeric: true,
            }) < 0)
        ) {
          applyHost({ ...app.getHostContext(), "openai/deepLink": undefined });
          document.querySelector("main")!.hidden = true;
          $("update-required").hidden = false;
          await app.sendSizeChanged({
            height: Math.ceil(document.body.getBoundingClientRect().height),
          });
          return;
        }
        state.connected = true;
        renderLibrary();
        state.capabilities = app.getHostCapabilities() || {};
        openai.resources?.addUpdateHandler(({ params }) =>
          resourceUpdated(params),
        );
        updateSelection();
        if (generation === 0)
          pendingDeepLink = openai.deepLink.getCurrent() || null;
        applyHost({ ...app.getHostContext(), "openai/deepLink": undefined });
        queueContext(0);
        resize();
        status("");
        // Start loading the library independently of the selected part.
        catalogTimer = setTimeout(() => {
          catalogTimer = undefined;
          void loadCatalog();
        }, 0);
      })
      .catch(fail);
}

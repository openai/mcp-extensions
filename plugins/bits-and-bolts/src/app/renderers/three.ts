import { Box3, type Group, Mesh, Vector3, WebGLRenderer } from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { createStudioEnvironment } from "../shared/lighting.js";
import { disposeObjectResources } from "../shared/model.js";
import { renderCadPreviews } from "../shared/preview.js";
import { parseModel } from "../viewer/model.js";
import { mountScene, type SceneApi } from "../viewer/scene.js";
import type { DisplayMode, ViewPreset } from "../viewer/inspection.js";
import type { ModelFormat } from "../../shared/contracts.js";
import type { Renderer, RendererOptions, RenderState } from "./types.js";

export function createRenderer({
  container,
  onChange,
  readWasm,
}: RendererOptions): Renderer {
  let model: Group | null = null;
  let api: SceneApi | null = null;
  let renderer: WebGLRenderer | null = null;
  let environment: ReturnType<typeof createStudioEnvironment> | null = null;
  let retired: SceneApi | null = null;
  let disposed = false;
  let preparation: Promise<void> = Promise.resolve();
  let selected = false;
  let lastCamera: Pick<
    RenderState,
    "camera" | "yaw" | "pitch" | "zoom"
  > | null = null;
  const clear = () => {
    if (api) {
      lastCamera = cameraState();
      api.stop();
      retired?.dispose();
      retired = api;
    }
    api = null;
    model = null;
    if (renderer) renderer.domElement.hidden = true;
    selected = false;
  };
  function cameraState() {
    if (!api) return lastCamera;
    const current = api.getCameraState();
    const [x, y, z] = current.position.map(
      (value, index) => value - current.target[index],
    );
    return {
      camera: current.preset,
      yaw: Math.atan2(x, -y),
      pitch: Math.atan2(z, Math.hypot(x, y)),
      zoom: current.zoom ?? 1,
    };
  }
  function configure(next: Partial<RenderState>) {
    if (!api) {
      if (lastCamera) {
        for (const key of ["camera", "yaw", "pitch", "zoom"] as const)
          if (next[key] !== undefined)
            Object.assign(lastCamera, { [key]: next[key] });
      }
      return;
    }
    if (next.camera !== undefined && next.camera !== "custom")
      api.setView(next.camera as ViewPreset);
    if (next.yaw !== undefined || next.pitch !== undefined) {
      const current = cameraState()!;
      api.setOrbit(next.yaw ?? current.yaw, next.pitch ?? current.pitch);
    }
    if (next.mode !== undefined) api.setDisplay(next.mode as DisplayMode);
    if (next.zoom !== undefined) api.setZoom(next.zoom);
    if (next.grid !== undefined) api.setGrid(next.grid);
    if (next.units !== undefined) api.setUnits(next.units);
  }
  return {
    previews: renderCadPreviews,
    formats: ["stl", "3mf", "step", "stp"],
    cameras: ["isometric", "front", "top", "right", "back", "left", "bottom"],
    modes: ["solid", "wireframe", "edges", "transparent"],
    camera: cameraState,
    configure,
    async load(source, isCurrent, settings) {
      if (!source.bytes)
        throw new Error("The CAD resource has no file contents.");
      const next = await parseModel(
        source.format as ModelFormat,
        source.bytes,
        readWasm,
      );
      // Serialize GPU preparation while allowing file download and parsing to overlap.
      const previousPreparation = preparation;
      let finish!: () => void;
      preparation = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await previousPreparation;
      try {
        if (disposed || !isCurrent()) {
          disposeObjectResources(next);
          return;
        }
        if (!renderer) {
          const nextRenderer = new WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,
          });
          try {
            nextRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            nextRenderer.setSize(
              Math.max(container.clientWidth, 1),
              Math.max(container.clientHeight, 1),
            );
            environment = createStudioEnvironment(nextRenderer);
          } catch (error) {
            nextRenderer.dispose();
            nextRenderer.forceContextLoss();
            disposeObjectResources(next);
            throw error;
          }
          renderer = nextRenderer;
          container.append(renderer.domElement);
        }
        const candidate = mountScene(
          container,
          renderer,
          environment!,
          next,
          { defaultView: "isometric", units: "mm", showGrid: true },
          (selection) => {
            selected = selection != null;
            onChange({ selection });
          },
        );
        try {
          await candidate.ready;
        } catch (error) {
          candidate.dispose();
          throw error;
        }
        if (disposed || !isCurrent()) {
          candidate.dispose();
          return;
        }
        const initial = { ...settings };
        clear();
        retired?.dispose();
        retired = null;
        model = next;
        api = candidate;
        configure({
          ...initial,
          yaw: initial.camera === "custom" ? initial.yaw : undefined,
          pitch: initial.camera === "custom" ? initial.pitch : undefined,
        });
        renderer.domElement.hidden = false;
        api.start();
      } finally {
        finish();
      }
      api.subscribe(() => onChange({}));
      onChange({});
    },
    bounds() {
      if (!model) return { size: [0, 0, 0], assumedMillimeters: false };
      return {
        size: new Box3().setFromObject(model).getSize(new Vector3()).toArray(),
        assumedMillimeters: model.userData.lengthUnit !== "mm",
      };
    },
    triangleCount() {
      let count = 0;
      model?.traverse((object) => {
        if (object instanceof Mesh)
          count +=
            (object.geometry.index?.count ??
              object.geometry.attributes.position?.count ??
              0) / 3;
      });
      return count;
    },
    fit() {
      api?.fit();
    },
    rotate() {
      selected = false;
      model?.rotateX(Math.PI / 2);
      model?.updateMatrixWorld(true);
      api?.clearSelection();
      api?.fit();
    },
    exportStl() {
      if (!model) throw new Error("Open a model first.");
      const clone = model.clone();
      clone.updateMatrixWorld(true);
      return new STLExporter().parse(clone, { binary: false });
    },
    context() {
      return api?.getViewerState() ?? null;
    },
    capturePreviews() {
      if (!api) throw new Error("Open a model first.");
      return api.captureViews();
    },
    capture() {
      if (!api) throw new Error("Open a model first.");
      const url = selected ? api.captureSelection() : api.captureView().dataUrl;
      return {
        data: url.split(",")[1],
        mimeType: url.slice(5, url.indexOf(";")),
      };
    },
    clear,
    clearSelection() {
      selected = false;
      api?.clearSelection();
    },
    dispose() {
      disposed = true;
      clear();
      // Shader polling must finish before its renderer and materials are released.
      void preparation.finally(() => {
        retired?.dispose();
        retired = null;
        environment?.dispose();
        renderer?.dispose();
        renderer?.forceContextLoss();
        renderer?.domElement.remove();
      });
    },
  };
}

import {
  Box3,
  BufferGeometry,
  Color,
  EdgesGeometry,
  type Material,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
  WireframeGeometry,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { CadPreferences, PreviewImages } from "../../shared/contracts.js";
import { addStudioLighting } from "../shared/lighting.js";
import { disposeObjectResources } from "../shared/model.js";
import {
  fitCamera,
  getMeshBounds,
  setCameraPreset,
  type DisplayMode,
  type ViewCapture,
  type ViewerState,
  type ViewPreset,
} from "./inspection.js";

export type CadSelection = {
  component: string;
  faceIndex: number | null;
  normal: [number, number, number] | null;
  point: [number, number, number];
};
export type SceneApi = {
  ready: Promise<void>;
  start: () => void;
  stop: () => void;
  captureSelection: () => string;
  captureViews: () => PreviewImages;
  clearSelection: () => void;
  dispose: () => void;
  fit: () => void;
  setView: (preset: ViewPreset) => void;
  setDisplay: (mode: DisplayMode) => void;
  setGrid: (visible: boolean) => void;
  setUnits: (units: "mm" | "in") => void;
  setZoom: (zoom: number) => void;
  setOrbit: (yaw: number, pitch: number) => void;
  getCameraState: () => ViewerState["camera"];
  getViewerState: () => ViewerState;
  captureView: () => ViewCapture;
  subscribe: (listener: () => void) => () => void;
};

const CAD_UP = new Vector3(0, 0, 1);
Object3D.DEFAULT_UP.copy(CAD_UP);

export function mountScene(
  container: HTMLElement,
  renderer: WebGLRenderer,
  environment: WebGLRenderTarget,
  model: Group,
  preferences: CadPreferences,
  onSelect: ((selection: CadSelection | null) => void) | null,
): SceneApi {
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.01, 100000);
  camera.up.copy(CAD_UP);
  camera.position.set(1, -1, 1);

  const controls = new OrbitControls(camera);
  let active = false;
  let preset: ViewPreset | "custom" = preferences.defaultView;
  let display: DisplayMode = "solid";
  let units = preferences.units;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const handleOrbit = () => {
    preset = "custom";
    notify();
  };
  controls.addEventListener("end", handleOrbit);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;

  const modelRoot = new Group();
  modelRoot.add(model);
  scene.add(modelRoot);

  const box = new Box3().setFromObject(modelRoot);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.6 || 1;
  modelRoot.position.set(-center.x, -center.y, -box.min.z);
  const modelCenter = new Vector3(0, 0, size.z / 2);
  controls.target.copy(modelCenter);
  const lighting = addStudioLighting(
    scene,
    renderer,
    box.translate(modelRoot.position),
    2048,
    environment,
  );

  const grid = createCadGrid(radius);
  grid.visible = preferences.showGrid;
  scene.add(grid);

  const wireframes: Array<LineSegments> = [];
  const overlayMaterial = new LineBasicMaterial({
    depthWrite: false,
    opacity: 0.88,
    toneMapped: false,
    transparent: true,
  });
  const outlines: LineSegments[] = [];
  const originalMaterials = new Map<
    Material,
    {
      opacity: number;
      transparent: boolean;
      depthWrite: boolean;
      visible: boolean;
    }
  >();
  const selectableMeshes: Array<Mesh> = [];
  modelRoot.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    object.castShadow = object.receiveShadow = true;
    selectableMeshes.push(object);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      originalMaterials.set(material, {
        opacity: material.opacity,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        visible: material.visible,
      });
    }
  });
  function prepareOverlays(mode: "wireframe" | "edges") {
    const overlays = mode === "wireframe" ? wireframes : outlines;
    if (overlays.length) return;
    const geometry = new Map<BufferGeometry, BufferGeometry>();
    for (const object of selectableMeshes) {
      let prepared = geometry.get(object.geometry);
      if (!prepared) {
        prepared =
          mode === "wireframe"
            ? new WireframeGeometry(object.geometry)
            : new EdgesGeometry(object.geometry, 25);
        geometry.set(object.geometry, prepared);
      }
      const edges = new LineSegments(prepared, overlayMaterial);
      edges.visible = false;
      object.add(edges);
      overlays.push(edges);
    }
  }

  function syncTheme() {
    const backgroundColor = new Color(getThemeBackgroundColor(container));
    scene.background = backgroundColor;
    const luminance =
      0.2126 * backgroundColor.r +
      0.7152 * backgroundColor.g +
      0.0722 * backgroundColor.b;
    overlayMaterial.color.set(luminance > 0.5 ? "#172033" : "#edf4ff");
  }
  syncTheme();

  // Interaction markers use world units and never belong to exported geometry.
  const annotations = new Group();
  scene.add(annotations);
  const raycaster = new Raycaster();
  let pointerStart: { x: number; y: number } | null = null;
  let selectionMarker: Mesh<SphereGeometry, MeshBasicMaterial> | null = null;
  const hoverMarker = new Mesh(
    new SphereGeometry(Math.max(radius * 0.018, 0.002), 16, 16),
    new MeshBasicMaterial({
      color: "#a3a3a3",
      depthTest: false,
      opacity: 0.85,
      toneMapped: false,
      transparent: true,
    }),
  );
  hoverMarker.renderOrder = 1;

  function clearSelection() {
    clearHover();
    if (selectionMarker == null) {
      return;
    }
    selectionMarker.removeFromParent();
    selectionMarker.geometry.dispose();
    selectionMarker.material.dispose();
    selectionMarker = null;
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button === 0) {
      clearHover();
      pointerStart = { x: event.clientX, y: event.clientY };
    }
  }

  function getIntersection(event: PointerEvent) {
    const bounds = renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(selectableMeshes, false)[0] ?? null;
  }

  function clearHover() {
    hoverMarker.removeFromParent();
    renderer.domElement.style.cursor = "";
  }

  function handlePointerMove(event: PointerEvent) {
    if (pointerStart != null) {
      return;
    }
    const intersection = getIntersection(event);
    if (intersection == null || !(intersection.object instanceof Mesh)) {
      clearHover();
      return;
    }
    hoverMarker.position.copy(intersection.point);
    annotations.add(hoverMarker);
    renderer.domElement.style.cursor = "pointer";
  }

  function handlePointerUp(event: PointerEvent) {
    if (
      pointerStart == null ||
      Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      ) > 5
    ) {
      pointerStart = null;
      return;
    }
    pointerStart = null;
    const intersection = getIntersection(event);
    clearSelection();
    if (intersection == null || !(intersection.object instanceof Mesh)) {
      onSelect?.(null);
      return;
    }

    selectionMarker = new Mesh(
      new SphereGeometry(Math.max(radius * 0.025, 0.002), 20, 20),
      new MeshBasicMaterial({
        color: "#737373",
        depthTest: false,
        toneMapped: false,
      }),
    );
    selectionMarker.position.copy(intersection.point);
    selectionMarker.renderOrder = 2;
    annotations.add(selectionMarker);

    const point = model.worldToLocal(intersection.point.clone());
    const normal = intersection.face?.normal
      .clone()
      .transformDirection(intersection.object.matrixWorld)
      .transformDirection(model.matrixWorld.clone().invert());
    onSelect?.({
      component: intersection.object.name || "Model surface",
      faceIndex: intersection.faceIndex ?? null,
      normal: normal == null ? null : roundedVector(normal),
      point: roundedVector(point),
    });
  }

  function activate() {
    if (active) return;
    active = true;
    controls.connect(renderer.domElement);
    window.addEventListener("cad-theme-change", syncTheme);
    syncTheme();
    observer.observe(container);
    resize();
    if (onSelect != null) {
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerleave", clearHover);
      renderer.domElement.addEventListener("pointermove", handlePointerMove);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
    }
  }
  function deactivate() {
    if (!active) return;
    active = false;
    controls.disconnect();
    window.removeEventListener("cad-theme-change", syncTheme);
    observer.disconnect();
    renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
    renderer.domElement.removeEventListener("pointerleave", clearHover);
    renderer.domElement.removeEventListener("pointermove", handlePointerMove);
    renderer.domElement.removeEventListener("pointerup", handlePointerUp);
    clearHover();
  }

  function updateProjection() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function getCameraState(): ViewerState["camera"] {
    return {
      preset,
      zoom: camera.zoom,
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      up: camera.up.toArray(),
    };
  }

  function getViewerState(): ViewerState {
    const size = getMeshBounds(selectableMeshes).getSize(new Vector3());
    if (units === "in") size.divideScalar(25.4);
    return {
      camera: getCameraState(),
      display,
      grid: grid.visible,
      dimensions: {
        x: size.x,
        y: size.y,
        z: size.z,
        units,
        assumedMillimeters: model.userData.lengthUnit !== "mm",
      },
    };
  }

  function settleControls() {
    // Drop pending drag momentum before an absolute camera command.
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
  }

  function fit() {
    settleControls();
    const bounds = getMeshBounds(selectableMeshes);
    fitCamera(camera, controls.target, bounds);
    lighting.updateBounds(bounds);
    controls.update();
    notify();
  }

  function setView(next: ViewPreset) {
    settleControls();
    setCameraPreset(camera, controls.target, next);
    preset = next;
    fit();
  }

  function setDisplay(next: DisplayMode) {
    if (next === "wireframe") prepareOverlays("wireframe");
    else if (next === "edges" || next === "transparent")
      prepareOverlays("edges");
    display = next;
    for (const [material, original] of originalMaterials) {
      material.visible = next === "wireframe" ? false : original.visible;
      material.opacity =
        next === "transparent" ? original.opacity * 0.25 : original.opacity;
      material.transparent = next === "transparent" || original.transparent;
      material.depthWrite =
        next === "transparent" ? false : original.depthWrite;
      material.needsUpdate = true;
    }
    for (const edge of wireframes) edge.visible = next === "wireframe";
    for (const edge of outlines)
      edge.visible = next === "edges" || next === "transparent";
    for (const mesh of selectableMeshes)
      mesh.castShadow = mesh.receiveShadow =
        next === "solid" || next === "edges";
    renderer.shadowMap.needsUpdate = true;
    notify();
  }

  function resize() {
    updateProjection();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width > 0 && height > 0) {
      renderer.setSize(width, height);
    }
  }

  const observer = new ResizeObserver(resize);
  updateProjection();
  setView(preferences.defaultView);

  let frame = 0;
  function animate() {
    frame = requestAnimationFrame(animate);
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    const cameraChanged = controls.update();
    renderer.render(scene, camera);
    if (cameraChanged) notify();
  }
  // Keep the previous scene alive until this finishes so shared shader programs survive.
  const ready = renderer.compileAsync(scene, camera).then(() => {});

  return {
    ready,
    start() {
      activate();
      if (!frame) frame = requestAnimationFrame(animate);
    },
    stop() {
      deactivate();
      cancelAnimationFrame(frame);
      frame = 0;
    },
    captureSelection() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/jpeg", 0.82);
    },
    captureViews() {
      const originalBackground = scene.background;
      const originalOverlayColor = overlayMaterial.color.clone();
      const originalCamera = camera.clone();
      const originalTarget = controls.target.clone();
      const originalPreset = preset;
      const originalDisplay = display;
      try {
        scene.background = new Color(0xffffff);
        overlayMaterial.color.set("#172033");
        setView("isometric");
        setDisplay("solid");
        renderer.render(scene, camera);
        return { isometric: renderer.domElement.toDataURL("image/jpeg", 0.84) };
      } finally {
        scene.background = originalBackground;
        overlayMaterial.color.copy(originalOverlayColor);
        camera.copy(originalCamera);
        controls.target.copy(originalTarget);
        preset = originalPreset;
        camera.lookAt(controls.target);
        controls.update();
        setDisplay(originalDisplay);
        renderer.render(scene, camera);
      }
    },
    setView,
    setDisplay,
    getCameraState,
    getViewerState,
    setGrid(visible) {
      grid.visible = visible;
      notify();
    },
    setUnits(next) {
      units = next;
      notify();
    },
    setOrbit(yaw, pitch) {
      settleControls();
      const distance = camera.position.distanceTo(controls.target);
      const angle = Math.max(
        -Math.PI / 2 + 0.000001,
        Math.min(Math.PI / 2 - 0.000001, pitch),
      );
      camera.position
        .copy(controls.target)
        .add(
          new Vector3(
            Math.sin(yaw) * Math.cos(angle),
            -Math.cos(yaw) * Math.cos(angle),
            Math.sin(angle),
          ).multiplyScalar(distance),
        );
      camera.up.set(0, 0, 1);
      camera.lookAt(controls.target);
      controls.update();
      preset = "custom";
      notify();
    },
    setZoom(zoom) {
      settleControls();
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    captureView() {
      renderer.render(scene, camera);
      return {
        dataUrl: renderer.domElement.toDataURL("image/png"),
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        state: getViewerState(),
      };
    },
    clearSelection,
    dispose() {
      deactivate();
      cancelAnimationFrame(frame);
      hoverMarker.removeFromParent();
      hoverMarker.geometry.dispose();
      hoverMarker.material.dispose();
      clearSelection();
      controls.removeEventListener("end", handleOrbit);
      listeners.clear();
      // deactivate() has already disconnected all controls; inactive candidates never connect.
      lighting.dispose();
      disposeObjectResources(scene);
    },
    fit,
  };
}

function roundedVector(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) =>
    Number(value.toFixed(4)),
  ) as [number, number, number];
}

function createCadGrid(radius: number): Group {
  const grid = new Group();
  const span = Math.max(radius * 2.5, 5);
  const divisions = 20;
  const step = (span * 2) / divisions;
  const positions: Array<number> = [];
  for (let index = 0; index <= divisions; index += 1) {
    const position = -span + index * step;
    if (Math.abs(position) < step / 4) {
      continue;
    }
    positions.push(-span, position, 0, span, position, 0);
    positions.push(position, -span, 0, position, span, 0);
  }
  grid.add(createLineSegments(positions, "#8b96a5", 0.22));
  grid.add(createLineSegments([-span, 0, 0, span, 0, 0], "#e25d5d", 0.95));
  grid.add(createLineSegments([0, -span, 0, 0, span, 0], "#55b97a", 0.95));
  grid.position.z = -Math.max(radius * 0.0001, 0.000001);
  return grid;
}

function createLineSegments(
  positions: Array<number>,
  color: string,
  opacity: number,
): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return new LineSegments(
    geometry,
    new LineBasicMaterial({
      color,
      opacity,
      toneMapped: false,
      transparent: opacity < 1,
    }),
  );
}

function getThemeBackgroundColor(container: HTMLElement): string {
  const computedColor = getComputedStyle(container).backgroundColor;
  return computedColor === "" || computedColor === "rgba(0, 0, 0, 0)"
    ? "#171717"
    : computedColor;
}

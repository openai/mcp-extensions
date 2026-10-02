import {
  Box3,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  Sphere,
  Vector3,
} from "three";

export type ViewPreset =
  "isometric" | "front" | "back" | "left" | "right" | "top" | "bottom";
export type DisplayMode = "solid" | "edges" | "wireframe" | "transparent";
export type ViewerState = {
  camera: {
    preset: ViewPreset | "custom";
    zoom?: number;
    position: number[];
    target: number[];
    up: number[];
  };
  display: DisplayMode;
  grid: boolean;
  dimensions: {
    x: number;
    y: number;
    z: number;
    units: "mm" | "in";
    assumedMillimeters: boolean;
  };
};
export type ViewCapture = {
  dataUrl: string;
  width: number;
  height: number;
  state: ViewerState;
};

const directions: Record<ViewPreset, [number, number, number]> = {
  isometric: [1, -1, 1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -0.000001, 1],
  bottom: [0, 0.000001, -1],
};

export function setCameraPreset(
  camera: PerspectiveCamera,
  target: Vector3,
  preset: ViewPreset,
) {
  const distance = camera.position.distanceTo(target) || 1;
  camera.position
    .copy(target)
    .add(
      new Vector3(...directions[preset]).normalize().multiplyScalar(distance),
    );
  // OrbitControls keeps a fixed Z-up frame; avoid its singularity at the poles.
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
}

export function fitCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  bounds: Box3,
) {
  const direction = camera.position.clone().sub(target).normalize();
  const radius = Math.max(bounds.getBoundingSphere(new Sphere()).radius, 0.001);
  const vertical = MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.12;
  bounds.getCenter(target);
  camera.position.copy(target).add(direction.multiplyScalar(distance));
  camera.near = radius / 1000;
  camera.far = distance + radius * 100;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** Exclude viewer annotations and wireframe overlays from measurements. */
export function getMeshBounds(meshes: Mesh[]): Box3 {
  const bounds = new Box3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    if (mesh.geometry.boundingBox == null) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox != null)
      bounds.union(
        mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld),
      );
  }
  return bounds;
}

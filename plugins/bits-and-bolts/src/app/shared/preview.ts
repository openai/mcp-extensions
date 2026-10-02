import {
  Box3,
  Color,
  Mesh,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

import type { ModelFormat, PreviewImages } from "../../shared/contracts.js";
import { addStudioLighting } from "./lighting.js";
import { disposeObjectResources, parseMeshModel } from "./model.js";

export async function renderCadPreviews(
  format: ModelFormat,
  bytes: ArrayBuffer,
): Promise<PreviewImages> {
  if (format === "step" || format === "stp") {
    throw new Error(
      "Open STEP and STP files in the CAD viewer to generate rendered previews.",
    );
  }

  const model = await parseMeshModel(format, bytes);
  model.traverse((object) => {
    if (object instanceof Mesh) object.castShadow = object.receiveShadow = true;
  });
  let renderer: WebGLRenderer | null = null;
  let lighting: ReturnType<typeof addStudioLighting> | null = null;
  try {
    renderer = new WebGLRenderer({
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(420, 260, false);
    const scene = new Scene();
    scene.background = new Color(0xffffff);
    scene.add(model);

    const box = new Box3().setFromObject(model);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1) * 0.72;
    model.position.sub(center);
    lighting = addStudioLighting(
      scene,
      renderer,
      box.translate(center.clone().negate()),
      1024,
    );
    const camera = new OrthographicCamera(
      -radius * 1.7,
      radius * 1.7,
      radius * 1.05,
      -radius * 1.05,
      0.01,
      100000,
    );
    camera.position.copy(
      new Vector3(1, -1, 0.85).normalize().multiplyScalar(radius * 4),
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    return { isometric: renderer.domElement.toDataURL("image/jpeg", 0.82) };
  } finally {
    disposeObjectResources(model);
    lighting?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}

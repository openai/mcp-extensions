import {
  AgXToneMapping,
  type Box3,
  DirectionalLight,
  PCFShadowMap,
  PMREMGenerator,
  type Scene,
  Sphere,
  SRGBColorSpace,
  type WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export function createStudioEnvironment(renderer: WebGLRenderer) {
  const room = new RoomEnvironment();
  const generator = new PMREMGenerator(renderer);
  const environment = generator.fromScene(room, 0.04, 0.1, 100, { size: 128 });
  room.dispose();
  generator.dispose();
  return environment;
}

/** Share a fixed studio light rig between the viewer and library previews. */
export function addStudioLighting(
  scene: Scene,
  renderer: WebGLRenderer,
  bounds: Box3,
  shadowMapSize: number,
  sharedEnvironment?: ReturnType<typeof createStudioEnvironment>,
) {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = AgXToneMapping;
  renderer.toneMappingExposure = 1;

  const environment = sharedEnvironment ?? createStudioEnvironment(renderer);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.16;
  // RoomEnvironment is Y-up; CAD models and the light rig are Z-up.
  scene.environmentRotation.set(Math.PI / 2, 0, 0);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  const key = new DirectionalLight("#ffffff", 3);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  const rim = new DirectionalLight("#edf2ff", 0.4);
  scene.add(key, key.target, rim, rim.target);
  updateBounds(bounds);

  return {
    updateBounds,
    dispose() {
      scene.environment = null;
      if (!sharedEnvironment) environment.dispose();
      key.shadow.dispose();
      key.removeFromParent();
      key.target.removeFromParent();
      rim.removeFromParent();
      rim.target.removeFromParent();
    },
  };

  function updateBounds(bounds: Box3) {
    const sphere = bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 0.000001);
    key.target.position.copy(sphere.center);
    key.position
      .set(-3, -4, 4.5)
      .normalize()
      .multiplyScalar(radius * 4)
      .add(sphere.center);
    rim.target.position.copy(sphere.center);
    rim.position
      .set(4, 2, 3)
      .normalize()
      .multiplyScalar(radius * 4)
      .add(sphere.center);
    const camera = key.shadow.camera;
    camera.up.set(0, 0, 1);
    camera.left = camera.bottom = -radius * 1.08;
    camera.right = camera.top = radius * 1.08;
    camera.near = radius * 0.01;
    camera.far = radius * 8;
    camera.updateProjectionMatrix();
    // Cover the PCF footprint without using a fixed offset in arbitrary CAD units.
    const shadowTexel = (camera.right - camera.left) / shadowMapSize;
    key.shadow.normalBias = shadowTexel * 1.5;
    key.shadow.bias = (-shadowTexel * 0.5) / (camera.far - camera.near);
    // The light is fixed during orbiting; render its depth map only on changes.
    renderer.shadowMap.needsUpdate = true;
  }
}

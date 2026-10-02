import {
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  ImageBitmapLoader,
  Line,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Points,
  Texture,
} from "three";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { z } from "zod/v4";

import type { ModelFormat } from "../../shared/contracts.js";
import { parseStl } from "./stl.js";

const gltfTextureSchema = z.object({ source: z.number().int().nonnegative() });
const gltfImageSchema = z.object({
  bufferView: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});

export async function parseMeshModel(
  format: Exclude<ModelFormat, "step" | "stp">,
  bytes: ArrayBuffer,
): Promise<Group> {
  if (format === "3mf") return new ThreeMFLoader().parse(bytes);

  const model = new Group();
  if (format === "stl") {
    model.add(new Mesh(parseStl(bytes), createCadMaterial()));
    return model;
  }

  const loader = new GLTFLoader();
  loader.register((parser) => ({
    name: "bits-and-bolts-embedded-images",
    loadTexture(textureIndex) {
      const texture = gltfTextureSchema.parse(
        parser.json.textures[textureIndex],
      );
      const source = gltfImageSchema.parse(parser.json.images[texture.source]);
      const bufferView = source.bufferView;
      if (bufferView == null) return null;

      // The sandbox blocks blob URL requests. Decode the embedded bytes directly,
      // retaining GLTFLoader's source cache, samplers, and texture transforms.
      // https://github.com/mrdoob/three.js/blob/r185/examples/jsm/loaders/GLTFLoader.js
      const images = new ImageBitmapLoader(parser.options.manager);
      images.load = (_url, onLoad, _onProgress, onError) => {
        void parser
          .getDependency("bufferView", bufferView)
          .then((data: ArrayBuffer) =>
            createImageBitmap(new Blob([data], { type: source.mimeType }), {
              premultiplyAlpha: "none",
              colorSpaceConversion: "none",
            }),
          )
          .then(onLoad, onError);
      };
      return parser.loadTextureImage(textureIndex, texture.source, images);
    },
  }));
  const gltf = await loader.parseAsync(bytes, "");
  // Keep the conversion below the model root so selection coordinates are mm.
  gltf.scene.rotation.x = Math.PI / 2;
  gltf.scene.scale.setScalar(1000);
  for (const light of gltf.scene.getObjectsByProperty("isLight", true)) {
    light.removeFromParent();
  }
  const materials = new Set<Material>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
    }
  });
  for (const material of materials) {
    if (material instanceof MeshPhysicalMaterial) {
      // Thickness follows model scale; attenuation distance is in world units.
      // https://github.com/mrdoob/three.js/blob/r185/src/renderers/shaders/ShaderChunk/transmission_pars_fragment.glsl.js
      material.attenuationDistance *= 1000;
    }
  }
  model.add(gltf.scene);
  model.userData.lengthUnit = "mm";
  model.userData.sourceLengthUnit = "m";
  return model;
}

export function createCadMaterial(
  color = new Color("#a3a3a3"),
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: 0.12,
    roughness: 0.48,
    side: DoubleSide,
  });
}

/** Release an owned model or scene, including shared glTF texture resources. */
export function disposeObjectResources(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const bitmaps = new Set<ImageBitmap>();
  root.traverse((object) => {
    if (!(
      object instanceof Mesh ||
      object instanceof Line ||
      object instanceof Points
    ))
      return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material])
      materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof Texture) textures.add(value);
    }
  }
  for (const texture of textures) {
    const image = texture.source.data;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
      bitmaps.add(image);
    }
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

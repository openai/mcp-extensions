import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  Uint32BufferAttribute,
} from "three";

import type { ModelFormat } from "../../shared/contracts.js";
import { createCadMaterial, parseMeshModel } from "../shared/model.js";
import StepWorker from "./step-worker.js?worker&inline";

type StepWorkerMesh = {
  color?: Array<number>;
  index?: Uint32Array;
  name?: string;
  normal?: Float32Array;
  position: Float32Array;
};
type StepWorkerResponse =
  | {
      success: true;
      meshes: Array<StepWorkerMesh>;
      sourceLengthUnit: string | null;
    }
  | { success: false; error: string };
export async function parseModel(
  format: ModelFormat,
  buffer: ArrayBuffer,
  readWasm: () => Promise<Uint8Array>,
): Promise<Group> {
  if (format === "step" || format === "stp") {
    return parseStep(buffer, readWasm);
  }
  return parseMeshModel(format, buffer);
}

async function parseStep(
  buffer: ArrayBuffer,
  readWasm: () => Promise<Uint8Array>,
): Promise<Group> {
  const result = await importStepInWorker(buffer, readWasm);
  if (!result.success || result.meshes.length === 0) {
    throw new Error("OpenCascade could not tessellate this STEP file.");
  }

  const group = new Group();
  for (const sourceMesh of result.meshes) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute(sourceMesh.position, 3),
    );
    if (sourceMesh.normal != null) {
      geometry.setAttribute(
        "normal",
        new Float32BufferAttribute(sourceMesh.normal, 3),
      );
    } else {
      geometry.computeVertexNormals();
    }
    if (sourceMesh.index != null) {
      geometry.setIndex(new Uint32BufferAttribute(sourceMesh.index, 1));
    }
    const color = sourceMesh.color;
    const material = createCadMaterial(
      color != null && color.length >= 3
        ? new Color(Number(color[0]), Number(color[1]), Number(color[2]))
        : undefined,
    );
    const mesh = new Mesh(geometry, material);
    mesh.name = sourceMesh.name ?? "";
    group.add(mesh);
  }
  group.userData.lengthUnit = "mm";
  group.userData.sourceLengthUnit = result.sourceLengthUnit;
  return group;
}

async function importStepInWorker(
  buffer: ArrayBuffer,
  readWasm: () => Promise<Uint8Array>,
): Promise<StepWorkerResponse> {
  // Parsing borrows the source; imports and discard still need its original bytes.
  const workerBuffer = buffer.slice(0);
  const wasmBinary = await readWasm();
  const wasmBuffer = wasmBinary.slice().buffer as ArrayBuffer;
  return new Promise((resolve, reject) => {
    const worker = new StepWorker();
    worker.addEventListener(
      "message",
      (event: MessageEvent<StepWorkerResponse>) => {
        worker.terminate();
        resolve(event.data);
      },
      { once: true },
    );
    worker.addEventListener(
      "error",
      (event) => {
        worker.terminate();
        reject(new Error(event.message || "The STEP importer worker failed."));
      },
      { once: true },
    );
    worker.postMessage({ buffer: workerBuffer, wasmBinary: wasmBuffer }, [
      workerBuffer,
      wasmBuffer,
    ]);
  });
}

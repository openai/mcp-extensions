import type { CadSelection } from "../viewer/scene.js";
import type { ModelFormat, PreviewImages } from "../../shared/contracts.js";

export type ModelSource = {
  format: string;
  bytes: ArrayBuffer;
};
export type RenderState = {
  camera: string;
  mode: string;
  yaw: number;
  pitch: number;
  zoom: number;
  units: "mm" | "in";
  grid: boolean;
  host: { theme?: string };
  selection?: CadSelection | null;
};
export type RendererOptions = {
  container: HTMLElement;
  onChange: (change: Partial<RenderState>) => void;
  readWasm: () => Promise<Uint8Array>;
};
export type Renderer = {
  previews(format: ModelFormat, bytes: ArrayBuffer): Promise<PreviewImages>;
  formats: string[];
  cameras: string[];
  modes: string[];
  load(
    source: ModelSource,
    isCurrent: () => boolean,
    settings: RenderState,
  ): Promise<void>;
  camera(): Pick<RenderState, "camera" | "yaw" | "pitch" | "zoom"> | null;
  configure(state: Partial<RenderState>): void;
  bounds(): { size: number[]; assumedMillimeters: boolean };
  triangleCount(): number;
  fit(): void;
  rotate(): void;
  exportStl(): string;
  context?(): unknown;
  capture(): { data: string; mimeType: string };
  capturePreviews(): PreviewImages;
  clear(): void;
  clearSelection(): void;
  dispose(): void;
};

import { randomUUID } from "node:crypto";
import {
  cadFormatSchema,
  cadPreferencesUpdateSchema,
  defaultCadPreferences,
  publicCadPartSchema,
  previewImagesSchema,
  type CadPreferences,
  type PublicCadPart,
} from "../../shared/contracts.js";
import type { DemoAccount } from "./auth.js";

export type Seed = {
  id: string;
  name: string;
  fileName: string;
  assetPath: string;
  tags: string[];
  sizeBytes: number;
};
export const uploadLimit = 50 * 1024 * 1024;
const memoryLimit = 256 * 1024 * 1024;
const uploadLifetime = 15 * 60 * 1000;

/** One process owns all mutable demo state; request handlers only select a view. */
export function createMemoryLibrary(seeds: Seed[]) {
  const libraries = new Map<string, Map<string, PublicCadPart>>();
  const preferences = new Map<string, CadPreferences>();
  const uploads = new Map<
    string,
    { bytes: Buffer; fileName: string; expiresAt: number }
  >();
  const files = new Map<string, Buffer>();
  let retainedBytes = 0;
  const expireUploads = () => {
    const now = Date.now();
    for (const [id, upload] of uploads) {
      if (upload.expiresAt <= now) {
        retainedBytes -= upload.bytes.length;
        uploads.delete(id);
      }
    }
  };
  const reserve = (difference: number) => {
    expireUploads();
    if (retainedBytes + difference > memoryLimit)
      throw Error("Demo storage is full. Restart the server to clear it.");
    retainedBytes += difference;
  };
  const partsFor = (account: DemoAccount) => {
    let parts = libraries.get(account.id);
    if (!parts) {
      parts = new Map(
        seeds.map((seed) => [
          seed.id,
          publicCadPartSchema.parse({
            ...seed,
            format: "stl",
            previews: {},
            resourceUri: `cad://bits-and-bolts/${seed.id}`,
            description: `${seed.name}. Reference geometry, not fit-verified for manufacturing.`,
            sourceLabel: "Bundled reference model",
            updatedAt: "2026-09-14T00:00:00Z",
          }),
        ]),
      );
      libraries.set(account.id, parts);
    }
    return parts;
  };
  return {
    upload(fileName: string, bytes: Buffer) {
      cadFormatSchema.parse(fileName.split(".").pop()?.toLowerCase());
      if (bytes.length > uploadLimit) throw Error("CAD file exceeds 50 MB.");
      reserve(bytes.length);
      const uploadPath = randomUUID();
      uploads.set(uploadPath, {
        bytes,
        fileName,
        expiresAt: Date.now() + uploadLifetime,
      });
      return uploadPath;
    },
    file(account: DemoAccount, id: string) {
      return files.get(`${account.id}/${id}`);
    },
    preview(account: DemoAccount, id: string, view: string) {
      const data =
        partsFor(account).get(id)?.previews[
          view as keyof PublicCadPart["previews"]
        ];
      const match = data?.match(
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/,
      );
      return match
        ? { bytes: Buffer.from(match[2], "base64"), mimeType: match[1] }
        : null;
    },
    connect(origin: string, account: DemoAccount, token: string) {
      const parts = partsFor(account);
      const defaults = {
        ...defaultCadPreferences,
        units: account.units,
        showGrid: account.showGrid,
      };
      const publicPart = (part: PublicCadPart): PublicCadPart => {
        const seed = seeds.find((seed) => seed.id === part.id);
        return {
          ...part,
          previews: Object.fromEntries(
            Object.keys(part.previews).map((view) => [
              view,
              `${origin}/bits-and-bolts/previews/${part.id}/${view}?account=${account.id}`,
            ]),
          ),
          ...(seed
            ? {
                displaySource: {
                  format: "glb",
                  url: `${origin}/models/${seed.assetPath.replace(/\.stl$/i, ".glb")}`,
                },
              }
            : {}),
        };
      };
      const find = (id: string) => {
        const part = parts.get(id);
        if (!part) throw Error("Unknown part.");
        return part;
      };
      return {
        list: async () => [...parts.values()].map(publicPart),
        get: async (id: string) =>
          parts.has(id) ? publicPart(find(id)) : null,
        async read(id: string, representation: "source" | "display") {
          const part = publicPart(find(id));
          const seed = seeds.find((seed) => seed.id === id);
          return {
            part,
            format:
              seed && representation === "display"
                ? ("glb" as const)
                : part.format,
            url: seed
              ? `${origin}/models/${representation === "display" ? seed.assetPath.replace(/\.stl$/i, ".glb") : seed.assetPath}`
              : `${origin}/bits-and-bolts/files/${id}?account=${account.id}`,
          };
        },
        async import(input: {
          uploadPath?: string;
          fileName: string;
          name?: string;
          description?: string;
          tags?: string[];
        }) {
          expireUploads();
          const upload = uploads.get(input.uploadPath ?? "");
          if (!upload || input.fileName !== upload.fileName)
            throw Error("Upload the CAD file before importing it.");
          const id = `imported-${randomUUID()}`;
          const part = publicCadPartSchema.parse({
            ...input,
            id,
            format: cadFormatSchema.parse(
              input.fileName.split(".").pop()?.toLowerCase(),
            ),
            name: input.name || input.fileName,
            tags: input.tags || [],
            previews: {},
            description:
              input.description ||
              `Imported into the ${account.name} demo library.`,
            resourceUri: `cad://bits-and-bolts/${id}`,
            sizeBytes: upload.bytes.length,
            sourceLabel: `${account.name} demo`,
            updatedAt: new Date().toISOString(),
          });
          parts.set(id, part);
          files.set(`${account.id}/${id}`, upload.bytes);
          uploads.delete(input.uploadPath!);
          return publicPart(part);
        },
        async savePreviews(id: string, input: PublicCadPart["previews"]) {
          const part = find(id),
            previews = previewImagesSchema.parse(input);
          for (const value of Object.values(previews)) {
            if (
              value &&
              !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
                value,
              )
            )
              throw Error("Invalid preview image.");
          }
          reserve(
            Buffer.byteLength(JSON.stringify(previews)) -
              Buffer.byteLength(JSON.stringify(part.previews)),
          );
          const updated = { ...part, previews };
          parts.set(id, updated);
          return publicPart(updated);
        },
        readSettings: async () => ({ ...(preferences.get(token) ?? defaults) }),
        async updateSettings(set: Partial<CadPreferences>) {
          const value = {
            ...(preferences.get(token) ?? defaults),
            ...cadPreferencesUpdateSchema.parse(set),
          };
          preferences.set(token, value);
          return { ...value };
        },
        settingsLifetime:
          "Settings are separate for this connection. Settings, imports, and previews reset when the server restarts.",
      };
    },
  };
}

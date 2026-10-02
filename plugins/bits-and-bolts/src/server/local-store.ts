import path from "node:path";
import {
  getPart,
  importPart,
  importPartFromPath,
  initializeCatalog,
  listParts,
  readPartBytes,
  savePartPreviews,
  getCadPreferences,
  setCadPreferences,
  type CadPart,
} from "./catalog.js";
import type { CatalogStore } from "./store.js";
const publicPart = ({ storagePath, ...part }: CadPart) => part;
export async function createLocalStore(): Promise<CatalogStore> {
  await initializeCatalog();
  return {
    list: async () => (await listParts()).map(publicPart),
    get: async (id) => {
      const part = await getPart(id);
      return part ? publicPart(part) : null;
    },
    read: async (id, representation) => {
      const value = await readPartBytes(id, representation);
      return {
        part: publicPart(value.part),
        format: value.format,
        blob: value.bytes.toString("base64"),
      };
    },
    import: async ({ blob, ...input }) =>
      publicPart(
        await importPart({ ...input, bytes: Buffer.from(blob, "base64") }),
      ),
    savePreviews: async (id, previews) =>
      publicPart(await savePartPreviews(id, previews)),
    readSettings: getCadPreferences,
    updateSettings: setCadPreferences,
    settingsLifetime: "Saved in this local CAD library.",
    localPath: async (id) => {
      const part = await getPart(id);
      if (!part) throw Error("Unknown part: " + id);
      return path.resolve(part.storagePath);
    },
    importPath: async (path, name) =>
      publicPart(await importPartFromPath(path, name)),
  };
}

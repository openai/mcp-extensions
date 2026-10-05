import { partsResultSchema, type PublicCadPart } from "../shared/contracts.js";

const key = "bits-and-bolts:library:v1";

export function readLibraryCache(): PublicCadPart[] | null {
  try {
    const snapshot = localStorage.getItem(key);
    if (!snapshot) return null;
    const result = partsResultSchema.safeParse(JSON.parse(snapshot));
    return result.success ? result.data.parts : null;
  } catch {
    return null;
  }
}

export function writeLibraryCache(parts: PublicCadPart[]) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        parts: parts.map((part) => ({
          ...part,
          previews: { isometric: part.previews.isometric },
        })),
      }),
    );
  } catch {}
}

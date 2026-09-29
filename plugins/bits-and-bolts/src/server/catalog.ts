import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import seedParts from "../../assets/models/catalog.json" with { type: "json" };
import previousHashes from "../../assets/models/previous-hashes.json" with { type: "json" };
import {
  cadFormatSchema,
  cadPreferencesSchema,
  cadPreferencesUpdateSchema,
  defaultCadPreferences,
  publicCadPartSchema,
  type CadFormat,
  type CadPreferences,
  type ModelFormat,
  type PreviewImages,
} from "../shared/contracts.js";

export type PreviewName = keyof PreviewImages;

const persistedCadPartSchema = publicCadPartSchema.extend({
  storagePath: z.string(),
});
const manifestSchema = z.object({
  bundledModelVersion: z.number().int().nonnegative().default(0),
  parts: z.array(persistedCadPartSchema),
  version: z.literal(1),
});

export type CadPart = z.infer<typeof persistedCadPartSchema>;
type CadManifest = z.infer<typeof manifestSchema>;
const bundledModelVersion = 6;
const maxImportBytes = 32 * 1024 * 1024;
/** Only known, untouched bundled models can be replaced. */
const legacyModelHashes = new Map(Object.entries(previousHashes));

const libraryRoot =
  process.env.CAD_LIBRARY_HOME ??
  path.join(os.homedir(), ".codex", "bits-and-bolts");
const modelRoot = path.join(libraryRoot, "models");
const manifestPath = path.join(libraryRoot, "catalog.json");
const preferencesPath = path.join(libraryRoot, "preferences.json");
let writeQueue: Promise<void> = Promise.resolve();
let preferencesWriteQueue: Promise<void> = Promise.resolve();

export async function getCadPreferences(): Promise<CadPreferences> {
  try {
    return cadPreferencesSchema.parse(
      JSON.parse(await readFile(preferencesPath, "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return defaultCadPreferences;
    }
    throw error;
  }
}

export async function setCadPreferences(
  set: Partial<CadPreferences>,
): Promise<CadPreferences> {
  const update = cadPreferencesUpdateSchema.parse(set);
  const next = preferencesWriteQueue.then(async () => {
    const preferences = { ...(await getCadPreferences()), ...update };
    const temporaryPath = `${preferencesPath}.next`;
    await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`);
    await rename(temporaryPath, preferencesPath);
    return preferences;
  });
  preferencesWriteQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

export async function initializeCatalog(): Promise<Array<CadPart>> {
  await mkdir(modelRoot, { recursive: true });
  let manifest: CadManifest;
  try {
    manifest = await readManifest();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    manifest = { bundledModelVersion: 0, parts: [], version: 1 };
  }
  if (manifest.bundledModelVersion >= bundledModelVersion) {
    return manifest.parts;
  }

  const bundledParts = await Promise.all(
    seedParts.map(async (seed): Promise<CadPart> => {
      const bytes = await readFile(
        new URL(`../assets/models/${seed.assetPath}`, import.meta.url),
      );
      const existing = manifest.parts.find((part) => part.id === seed.id);
      if (existing != null) {
        let existingBytes: Buffer;
        try {
          existingBytes = await readFile(existing.storagePath);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return existing;
          }
          throw error;
        }
        // Also finish a migration interrupted after the model write but before the manifest write.
        if (
          !existingBytes.equals(bytes) &&
          !legacyModelHashes
            .get(seed.id)
            ?.includes(createHash("sha256").update(existingBytes).digest("hex"))
        ) {
          return existing;
        }
      }
      const storagePath =
        existing?.storagePath ?? path.join(modelRoot, seed.fileName);
      await writeFile(`${storagePath}.next`, bytes);
      await rename(`${storagePath}.next`, storagePath);
      return {
        description: `${seed.name}. Recreated in Blender from official product photos. Estimated dimensions; not fit-verified for manufacturing.`,
        fileName: seed.fileName,
        format: "stl",
        id: seed.id,
        name: seed.name,
        previews: {},
        resourceUri: getPartResourceUri(seed.id),
        sizeBytes: bytes.length,
        sourceLabel: `Bits & Bolts / ${seed.fileName}`,
        storagePath,
        tags: seed.tags,
        updatedAt: new Date().toISOString(),
      };
    }),
  );
  const replacements = new Map(bundledParts.map((part) => [part.id, part]));
  const existingIds = new Set(manifest.parts.map((part) => part.id));
  const parts = [
    ...manifest.parts.map((part) => replacements.get(part.id) ?? part),
    ...bundledParts.filter((part) => !existingIds.has(part.id)),
  ];
  await writeManifest({ bundledModelVersion, parts, version: 1 });
  return parts;
}

export async function listParts(): Promise<Array<CadPart>> {
  return (await readManifest()).parts;
}

export async function getPart(id: string): Promise<CadPart | null> {
  return (await listParts()).find((part) => part.id === id) ?? null;
}

export async function readPartBytes(
  id: string,
  representation: "source" | "display" = "source",
): Promise<{ bytes: Buffer; format: ModelFormat; part: CadPart }> {
  const part = await getPart(id);
  if (part == null) {
    throw new Error(`CAD library part was not found: ${id}`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(part.storagePath);
  } catch {
    throw new Error(`The source file for ${part.name} is missing.`);
  }
  const seed = seedParts.find((candidate) => candidate.id === id);
  if (representation === "display" && seed != null) {
    const bundledBytes = await readFile(
      new URL(`../assets/models/${seed.assetPath}`, import.meta.url),
    );
    // Edited CAD files must show their own geometry, not the bundled display model.
    if (bytes.equals(bundledBytes)) {
      const displayPath = path.posix.join(
        path.posix.dirname(seed.assetPath),
        `${path.posix.parse(seed.assetPath).name}.glb`,
      );
      return {
        bytes: await readFile(
          new URL(`../assets/models/${displayPath}`, import.meta.url),
        ),
        format: "glb",
        part,
      };
    }
  }
  return { bytes, format: part.format, part };
}

export async function importPart({
  bytes,
  description,
  fileName,
  name,
  sourceLabel,
  tags,
}: {
  bytes: Buffer;
  description?: string;
  fileName: string;
  name?: string;
  sourceLabel?: string;
  tags?: Array<string>;
}): Promise<CadPart> {
  const format = getCadFormat(fileName);
  if (format == null) {
    throw new Error("Supported CAD formats are STL, 3MF, STEP, and STP.");
  }
  if (bytes.byteLength === 0) {
    throw new Error("The selected CAD file is empty.");
  }
  if (bytes.byteLength > maxImportBytes) {
    throw new Error(
      "The selected CAD file is larger than the 32 MiB import limit.",
    );
  }

  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const id = `part_${hash}`;
  const cleanFileName = `${id}.${format}`;
  const storagePath = path.join(modelRoot, cleanFileName);
  await writeFile(storagePath, bytes);
  const result: CadPart = {
    description:
      description?.trim() ||
      `Imported ${format.toUpperCase()} model ready for review.`,
    fileName: path.basename(fileName),
    format,
    id,
    name: name?.trim() || displayNameFromFile(fileName),
    previews: {},
    resourceUri: getPartResourceUri(id),
    sizeBytes: bytes.byteLength,
    sourceLabel:
      sourceLabel?.trim() || `Bits & Bolts / ${path.basename(fileName)}`,
    storagePath,
    tags: tags?.map((tag) => tag.trim().toLowerCase()).filter(Boolean) ?? [
      format,
      "imported",
    ],
    updatedAt: new Date().toISOString(),
  };
  await updateManifest((manifest) => ({
    ...manifest,
    parts: [result, ...manifest.parts.filter((part) => part.id !== id)],
  }));
  return result;
}

export async function importPartFromPath(
  filePath: string,
  fileName?: string,
): Promise<CadPart> {
  // Open once so validation and reading refer to the same file. Nonblocking
  // mode lets us reject a FIFO without waiting for a writer during open.
  const source = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const fileStats = await source.stat();
    if (!fileStats.isFile()) {
      throw new Error("The selected CAD source is not a file.");
    }
    if (fileStats.size > maxImportBytes) {
      throw new Error(
        "The selected CAD file is larger than the 32 MiB import limit.",
      );
    }
    // The opened file can still grow. Read at most the limit plus one byte,
    // rather than trusting its earlier size or reading to an unbounded EOF.
    const chunks: Array<Buffer> = [];
    let total = 0;
    while (total <= maxImportBytes) {
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, maxImportBytes + 1 - total),
      );
      // Fill each chunk across short reads so tiny reads cannot retain a full
      // allocation apiece.
      let used = 0;
      while (used < chunk.length) {
        const { bytesRead } = await source.read(
          chunk,
          used,
          chunk.length - used,
        );
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      chunks.push(chunk.subarray(0, used));
      total += used;
      if (used < chunk.length) break;
    }
    if (total > maxImportBytes) {
      throw new Error(
        "The selected CAD file is larger than the 32 MiB import limit.",
      );
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    await source.close();
  }
  return importPart({
    bytes,
    fileName: fileName ?? path.basename(filePath),
    sourceLabel: `Workspace / ${path.basename(filePath)}`,
  });
}

export async function savePartPreviews(
  id: string,
  previews: Partial<Record<PreviewName, string>>,
): Promise<CadPart> {
  for (const image of Object.values(previews)) {
    if (
      image != null &&
      (!image.startsWith("data:image/") || image.length > 3 * 1024 * 1024)
    ) {
      throw new Error("Preview images must be data URLs smaller than 3 MiB.");
    }
  }
  let changed: CadPart | null = null;
  await updateManifest((manifest) => ({
    ...manifest,
    parts: manifest.parts.map((part) => {
      if (part.id !== id) {
        return part;
      }
      changed = {
        ...part,
        previews: { ...part.previews, ...previews },
        updatedAt: new Date().toISOString(),
      };
      return changed;
    }),
  }));
  if (changed == null) {
    throw new Error(`CAD library part was not found: ${id}`);
  }
  return changed;
}

export function getCadFormat(fileName: string): CadFormat | null {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  const result = cadFormatSchema.safeParse(extension);
  return result.success ? result.data : null;
}

export function getPartResourceUri(id: string): string {
  return `mcp://bits-and-bolts/parts/${id}`;
}

async function readManifest(): Promise<CadManifest> {
  return manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

async function writeManifest(manifest: CadManifest): Promise<void> {
  const temporaryPath = `${manifestPath}.next`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, manifestPath);
}

async function updateManifest(
  update: (manifest: CadManifest) => CadManifest,
): Promise<void> {
  const next = writeQueue.then(async () =>
    writeManifest(update(await readManifest())),
  );
  writeQueue = next.catch(() => {});
  await next;
}

function displayNameFromFile(fileName: string): string {
  const stem = path
    .basename(fileName, path.extname(fileName))
    .replaceAll(/[-_]+/g, " ")
    .trim();
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

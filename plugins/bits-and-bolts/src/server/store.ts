import type {
  CadPreferences,
  PartSourceResult,
  PublicCadPart,
} from "../shared/contracts.js";
export interface CatalogStore {
  list(): Promise<PublicCadPart[]>;
  get(id: string): Promise<PublicCadPart | null>;
  read(
    id: string,
    representation: "source" | "display",
  ): Promise<PartSourceResult>;
  import(input: {
    blob: string;
    fileName: string;
    name?: string;
    description?: string;
    tags?: string[];
  }): Promise<PublicCadPart>;
  savePreviews(
    id: string,
    previews: PublicCadPart["previews"],
  ): Promise<PublicCadPart>;
  readSettings(): Promise<CadPreferences>;
  updateSettings(set: Partial<CadPreferences>): Promise<CadPreferences>;
  settingsLifetime: string;
  localPath?(id: string): Promise<string>;
  importPath?(path: string, fileName: string): Promise<PublicCadPart>;
}

/// <reference types="vite/client" />

declare module "*.stl" {
  const source: string;
  export default source;
}

interface Document {
  readonly modelContext?: {
    registerTool(tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean };
      execute(input: unknown): Promise<string>;
    }): void;
  };
}

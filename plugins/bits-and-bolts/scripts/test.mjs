import { mkdir } from "node:fs/promises";

import { build } from "esbuild";

await mkdir(".local", { recursive: true });
await Promise.all(
  [
    "src/server/catalog.test.ts",
    "src/server/view-results.test.ts",
    "src/server/catalog-import.test.ts",
    "src/app/viewer/inspection.test.ts",
  ].map((entry) =>
    build({
      bundle: true,
      entryPoints: [entry],
      format: "esm",
      loader: { ".stl": "text" },
      outfile: `.local/${entry.split("/").pop().replace(".ts", ".mjs")}`,
      platform: "node",
      external: ["@modelcontextprotocol/*", "@openai/mcp-extensions/*"],
    }),
  ),
);
await import("../.local/catalog.test.mjs");
await import("../.local/catalog-import.test.mjs");

await import("../.local/inspection.test.mjs");

await import("../.local/view-results.test.mjs");

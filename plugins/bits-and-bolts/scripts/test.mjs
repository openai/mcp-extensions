/* global URL, console, process, Buffer, fetch, setTimeout, clearTimeout */

import { mkdir } from "node:fs/promises";

import { build } from "esbuild";

await mkdir(".local", { recursive: true });
await Promise.all(
  ["src/server/catalog.test.ts", "src/app/viewer/inspection.test.ts"].map(
    (entry) =>
      build({
        bundle: true,
        entryPoints: [entry],
        format: "esm",
        loader: { ".stl": "text" },
        outfile: `.local/${entry.split("/").pop().replace(".ts", ".mjs")}`,
        platform: "node",
      }),
  ),
);
await import("../.local/catalog.test.mjs");

await import("../.local/inspection.test.mjs");

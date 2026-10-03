import { mkdir } from "node:fs/promises";

import { build } from "esbuild";

await mkdir(".local", { recursive: true });
const entries = ["src/server/store.test.ts", "src/server/register.test.ts"];
await Promise.all(
  entries.map((entry) =>
    build({
      bundle: true,
      entryPoints: [entry],
      format: "esm",
      outfile: `.local/${entry.split("/").pop().replace(".ts", ".mjs")}`,
      platform: "node",
    }),
  ),
);
for (const entry of entries) {
  await import(`../.local/${entry.split("/").pop().replace(".ts", ".mjs")}`);
}

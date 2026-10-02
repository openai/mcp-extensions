/* global URL, console, process, Buffer, fetch, setTimeout, clearTimeout */

import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { build } from "esbuild";
import { buildApp } from "./build-app.mjs";

const { values } = parseArgs({
  options: { "plugin-dir": { type: "string" } },
});
const pluginRoot = path.resolve(values["plugin-dir"] ?? ".");
const outputRoot = path.join(pluginRoot, "dist");
const catalog = JSON.parse(
  await readFile("assets/models/catalog.json", "utf8"),
);
const modelPaths = catalog.flatMap(({ assetPath }) => [
  `assets/models/${assetPath}`,
  `assets/models/${assetPath.replace(/\.stl$/i, ".glb")}`,
]);

await Promise.all(
  modelPaths.map(async (modelPath) => {
    try {
      await access(modelPath);
    } catch (error) {
      throw new Error(
        `Cannot read ${modelPath}. Include the bundled models or regenerate them using assets/models/README.md before building.`,
        { cause: error },
      );
    }
  }),
);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await Promise.all([
  buildApp().then(({ html }) => writeFile(`${outputRoot}/app.html`, html)),
  copyFile(
    "node_modules/occt-import-js/dist/occt-import-js.wasm",
    `${outputRoot}/occt-import-js.wasm`,
  ),
  build({
    bundle: true,
    define: { __LOCAL_FILESYSTEM__: "true" },
    entryPoints: ["src/server/index.ts"],
    format: "esm",
    outfile: `${outputRoot}/server.js`,
    platform: "node",
  }),
]);

if (pluginRoot !== process.cwd()) {
  await Promise.all([
    cp(".codex-plugin", path.join(pluginRoot, ".codex-plugin"), {
      recursive: true,
    }),
    cp("skills", path.join(pluginRoot, "skills"), { recursive: true }),
    cp("assets", path.join(pluginRoot, "assets"), { recursive: true }),
    ...[".mcp.json", "README.md"].map((file) =>
      copyFile(file, path.join(pluginRoot, file)),
    ),
    writeFile(
      path.join(pluginRoot, "package.json"),
      `${JSON.stringify({ private: true, type: "module", engines: { node: ">=22" } }, null, 2)}\n`,
    ),
  ]);
}

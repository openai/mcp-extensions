/* global URL, console, process, Buffer, setTimeout, clearTimeout */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildApp } from "./build-app.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const output = path.join(root, ".local/remote");
const catalog = JSON.parse(
  await readFile("assets/models/catalog.json", "utf8"),
);
const modelPaths = catalog.flatMap(({ assetPath }) => [
  assetPath,
  assetPath.replace(/\.stl$/i, ".glb"),
]);
await Promise.all(
  modelPaths.map((file) => stat(path.join("assets/models", file))),
);
const seeds = await Promise.all(
  catalog.map(async (part) => ({
    ...part,
    sizeBytes: (await stat(path.join("assets/models", part.assetPath))).size,
  })),
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  buildApp().then(({ html }) => writeFile(path.join(output, "app.html"), html)),
  build({
    entryPoints: ["src/server/remote/index.ts"],
    outfile: path.join(output, "server.js"),
    bundle: true,
    define: { __LOCAL_FILESYSTEM__: "false" },
    minifySyntax: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  }),
  writeFile(path.join(output, "catalog.json"), JSON.stringify(seeds)),
  writeFile(
    path.join(output, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        engines: { node: ">=22" },
        scripts: { start: "node server.js" },
      },
      null,
      2,
    ),
  ),
  cp(
    "node_modules/occt-import-js/dist/occt-import-js.wasm",
    path.join(output, "occt-import-js.wasm"),
  ),
  cp("src/server/remote/assets/icon.svg", path.join(output, "icon.svg")),
  ...modelPaths.map(async (file) => {
    const dest = path.join(output, "models", file);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join("assets/models", file), dest);
  }),
]);
execFileSync("tar", [
  "-czf",
  path.join(root, ".local/bits-and-bolts-remote.tar.gz"),
  "-C",
  output,
  ".",
]);
console.log("Remote server built", {
  output,
  start: "node .local/remote/server.js",
  archive: ".local/bits-and-bolts-remote.tar.gz",
});

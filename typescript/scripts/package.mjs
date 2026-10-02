/* global URL, console, process, Buffer, setTimeout, clearTimeout */

import { copyFile, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const published = { ...manifest };
for (const key of ["devDependencies", "publishConfig", "scripts"])
  delete published[key];
published.exports = Object.fromEntries(
  Object.entries(manifest.exports).map(([name, target]) => [
    name,
    typeof target === "string"
      ? target
      : Object.fromEntries(
          Object.entries(target).map(([condition, path]) => [
            condition,
            path
              .replace("./src/", "./")
              .replace("./dist/", "./")
              .replace(/\.ts$/, condition === "types" ? ".d.ts" : ".js"),
          ]),
        ),
  ]),
);
published.files = ["**/*.js", "**/*.d.ts", "styles.css", "README.md"];
await copyFile(new URL("styles.css", root), new URL("dist/styles.css", root));
await copyFile(new URL("README.md", root), new URL("dist/README.md", root));
await writeFile(
  new URL("dist/package.json", root),
  `${JSON.stringify(published, null, 2)}\n`,
);

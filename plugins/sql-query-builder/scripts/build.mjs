import { build } from "esbuild";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/server/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: resolve(root, "dist/server.js"),
  format: "esm",
  external: ["@modelcontextprotocol/sdk", "@openai/mcp-extensions"],
});

await build({
  entryPoints: [resolve(root, "src/app/main.tsx")],
  bundle: true,
  platform: "browser",
  target: "es2022",
  outfile: resolve(root, "dist/app.js"),
  format: "esm",
  external: [
    "react",
    "react-dom",
    "@modelcontextprotocol/ext-apps",
    "@openai/mcp-extensions",
  ],
});

const html = await import("node:fs").then((fs) =>
  fs.readFileSync(resolve(root, "src/app/index.html"), "utf-8"),
);
const appHtml = html.replace(
  '<script type="module" src="./main.tsx"></script>',
  '<script type="module" src="./app.js"></script>',
);
await writeFile(resolve(root, "dist/app.html"), appHtml);

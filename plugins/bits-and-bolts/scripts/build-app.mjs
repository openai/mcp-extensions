/* global URL, console, process, Buffer, fetch, setTimeout, clearTimeout */

import { readFile } from "node:fs/promises";
import { build } from "vite";

export async function buildApp() {
  const output = await build({
    configFile: false,
    build: {
      write: false,
      target: "es2022",
      minify: true,
      lib: {
        entry: "src/app/index.ts",
        formats: ["iife"],
        name: "BitsAndBolts",
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const chunks = (Array.isArray(output) ? output : [output]).flatMap(
    (result) => result.output,
  );
  const scripts = chunks.filter((chunk) => chunk.type === "chunk");
  if (scripts.length !== 1 || chunks.some((chunk) => chunk.type === "asset"))
    throw Error("The CAD app must be one self-contained script.");
  const code = scripts[0].code;
  const [template, styles] = await Promise.all([
    readFile("src/app/index.html", "utf8"),
    readFile(
      new URL(import.meta.resolve("@openai/mcp-extensions/app/styles.css")),
      "utf8",
    ),
  ]);
  return {
    code,
    html: template
      .replace("<!-- APP_STYLES -->", () => `<style>${styles}</style>`)
      .replace(
        "<!-- APP_SCRIPT -->",
        () => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`,
      ),
  };
}

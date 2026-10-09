/* global URL, process */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(project, "package.json"), "utf8"),
);
const temporary = await mkdtemp(join(tmpdir(), "mcp-extensions-package-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", temporary], {
    cwd: project,
    stdio: "inherit",
  });
  const archive = (await readdir(temporary)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!archive) throw new Error("Package archive was not produced");
  const consumers = [
    {
      name: "shared",
      peers: [],
      missing: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/server"],
      imports: "",
    },
    {
      name: "server",
      peers: ["@modelcontextprotocol/server"],
      missing: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/ext-apps"],
      imports: `
        import { OpenAIExtensions } from "@openai/mcp-extensions/server";
        import { McpServer } from "@modelcontextprotocol/server";
        assert.equal(typeof new OpenAIExtensions(new McpServer({ name: "smoke", version: "1" })).elicitInputLegacy, "function");
      `,
    },
    {
      name: "app",
      peers: ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/sdk"],
      missing: ["@modelcontextprotocol/server"],
      imports: `
        import { OpenAIExtensions } from "@openai/mcp-extensions/app";
        import { createAppTransport } from "@openai/mcp-extensions/app/transport";
        assert.equal(typeof OpenAIExtensions, "function");
        assert.equal(typeof createAppTransport, "function");
        assert.ok(existsSync(new URL(import.meta.resolve("@openai/mcp-extensions/app/styles.css"))));
      `,
    },
  ];
  for (const { name, peers, missing, imports } of consumers) {
    const consumer = join(temporary, name);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    // Use the same configured registry as the monorepo installation.
    for (
      let directory = project;
      directory !== dirname(directory);
      directory = dirname(directory)
    ) {
      if (existsSync(join(directory, ".npmrc"))) {
        await copyFile(join(directory, ".npmrc"), join(consumer, ".npmrc"));
        break;
      }
    }
    execFileSync(
      "pnpm",
      [
        "add",
        join(temporary, archive),
        ...peers.map((peer) => `${peer}@${manifest.peerDependencies[peer]}`),
        "--ignore-scripts",
      ],
      {
        cwd: consumer,
        stdio: "inherit",
      },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    import { OpenAIFormSchema } from "@openai/mcp-extensions";
    assert.equal(typeof OpenAIFormSchema.parse, "function");
    assert.ok(import.meta.resolve("@openai/mcp-extensions").startsWith(pathToFileURL(process.cwd() + "/").href));
    for (const peer of ${JSON.stringify(missing)}) assert.throws(() => import.meta.resolve(peer), { code: "ERR_MODULE_NOT_FOUND" });
    ${imports}
  `,
      ],
      {
        cwd: consumer,
        stdio: "inherit",
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      },
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

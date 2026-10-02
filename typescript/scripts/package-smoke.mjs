/* global URL, process */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
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
  const consumer = join(temporary, "consumer");
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
  execFileSync("pnpm", ["add", join(temporary, archive), "--ignore-scripts"], {
    cwd: consumer,
    stdio: "inherit",
  });
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
    import { OpenAIExtensions as AppExtensions } from "@openai/mcp-extensions/app";
    import { OpenAIExtensions as ServerExtensions } from "@openai/mcp-extensions/server";
    import { createAppTransport } from "@openai/mcp-extensions/app/transport";
    assert.equal(typeof OpenAIFormSchema.parse, "function");
    for (const value of [AppExtensions, ServerExtensions, createAppTransport]) assert.equal(typeof value, "function");
    assert.ok(import.meta.resolve("@openai/mcp-extensions").startsWith(pathToFileURL(process.cwd() + "/").href));
    assert.ok(existsSync(new URL(import.meta.resolve("@openai/mcp-extensions/app/styles.css"))));
  `,
    ],
    {
      cwd: consumer,
      stdio: "inherit",
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

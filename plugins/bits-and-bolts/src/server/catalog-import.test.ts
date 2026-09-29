import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("path imports validate and read one bounded file handle", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cad-import-"));
  const previousHome = process.env.CAD_LIBRARY_HOME;
  process.env.CAD_LIBRARY_HOME = directory;
  const limit = 32 * 1024 * 1024;
  const tooLarge = /larger than the 32 MiB import limit/;
  try {
    await fs.mkdir(path.join(directory, "models"));
    await fs.writeFile(
      path.join(directory, "catalog.json"),
      JSON.stringify({ version: 1, bundledModelVersion: 6, parts: [] }),
    );
    const { importPartFromPath, readPartBytes } = await import("./catalog.js");
    const sourcePath = path.join(directory, "source.stl");
    const original = Buffer.from("solid original\nendsolid original\n");
    const realOpen = fs.open;
    const realStat = fs.stat;
    let afterStat = async () => {};
    const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    let bytesRead = 0;
    // Hook both stat APIs so the same deterministic replacement also exercises
    // the original pathname-based implementation when checking the regression.
    t.mock.method(fs, "stat", async (file: string) => {
      const stats = await realStat(file);
      if (file === sourcePath) await afterStat();
      return stats;
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (args[0] === sourcePath) {
        handles.push(handle);
        const stat = handle.stat.bind(handle);
        t.mock.method(handle, "stat", async () => {
          const stats = await stat();
          await afterStat();
          return stats;
        });
        const read = handle.read.bind(handle);
        t.mock.method(handle, "read", async (buffer: Buffer) => {
          const result = await read(buffer);
          bytesRead += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();

    await t.test(
      "pathname and symlink replacement cannot change the checked file",
      async () => {
        for (const symlink of [false, true]) {
          await fs.writeFile(sourcePath, original);
          const replacement = path.join(directory, "replacement.stl");
          await fs.writeFile(replacement, "replacement bytes");
          afterStat = async () => {
            if (symlink) {
              await fs.unlink(sourcePath);
              await fs.symlink(replacement, sourcePath);
            } else {
              await fs.rename(replacement, sourcePath);
            }
          };
          const part = await importPartFromPath(sourcePath, "Workspace.STL");
          assert.deepEqual((await readPartBytes(part.id)).bytes, original);
          assert.equal(part.fileName, "Workspace.STL");
          assert.equal(part.sourceLabel, "Workspace / source.stl");
          await fs.unlink(sourcePath);
        }
      },
    );
    await t.test(
      "growth after stat is rejected with a bounded read",
      async () => {
        await fs.writeFile(sourcePath, original);
        afterStat = () => fs.truncate(sourcePath, limit * 2);
        bytesRead = 0;
        await assert.rejects(importPartFromPath(sourcePath), tooLarge);
        assert.equal(bytesRead, limit + 1);
      },
    );
    afterStat = async () => {};
    await t.test(
      "ordinary symlinks and the exact size limit remain supported",
      async () => {
        await fs.writeFile(sourcePath, original);
        const link = path.join(directory, "link.stl");
        await fs.symlink(sourcePath, link);
        const part = await importPartFromPath(link);
        assert.deepEqual((await readPartBytes(part.id)).bytes, original);
        await fs.truncate(sourcePath, limit);
        assert.equal((await importPartFromPath(sourcePath)).sizeBytes, limit);
      },
    );
    await t.test(
      "invalid sources and read failures close their handles",
      async () => {
        await fs.truncate(sourcePath, limit + 1);
        await assert.rejects(importPartFromPath(sourcePath), tooLarge);
        await fs.truncate(sourcePath, 0);
        await assert.rejects(importPartFromPath(sourcePath), /empty/);
        await fs.unlink(sourcePath);
        await fs.mkdir(sourcePath);
        await assert.rejects(importPartFromPath(sourcePath), /not a file/);
        await fs.rmdir(sourcePath);
        if (process.platform !== "win32") {
          execFileSync("mkfifo", [sourcePath]);
          await assert.rejects(importPartFromPath(sourcePath), /not a file/);
          await fs.unlink(sourcePath);
        }
        await assert.rejects(importPartFromPath(sourcePath), {
          code: "ENOENT",
        });
        await fs.writeFile(sourcePath, original);
        afterStat = async () => {
          t.mock.method(handles.at(-1)!, "read", async () => {
            throw new Error("injected read failure");
          });
        };
        await assert.rejects(
          importPartFromPath(sourcePath),
          /injected read failure/,
        );
        assert.ok(handles.length > 0);
        assert.ok(handles.every((handle) => handle.fd === -1));
      },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.CAD_LIBRARY_HOME;
    else process.env.CAD_LIBRARY_HOME = previousHome;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

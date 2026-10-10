// Exercise the release-please version bundled in our pinned action without GitHub writes.
// Install release-please@17.6.0 in a temporary directory, then pass that directory here.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import * as prettier from "prettier";

const requireRelease = createRequire(
  path.resolve(process.argv[2], "package.json"),
);
const { Manifest } = requireRelease("release-please");
const { FileNotFoundError } = requireRelease("release-please/build/src/errors");
assert.equal(requireRelease("release-please/package.json").version, "17.6.0");
const root = process.cwd();
const config = JSON.parse(
  fs.readFileSync("release-please-config.json", "utf8"),
);
const baseline = JSON.parse(
  fs.readFileSync(".release-please-manifest.json", "utf8"),
);
const logger = { debug() {}, info() {}, warn() {}, error: console.error };
const bump = (version, minor = false) => {
  const [majorVersion, minorVersion, patchVersion] = version
    .split(".")
    .map(Number);
  return minor
    ? `${majorVersion}.${minorVersion + 1}.0`
    : `${majorVersion}.${minorVersion}.${patchVersion + 1}`;
};

async function rehearse(name, commits, expected) {
  const read = (filename) => fs.readFileSync(path.join(root, filename), "utf8");
  // Stub only GitHub I/O. Use the real config parser, strategies, updaters and release parser.
  const github = {
    repository: { owner: "openai", repo: "mcp-extensions" },
    getFileJson: async (filename) => JSON.parse(read(filename)),
    getFileContentsOnBranch: async (filename) => {
      if (!fs.existsSync(path.join(root, filename)))
        throw new FileNotFoundError(filename);
      const parsedContent = read(filename);
      return {
        parsedContent,
        content: Buffer.from(parsedContent).toString("base64"),
        sha: "fixture",
      };
    },
    findFilesByFilenameAndRef: async () => [],
    releaseIterator: async function* () {
      yield { tagName: "v0.1.0", sha: "historical", notes: "" };
    },
    tagIterator: async function* () {
      yield { name: "v0.1.0", sha: "historical" };
    },
    mergeCommitIterator: async function* () {
      yield* commits;
      yield { sha: config["bootstrap-sha"], message: "baseline", files: [] };
    },
    pullRequestIterator: async function* () {
      yield* [];
    },
  };
  const manifest = await Manifest.fromManifest(
    github,
    "main",
    "release-please-config.json",
    ".release-please-manifest.json",
    { logger },
  );
  const prs = await manifest.buildPullRequests();
  assert.equal(prs.length, Object.keys(expected).length);
  for (const pr of prs) {
    const component = pr.title.component;
    const packagePath = component === "python" ? "python" : "typescript";
    assert.equal(pr.version.toString(), expected[component]);
    const generated = new Map();
    for (const update of pr.updates) {
      const exists = fs.existsSync(path.join(root, update.path));
      if (!exists && !update.createIfMissing) continue;
      const result = update.updater.updateContent(
        exists ? read(update.path) : undefined,
        logger,
      );
      generated.set(update.path, result);
      const filepath = path.join(root, update.path);
      const { ignored, inferredParser } = await prettier.getFileInfo(filepath, {
        ignorePath: ".prettierignore",
      });
      if (!ignored && inferredParser) {
        assert(
          await prettier.check(result, { filepath }),
          `${update.path} would fail formatting CI`,
        );
      }
    }
    const versions = JSON.parse(generated.get(".release-please-manifest.json"));
    assert.equal(versions[packagePath], expected[component]);
    const other = component === "python" ? "typescript" : "python";
    assert.equal(
      versions[other],
      baseline[other],
      "The other package version changed",
    );
    assert(!generated.has(`${packagePath}/CHANGELOG.md`));
    assert(
      [...generated.keys()].every((file) => !file.startsWith(`${other}/`)),
    );
    const metadata = generated.get(
      `${packagePath}/${component === "python" ? "pyproject.toml" : "package.json"}`,
    );
    if (component === "node")
      assert.equal(JSON.parse(metadata).version, expected.node);
    else assert(metadata.includes(`version = "${expected.python}"`));

    github.pullRequestIterator = async function* () {
      yield {
        number: 1,
        title: pr.title.toString(),
        body: pr.body.toString(),
        headBranchName: pr.headRefName,
        baseBranchName: "main",
        sha: "a".repeat(40),
        labels: ["autorelease: pending"],
        files: [...generated.keys()],
      };
    };
    const releases = await manifest.buildReleases();
    assert.equal(
      releases.length,
      1,
      "A merged PR must release only its package",
    );
    assert.equal(
      releases[0].tag.toString(),
      `${component}-v${expected[component]}`,
    );
    assert.equal(releases[0].sha, "a".repeat(40));
    console.log(
      `${name}: ${pr.title.toString()} -> ${releases[0].tag.toString()}`,
    );
  }
}

const pythonFix = {
  sha: "b".repeat(40),
  message: "fix: handle empty resources",
  files: ["python/src/openai_mcp_extensions/resources.py"],
};
const nodeFeature = {
  sha: "c".repeat(40),
  message: "feat: add app capability",
  files: ["typescript/src/app/index.ts"],
};
const python = bump(baseline.python);
const node = bump(baseline.typescript, true);
await rehearse("Python fix", [pythonFix], { python });
await rehearse("Node feature", [nodeFeature], { node });
await rehearse("Both packages", [pythonFix, nodeFeature], { python, node });
await rehearse(
  "Infrastructure only",
  [
    {
      sha: "d".repeat(40),
      message: "ci: setup publishing",
      files: [".github/workflows/release.yml"],
    },
  ],
  {},
);
for (const [component, packagePath] of [
  ["python", "python"],
  ["node", "typescript"],
]) {
  const version = baseline[packagePath];
  await rehearse(
    `Explicit first ${component} release`,
    [
      {
        sha: "e".repeat(40),
        message: `chore: prepare initial ${component} release\n\nRelease-As: ${version}`,
        files: [`${packagePath}/README.md`],
      },
    ],
    { [component]: version },
  );
}
console.log(
  "Release-please generation and merged-PR release parsing passed without publishing.",
);

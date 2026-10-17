/**
 * The migration CLI's ESM build has neither `__dirname` nor `require`.
 *
 * `--version` read package.json through `__dirname` and printed "unknown",
 * and loading a config file called a bare `require`, so the ReferenceError
 * surfaced as "Failed to load config file". Both run against dist/ in child
 * processes — the code a consumer executes — and are skipped when dist/ has
 * not been built (CI builds before testing).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

const projectRoot = path.resolve(__dirname, "../..");
const builds = {
  cjs: path.join(projectRoot, "dist/migration/cli-entry.js"),
  esm: path.join(projectRoot, "dist/esm/migration/cli-entry.js"),
};
const distBuilt = fs.existsSync(builds.cjs) && fs.existsSync(builds.esm);

function runMain(build: keyof typeof builds, args: string[]) {
  const script =
    build === "esm"
      ? `import { main } from ${JSON.stringify(pathToFileURL(builds.esm).href)};
         process.exitCode = await main(["node", "cli", ...${JSON.stringify(args)}]);`
      : `const { main } = require(${JSON.stringify(builds.cjs)});
         main(["node", "cli", ...${JSON.stringify(args)}]).then((code) => { process.exitCode = code; });`;
  const run = spawnSync(
    process.execPath,
    build === "esm" ? ["--input-type=module", "-e", script] : ["-e", script],
    { cwd: projectRoot, encoding: "utf-8" },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

(distBuilt ? describe : describe.skip)("migration CLI — dist builds", () => {
  let tmpDir: string;
  let configPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stingerloom-cli-esm-"));
    // Not an options object, so loading succeeds and validation then rejects
    // it — the message proves the file was actually loaded.
    configPath = path.join(tmpDir, "stingerloom.config.cjs");
    fs.writeFileSync(configPath, "module.exports = 42;\n");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const { version } = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"),
  );

  it.each(["cjs", "esm"] as const)("%s build: --version prints the package version", (build) => {
    const run = runMain(build, ["--version"]);

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  });

  it.each(["cjs", "esm"] as const)("%s build: loads a CommonJS config file", (build) => {
    const run = runMain(build, ["migrate:status", "--config", configPath]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Config file exported no options object");
    expect(run.stderr).not.toContain("require is not defined");
  });
});

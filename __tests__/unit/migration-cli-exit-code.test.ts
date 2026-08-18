/**
 * CLI failure propagation (V4-T2-1).
 *
 * `MigrationRunner.runUp()` reports a failed migration as
 * `{ success: false }` instead of throwing, so `stingerloom migrate:run` used
 * to print "0 succeeded, 1 failed" and exit 0 — a CI step chaining
 * `migrate:run && ./deploy.sh` deployed against a schema that was never
 * applied. The exit-code contract is verified end to end against dist/ in a
 * child process, which is what a consumer actually runs; the argument parser
 * and the result inspection are unit-tested in process.
 */
import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

import {
  parseArgs,
  migrationFailures,
} from "../../src/migration/cli-entry";

const projectRoot = path.resolve(__dirname, "../..");

describe("parseArgs", () => {
  it("reads a command and its value flags", () => {
    const parsed = parseArgs([
      "node",
      "cli",
      "migrate:generate",
      "--config",
      "./stingerloom.config.js",
      "--name",
      "add_posts",
    ]);

    expect(parsed.command).toBe("migrate:generate");
    expect(parsed.config).toBe("./stingerloom.config.js");
    expect(parsed.name).toBe("add_posts");
    expect(parsed.errors).toEqual([]);
  });

  it("accepts the --flag=value form", () => {
    const parsed = parseArgs(["node", "cli", "migrate:run", "--config=./x.js"]);

    expect(parsed.config).toBe("./x.js");
    expect(parsed.errors).toEqual([]);
  });

  it("reports an unknown option instead of ignoring it", () => {
    const parsed = parseArgs(["node", "cli", "introspect", "--dry-runn"]);

    expect(parsed.errors).toEqual(['Unknown option: "--dry-runn"']);
    expect(parsed.dryRun).toBeUndefined();
  });

  it("rejects the run when an unknown flag's value lands in the command slot", () => {
    // `--ouput ./migrations migrate:run` used to be accepted with the typo'd
    // flag dropped and "./migrations" promoted to the command — reported as
    // `Unknown command: "./migrations"` with no mention of the real cause.
    const parsed = parseArgs([
      "node",
      "cli",
      "--ouput",
      "./migrations",
      "migrate:run",
    ]);

    expect(parsed.errors).toContain('Unknown option: "--ouput"');
    expect(parsed.errors).toContain('Unexpected argument: "migrate:run"');
  });

  it("reports a value flag with no value", () => {
    const parsed = parseArgs(["node", "cli", "migrate:run", "--config"]);

    expect(parsed.errors).toEqual(['Option "--config" requires a value.']);
  });

  it("reports an extra positional argument", () => {
    const parsed = parseArgs(["node", "cli", "migrate:run", "migrate:status"]);

    expect(parsed.command).toBe("migrate:run");
    expect(parsed.errors).toEqual(['Unexpected argument: "migrate:status"']);
  });

  it("recognises --help, -h and --version", () => {
    expect(parseArgs(["node", "cli", "--help"]).help).toBe(true);
    expect(parseArgs(["node", "cli", "-h"]).help).toBe(true);
    expect(parseArgs(["node", "cli", "--version"]).version).toBe(true);
  });

  it("keeps the introspect flag set", () => {
    const parsed = parseArgs([
      "node",
      "cli",
      "introspect",
      "--dry-run",
      "--include",
      "users,posts",
    ]);

    expect(parsed.dryRun).toBe(true);
    expect(parsed.include).toBe("users,posts");
    expect(parsed.errors).toEqual([]);
  });
});

describe("migrationFailures", () => {
  it("finds results that reported failure without throwing", () => {
    const results = [
      { name: "A", direction: "up", success: true },
      { name: "B", direction: "up", success: false, error: "boom" },
    ];

    expect(migrationFailures(results).map((r) => r.name)).toEqual(["B"]);
  });

  it("is empty for an all-successful run", () => {
    expect(
      migrationFailures([{ name: "A", direction: "up", success: true }]),
    ).toEqual([]);
  });

  it("is empty for non-array command results (status, generate)", () => {
    expect(migrationFailures({ executed: [], pending: [] })).toEqual([]);
    expect(migrationFailures({ filePath: "", sql: { up: [], down: [] } })).toEqual([]);
    expect(migrationFailures(undefined)).toEqual([]);
  });
});

// ─── dist smoke: the exit code a CI script actually observes ────────────────

const distCli = path.join(projectRoot, "dist/migration/cli-entry.js");
const distBuilt = fs.existsSync(distCli);

const SMOKE_CONFIG = `const { Migration } = require("./dist");

class CreateSmokeWidget extends Migration {
  async up({ query, driver }) {
    await query(
      \`CREATE TABLE \${driver.escapeIdentifier("smoke_widget")} (\${driver.escapeIdentifier("id")} INTEGER PRIMARY KEY)\`,
    );
  }
  async down({ query, driver }) {
    if (process.env.SMOKE_DOWN_FAILS === "1") {
      throw new Error("smoke rollback failure");
    }
    await query(\`DROP TABLE \${driver.escapeIdentifier("smoke_widget")}\`);
  }
}

class FailingSmokeMigration extends Migration {
  async up() {
    throw new Error("smoke migration failure");
  }
  async down() {}
}

module.exports = {
  type: process.env.SMOKE_DB_TYPE || "sqlite",
  database: process.env.SMOKE_DB || ":memory:",
  entities: [],
  migrations:
    process.env.SMOKE_FAIL === "1"
      ? [new FailingSmokeMigration()]
      : [new CreateSmokeWidget()],
};
`;

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(process.execPath, [distCli, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

(distBuilt ? describe : describe.skip)(
  "stingerloom CLI — dist exit codes",
  () => {
    const configPath = path.join(
      projectRoot,
      `.stingerloom-smoke-${process.pid}.config.js`,
    );
    const brokenConfigPath = path.join(
      projectRoot,
      `.stingerloom-smoke-broken-${process.pid}.config.js`,
    );
    const badTypeConfigPath = path.join(
      projectRoot,
      `.stingerloom-smoke-badtype-${process.pid}.config.js`,
    );
    const configArg = (p: string) => `./${path.basename(p)}`;
    let tmpDir: string;

    beforeAll(() => {
      fs.writeFileSync(configPath, SMOKE_CONFIG, "utf-8");
      fs.writeFileSync(
        brokenConfigPath,
        "module.exports = { type: 'sqlite',\n",
        "utf-8",
      );
      fs.writeFileSync(
        badTypeConfigPath,
        'module.exports = { type: "postgre", database: "mydb", entities: [], migrations: [] };\n',
        "utf-8",
      );
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stingerloom-cli-smoke-"));
    });

    afterAll(() => {
      for (const file of [configPath, brokenConfigPath, badTypeConfigPath]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("exits 0 when every migration applies", () => {
      const run = runCli(["migrate:run", "--config", configArg(configPath)]);

      expect(run.status).toBe(0);
      expect(run.output).toContain("CreateSmokeWidget");
    });

    it("exits 1 when a migration fails", () => {
      const run = runCli(["migrate:run", "--config", configArg(configPath)], {
        SMOKE_FAIL: "1",
      });

      expect(run.status).toBe(1);
      expect(run.output).toContain("smoke migration failure");
      expect(run.output).toContain("FailingSmokeMigration");
    });

    it("exits 1 when a rollback fails", () => {
      const dbFile = path.join(tmpDir, "rollback.sqlite");
      const applied = runCli(
        ["migrate:run", "--config", configArg(configPath)],
        { SMOKE_DB: dbFile },
      );
      expect(applied.status).toBe(0);

      const run = runCli(
        ["migrate:rollback", "--config", configArg(configPath)],
        { SMOKE_DB: dbFile, SMOKE_DOWN_FAILS: "1" },
      );

      expect(run.status).toBe(1);
      expect(run.output).toContain("smoke rollback failure");
    });

    it("exits 0 for migrate:status", () => {
      const run = runCli(["migrate:status", "--config", configArg(configPath)]);

      expect(run.status).toBe(0);
    });

    it("exits 1 with a readable message for a config that cannot be loaded", () => {
      const run = runCli([
        "migrate:run",
        "--config",
        configArg(brokenConfigPath),
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Failed to load config file");
      expect(run.stderr).toContain(path.basename(brokenConfigPath));
      // The old path rejected outside every try/catch: an unhandled rejection
      // dumped a stack trace of CLI internals.
      expect(run.stderr).not.toMatch(/^\s+at /m);
      expect(run.stderr).not.toContain("UnhandledPromiseRejection");
    });

    it("exits 1 naming the supported types for an unsupported database type", () => {
      const run = runCli([
        "migrate:run",
        "--config",
        configArg(badTypeConfigPath),
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('unsupported database type "postgre"');
      expect(run.stderr).toContain("mysql, mariadb, postgres, sqlite");
    });

    it("exits 1 for a missing config file, naming the path", () => {
      const run = runCli([
        "migrate:run",
        "--config",
        "./no-such-stingerloom.config.js",
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("Config file not found");
      expect(run.stderr).toContain("no-such-stingerloom.config.js");
    });

    it("exits 1 for an unknown option", () => {
      const run = runCli([
        "migrate:run",
        "--config",
        configArg(configPath),
        "--yolo",
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Unknown option: "--yolo"');
    });

    it("exits 1 for a mistyped flag instead of running its value", () => {
      const run = runCli([
        "--ouput",
        "./migrations",
        "migrate:run",
        "--config",
        configArg(configPath),
      ]);

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Unknown option: "--ouput"');
      expect(run.output).not.toContain("Running pending migrations");
    });

    it("exits 1 for an unknown command and 0 for --help", () => {
      expect(runCli(["migrate:nope"]).status).toBe(1);
      expect(runCli(["--help"]).status).toBe(0);
    });

    it("prints the package version for --version", () => {
      const run = runCli(["--version"]);
      const { version } = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"),
      );

      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(version);
    });
  },
);

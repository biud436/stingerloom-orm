#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stingerloom ORM CLI
 *
 * Usage:
 *   npx stingerloom migrate:run        — Run all pending migrations
 *   npx stingerloom migrate:rollback   — Rollback the last migration
 *   npx stingerloom migrate:status     — Show migration status
 *   npx stingerloom migrate:generate   — Generate migration from schema diff
 *   npx stingerloom introspect         — Generate entity files from an existing schema
 *
 * Config file: stingerloom.config.{ts,js,mjs,cjs} / ormconfig.{ts,js,mjs,cjs}
 *
 * Exit codes: 0 on success, 1 on any failure — including a migration that
 * reported `success: false` without throwing. A CI step that chains
 * `stingerloom migrate:run && ./deploy.sh` must not deploy a schema that never
 * got applied.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { MigrationCli, MigrationCommand } from "./MigrationCli";
import { Migration } from "./Migration";
import { MigrationResult } from "./MigrationRunner";
import { resolveDbOptions } from "./cli-config";
import { runIntrospect } from "../introspection/IntrospectionCli";
import { OrmError } from "../errors/OrmError";

type CliCommand = MigrationCommand | "introspect";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const VALID_COMMANDS: CliCommand[] = [
  "migrate:run",
  "migrate:rollback",
  "migrate:status",
  "migrate:generate",
  "introspect",
];

const CONFIG_FILE_NAMES = [
  "stingerloom.config.ts",
  "stingerloom.config.js",
  "stingerloom.config.mjs",
  "stingerloom.config.cjs",
  "ormconfig.ts",
  "ormconfig.js",
  "ormconfig.mjs",
  "ormconfig.cjs",
];

/**
 * An error the CLI already knows how to explain: printed as a message (plus
 * indented details) with no stack trace, because the stack points at CLI
 * plumbing rather than at anything the user can act on.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Flags that consume the next argument as their value. */
const VALUE_FLAGS: Record<string, string> = {
  "--config": "config",
  "--output": "output",
  "--name": "name",
  "--schema": "schema",
  "--include": "include",
  "--exclude": "exclude",
  "--import-path": "importPath",
};

/** Flags that are on/off by their presence alone. */
const BOOLEAN_FLAGS: Record<string, string> = {
  "--dry-run": "dryRun",
  "--help": "help",
  "-h": "help",
  "--version": "version",
};

export interface ParsedArgs {
  command?: string;
  config?: string;
  output?: string;
  name?: string;
  schema?: string;
  include?: string;
  exclude?: string;
  importPath?: string;
  dryRun?: boolean;
  help: boolean;
  version: boolean;
  /** Argument-level problems: unknown flags, missing values, extra operands. */
  errors: string[];
}

function printUsage(): void {
  console.log(`
Stingerloom ORM — CLI

Usage:
  stingerloom <command> [options]

Commands:
  migrate:run         Run all pending migrations
  migrate:rollback    Rollback the last migration
  migrate:status      Show executed and pending migrations
  migrate:generate    Generate migration file from schema diff
  introspect          Generate entity files from an existing database schema

Options (migration commands):
  --config <path>     Path to config file (default: auto-detect)
  --output <dir>      Output directory for generated migrations (default: ./migrations)
  --name <suffix>     Migration name suffix for generated file

Options (introspect):
  --config <path>     Path to config file (default: auto-detect)
  --output <dir>      Output directory for generated entities (default: ./entities)
  --schema <name>     PostgreSQL schema to introspect (default: public)
  --include <list>    Comma-separated whitelist of tables to generate
  --exclude <list>    Comma-separated blacklist of tables to skip
  --import-path <p>   Import path for ORM decorators (default: @stingerloom/orm)
  --dry-run           Don't write files; report what would be generated

  --version           Print the installed @stingerloom/orm version
  --help              Show this help message

Exit codes:
  0  command succeeded
  1  command failed (including a migration that reported a failure)

Config file (auto-detected):
  stingerloom.config.ts, stingerloom.config.js, ormconfig.ts, ormconfig.js
`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, version: false, errors: [] };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];

    // `--flag=value` is accepted as an alias for `--flag value`.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const arg = eq > 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq > 0 ? raw.slice(eq + 1) : undefined;

    if (BOOLEAN_FLAGS[arg]) {
      if (inlineValue !== undefined) {
        result.errors.push(`Option "${arg}" does not take a value.`);
        continue;
      }
      (result as any)[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }

    if (VALUE_FLAGS[arg]) {
      const value = inlineValue ?? args[i + 1];
      if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("-"))) {
        result.errors.push(`Option "${arg}" requires a value.`);
        continue;
      }
      (result as any)[VALUE_FLAGS[arg]] = value;
      if (inlineValue === undefined) i++;
      continue;
    }

    // An unrecognised flag used to be dropped on the floor — and its value was
    // then promoted to the command. A typo like `--dry-runn` silently wrote
    // files; `--ouput ./x` silently used the default directory.
    if (raw.startsWith("-")) {
      result.errors.push(`Unknown option: "${raw}"`);
      continue;
    }

    if (!result.command) {
      result.command = raw;
      continue;
    }

    result.errors.push(`Unexpected argument: "${raw}"`);
  }

  return result;
}

/** Reads the installed package version for `--version`. */
function readPackageVersion(): string {
  try {
    // dist/migration/cli-entry.js and src/migration/cli-entry.ts are both two
    // levels below the package root. `__dirname` is absent in the ESM build,
    // where the ReferenceError lands in this catch.
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../package.json"), "utf-8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function loadConfig(
  configPath?: string,
): Promise<{ config: any; path: string }> {
  const candidates = configPath
    ? [resolve(process.cwd(), configPath)]
    : CONFIG_FILE_NAMES.map((name) => resolve(process.cwd(), name));

  const found = candidates.find((abs) => existsSync(abs));

  if (!found) {
    throw configPath
      ? new CliError(`Config file not found: ${candidates[0]}`)
      : new CliError(`No config file found in ${process.cwd()}`, [
          `Create one of: ${CONFIG_FILE_NAMES.join(", ")}`,
          `Or point at one explicitly: --config <path>`,
        ]);
  }

  let config: any;
  try {
    config = await requireConfig(found);
  } catch (err: unknown) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Failed to load config file: ${found}`, [
      `Cause: ${errorMessage(err)}`,
    ]);
  }

  if (!config || typeof config !== "object") {
    throw new CliError(`Config file exported no options object: ${found}`, [
      `Got ${config === undefined ? "undefined" : typeof config}.`,
      `Export the options object: export default { type: "postgres", ... }`,
    ]);
  }

  return { config, path: found };
}

async function requireConfig(filePath: string): Promise<any> {
  // ts files need ts-node or tsx; js files can be required directly
  if (filePath.endsWith(".ts")) {
    try {
      require("ts-node/register");
    } catch {
      try {
        require("tsx/cjs");
      } catch {
        throw new CliError(`Cannot load TypeScript config: ${filePath}`, [
          "Install ts-node or tsx:",
          "  npm install -D ts-node",
          "  npm install -D tsx",
        ]);
      }
    }
    const mod = require(filePath);
    return mod.default ?? mod;
  }

  // .mjs is always ESM; .js is ESM when the app's package.json says
  // "type": "module". require() of an ES module throws ERR_REQUIRE_ESM on
  // Node < 23 (and 22.x before require(esm) landed), so fall back to a
  // dynamic import() with a file URL (Windows-safe).
  if (!filePath.endsWith(".mjs")) {
    try {
      const mod = require(filePath);
      return mod.default ?? mod;
    } catch (err: any) {
      const code = err?.code ?? "";
      const isEsmRequireError =
        code === "ERR_REQUIRE_ESM" || code === "ERR_REQUIRE_ASYNC_MODULE";
      if (!isEsmRequireError) throw err;
    }
  }

  const mod = await dynamicImport(pathToFileURL(filePath).href);
  return mod.default ?? mod;
}

/**
 * A dynamic import() that survives the CJS build.
 *
 * The CJS tsconfig transpiles `import()` expressions to `require()`, which
 * cannot load ES modules on Node < 23 and rejects file:// URLs — exactly the
 * case this fallback exists for. Routing through `new Function` keeps the
 * literal `import()` out of TypeScript's downleveling in both builds.
 */
const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<any>;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Migration results that reported a failure without throwing.
 *
 * `MigrationRunner.runUp()` reports a failed migration as
 * `{ success: false, error }` rather than by throwing, so the command's return
 * value is the only place the failure exists.
 */
export function migrationFailures(result: unknown): MigrationResult[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (entry): entry is MigrationResult =>
      !!entry && typeof entry === "object" && (entry as any).success === false,
  );
}

async function runIntrospectCommand(
  dbOptions: any,
  parsed: ParsedArgs,
): Promise<number> {
  const splitList = (value?: string) =>
    value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

  try {
    const result = await runIntrospect(dbOptions, {
      outputDir: parsed.output,
      schema: parsed.schema,
      includeTables: splitList(parsed.include),
      excludeTables: splitList(parsed.exclude),
      codeBuilderOptions: parsed.importPath
        ? { importPath: parsed.importPath }
        : undefined,
      dryRun: parsed.dryRun,
    });

    if (parsed.dryRun) {
      console.log(`Would generate ${result.entities.length} entity files:`);
      for (const entity of result.entities) {
        console.log(
          `  - ${entity.fileName}  (${entity.tableName} → ${entity.className})`,
        );
      }
    } else {
      console.log(`Wrote ${result.writtenFiles.length} entity files.`);
    }
    return EXIT_OK;
  } catch (err: unknown) {
    console.error(`Introspection failed: ${errorMessage(err)}`);
    printSuggestion(err);
    return EXIT_FAILURE;
  }
}

async function runMigrationCommand(
  command: MigrationCommand,
  config: any,
  configPath: string,
  dbOptions: any,
  parsed: ParsedArgs,
): Promise<number> {
  const migrations: Migration[] = config.migrations ?? [];
  if (!Array.isArray(migrations)) {
    throw new CliError(
      `Config error in ${configPath}: "migrations" must be an array of imported migration classes, got ${typeof config.migrations}.`,
      [
        "Glob patterns are not supported — import the migration files and list them:",
        "  migrations: [new CreateUsersTable(), new AddPhoneToUsers()]",
      ],
    );
  }

  const cli = new MigrationCli(migrations, dbOptions);

  if (parsed.output || parsed.name) {
    cli.setGenerateOptions({
      outputDir: parsed.output,
      name: parsed.name,
    });
  }

  try {
    await cli.connect();
    const result = await cli.execute(command);

    const failures = migrationFailures(result);
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(
          `Migration failed: ${failure.name} (${failure.direction}) — ${failure.error ?? "no error reported"}`,
        );
      }
      console.error(
        `${command} failed: ${failures.length} of ${(result as MigrationResult[]).length} migration(s) did not apply.`,
      );
      return EXIT_FAILURE;
    }

    return EXIT_OK;
  } catch (err: unknown) {
    console.error(`Migration failed: ${errorMessage(err)}`);
    printSuggestion(err);
    return EXIT_FAILURE;
  } finally {
    // Runs before the exit code takes effect: the process ends naturally after
    // main() resolves, so `process.exitCode` never cuts this short the way a
    // direct `process.exit()` did.
    await cli.close().catch(() => {});
  }
}

function printSuggestion(err: unknown): void {
  const suggestion = (err as any)?.suggestion;
  if (typeof suggestion === "string" && suggestion.length > 0) {
    console.error(`Suggestion: ${suggestion}`);
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      console.error(error);
    }
    printUsage();
    return EXIT_FAILURE;
  }

  if (parsed.version) {
    console.log(readPackageVersion());
    return EXIT_OK;
  }

  if (parsed.help || !parsed.command) {
    printUsage();
    return parsed.help ? EXIT_OK : EXIT_FAILURE;
  }

  if (!VALID_COMMANDS.includes(parsed.command as CliCommand)) {
    console.error(
      `Unknown command: "${parsed.command}"\nValid commands: ${VALID_COMMANDS.join(", ")}`,
    );
    return EXIT_FAILURE;
  }

  const command = parsed.command as CliCommand;

  // Config loading lives inside the reported-failure path: a config with a
  // syntax error used to reject outside every try/catch and kill the process
  // with an unhandled-rejection dump.
  const { config, path: configPath } = await loadConfig(parsed.config);
  const dbOptions = resolveDbOptions(config, configPath);

  if (command === "introspect") {
    return runIntrospectCommand(dbOptions, parsed);
  }

  return runMigrationCommand(command, config, configPath, dbOptions, parsed);
}

/**
 * Runs main() and maps its result onto the process exit code.
 *
 * `process.exitCode` rather than `process.exit()`: the latter tore down the
 * process mid-`finally`, so the database connection was never closed on the
 * failure path.
 */
export async function runCli(argv: string[] = process.argv): Promise<number> {
  try {
    return await main(argv);
  } catch (err: unknown) {
    if (err instanceof CliError) {
      console.error(err.message);
      for (const detail of err.details) {
        console.error(`  ${detail}`);
      }
    } else if (err instanceof OrmError) {
      console.error(err.message);
      printSuggestion(err);
    } else {
      console.error(`Unexpected error: ${errorMessage(err)}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
    }
    return EXIT_FAILURE;
  }
}

// Only self-execute when run as a program (`stingerloom …`), so tests can
// import the pieces above. `require` is absent in the ESM build; the published
// bin is the CJS build.
if (typeof require !== "undefined" && require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}

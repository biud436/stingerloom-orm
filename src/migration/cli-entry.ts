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
 * Config file: stingerloom.config.ts / stingerloom.config.js / ormconfig.ts / ormconfig.js
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { MigrationCli, MigrationCommand } from "./MigrationCli";
import { Migration } from "./Migration";
import { runIntrospect } from "../introspection/IntrospectionCli";

type CliCommand = MigrationCommand | "introspect";

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
  "ormconfig.ts",
  "ormconfig.js",
];

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

  --help              Show this help message

Config file (auto-detected):
  stingerloom.config.ts, stingerloom.config.js, ormconfig.ts, ormconfig.js
`);
}

function parseArgs(argv: string[]): {
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
} {
  const result: any = { help: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--config" && i + 1 < args.length) {
      result.config = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      result.output = args[++i];
    } else if (arg === "--name" && i + 1 < args.length) {
      result.name = args[++i];
    } else if (arg === "--schema" && i + 1 < args.length) {
      result.schema = args[++i];
    } else if (arg === "--include" && i + 1 < args.length) {
      result.include = args[++i];
    } else if (arg === "--exclude" && i + 1 < args.length) {
      result.exclude = args[++i];
    } else if (arg === "--import-path" && i + 1 < args.length) {
      result.importPath = args[++i];
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (!arg.startsWith("--") && !result.command) {
      result.command = arg;
    }
  }

  return result;
}

async function loadConfig(configPath?: string): Promise<any> {
  if (configPath) {
    const abs = resolve(process.cwd(), configPath);
    if (!existsSync(abs)) {
      console.error(`Config file not found: ${abs}`);
      process.exit(1);
    }
    return requireConfig(abs);
  }

  for (const name of CONFIG_FILE_NAMES) {
    const abs = resolve(process.cwd(), name);
    if (existsSync(abs)) {
      return requireConfig(abs);
    }
  }

  console.error(
    "No config file found. Create one of: " + CONFIG_FILE_NAMES.join(", "),
  );
  process.exit(1);
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
        console.error(
          "Cannot load .ts config. Install ts-node or tsx:\n  npm install -D ts-node\n  npm install -D tsx",
        );
        process.exit(1);
      }
    }
  }

  const mod = require(filePath);
  return mod.default ?? mod;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.help || !parsed.command) {
    printUsage();
    process.exit(parsed.help ? 0 : 1);
  }

  if (!VALID_COMMANDS.includes(parsed.command as CliCommand)) {
    console.error(
      `Unknown command: "${parsed.command}"\nValid commands: ${VALID_COMMANDS.join(", ")}`,
    );
    process.exit(1);
  }

  const command = parsed.command as CliCommand;
  const config = await loadConfig(parsed.config);
  const dbOptions = config.database ?? config;

  if (command === "introspect") {
    try {
      const result = await runIntrospect(dbOptions, {
        outputDir: parsed.output,
        schema: parsed.schema,
        includeTables: parsed.include
          ? parsed.include.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        excludeTables: parsed.exclude
          ? parsed.exclude.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        codeBuilderOptions: parsed.importPath
          ? { importPath: parsed.importPath }
          : undefined,
        dryRun: parsed.dryRun,
      });
      if (parsed.dryRun) {
        console.log(`Would generate ${result.entities.length} entity files:`);
        for (const entity of result.entities) {
          console.log(`  - ${entity.fileName}  (${entity.tableName} → ${entity.className})`);
        }
      } else {
        console.log(`Wrote ${result.writtenFiles.length} entity files.`);
      }
      return;
    } catch (err: any) {
      console.error(`Introspection failed: ${err.message}`);
      process.exit(1);
    }
  }

  const migrations: Migration[] = config.migrations ?? [];

  const cli = new MigrationCli(migrations, dbOptions);

  if (parsed.output || parsed.name) {
    cli.setGenerateOptions({
      outputDir: parsed.output,
      name: parsed.name,
    });
  }

  try {
    await cli.connect();
    await cli.execute(command as MigrationCommand);
  } catch (err: any) {
    console.error(`Migration failed: ${err.message}`);
    if (err.suggestion) {
      console.error(`Suggestion: ${err.suggestion}`);
    }
    process.exit(1);
  } finally {
    await cli.close().catch(() => {});
  }
}

main();

#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stingerloom ORM Migration CLI
 *
 * Usage:
 *   npx stingerloom migrate:run        — Run all pending migrations
 *   npx stingerloom migrate:rollback   — Rollback the last migration
 *   npx stingerloom migrate:status     — Show migration status
 *   npx stingerloom migrate:generate   — Generate migration from schema diff
 *
 * Config file: stingerloom.config.ts / stingerloom.config.js / ormconfig.ts / ormconfig.js
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { MigrationCli, MigrationCommand } from "./MigrationCli";
import { Migration } from "./Migration";

const VALID_COMMANDS: MigrationCommand[] = [
  "migrate:run",
  "migrate:rollback",
  "migrate:status",
  "migrate:generate",
];

const CONFIG_FILE_NAMES = [
  "stingerloom.config.ts",
  "stingerloom.config.js",
  "ormconfig.ts",
  "ormconfig.js",
];

function printUsage(): void {
  console.log(`
Stingerloom ORM — Migration CLI

Usage:
  stingerloom <command> [options]

Commands:
  migrate:run         Run all pending migrations
  migrate:rollback    Rollback the last migration
  migrate:status      Show executed and pending migrations
  migrate:generate    Generate migration file from schema diff

Options:
  --config <path>     Path to config file (default: auto-detect)
  --output <dir>      Output directory for generated migrations (default: ./migrations)
  --name <suffix>     Migration name suffix for generated file
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

  if (!VALID_COMMANDS.includes(parsed.command as MigrationCommand)) {
    console.error(
      `Unknown command: "${parsed.command}"\nValid commands: ${VALID_COMMANDS.join(", ")}`,
    );
    process.exit(1);
  }

  const command = parsed.command as MigrationCommand;
  const config = await loadConfig(parsed.config);

  const migrations: Migration[] = config.migrations ?? [];
  const dbOptions = config.database ?? config;

  const cli = new MigrationCli(migrations, dbOptions);

  if (parsed.output || parsed.name) {
    cli.setGenerateOptions({
      outputDir: parsed.output,
      name: parsed.name,
    });
  }

  try {
    await cli.connect();
    await cli.execute(command);
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

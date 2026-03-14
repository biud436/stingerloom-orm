#!/usr/bin/env node

import { PrismaImporter } from "./PrismaImporter";

async function main() {
  const args = process.argv.slice(2);

  let schemaPath = "";
  let outputDir = "";
  let force = false;
  let provider: "postgresql" | "mysql" | "sqlite" | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--schema":
      case "-s":
        schemaPath = args[++i];
        break;
      case "--output":
      case "-o":
        outputDir = args[++i];
        break;
      case "--force":
      case "-f":
        force = true;
        break;
      case "--provider":
      case "-p":
        provider = args[++i] as "postgresql" | "mysql" | "sqlite";
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!schemaPath) {
    console.error("Error: --schema is required");
    printHelp();
    process.exit(1);
  }

  if (!outputDir) {
    console.error("Error: --output is required");
    printHelp();
    process.exit(1);
  }

  const importer = new PrismaImporter();

  try {
    const result = await importer.import({
      schemaPath,
      outputDir,
      force,
      provider,
    });

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }

    if (result.written.length > 0) {
      console.log("\nGenerated files:");
      for (const f of result.written) {
        console.log(`  + ${f}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log("\nSkipped (use --force to overwrite):");
      for (const f of result.skipped) {
        console.log(`  ~ ${f}`);
      }
    }

    console.log(
      `\nDone! ${result.written.length} file(s) written, ${result.skipped.length} skipped.`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Usage: stingerloom-prisma-import [options]

Options:
  --schema, -s <path>     Path to Prisma schema file (required)
  --output, -o <path>     Output directory for generated files (required)
  --force, -f             Overwrite existing files
  --provider, -p <name>   Override database provider (postgresql|mysql|sqlite)
  --help, -h              Show this help message
`);
}

main();

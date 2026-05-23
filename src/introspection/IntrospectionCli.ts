/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { Logger } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import {
  GeneratedEntity,
  IntrospectionGenerator,
} from "./IntrospectionGenerator";
import { IntrospectionDialect } from "./TypeMapper";
import { EntityCodeBuilderOptions } from "./EntityCodeBuilder";

export interface IntrospectionCliOptions {
  /** Output directory for generated entity files. Default: "./entities" */
  outputDir?: string;
  /** PostgreSQL schema to introspect. Default: "public" */
  schema?: string;
  /** Whitelist of table names to generate. */
  includeTables?: string[];
  /** Blacklist of table names to skip. */
  excludeTables?: string[];
  /** Options forwarded to EntityCodeBuilder (e.g. importPath). */
  codeBuilderOptions?: EntityCodeBuilderOptions;
  /** When true, do not write files — return generated entities only. */
  dryRun?: boolean;
}

export interface IntrospectionCliResult {
  /** Absolute file paths written (empty when dryRun=true). */
  writtenFiles: string[];
  /** Full GeneratedEntity records returned by the generator. */
  entities: GeneratedEntity[];
}

/**
 * Translate the ORM's database-options `type` to an `IntrospectionDialect`.
 */
function dialectFromOptions(options: DatabaseClientOptions): IntrospectionDialect {
  const type = (options as { type?: string }).type;
  switch (type) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "postgres":
      return "postgres";
    case "sqlite":
      return "sqlite";
    default:
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_DATABASE,
        `Introspection is not supported for database type "${type ?? "<unknown>"}".`,
      );
  }
}

/**
 * Connects to the configured database, runs introspection, and writes the
 * generated entity files to disk (unless `dryRun` is set).
 *
 * Returns the list of written paths and the full GeneratedEntity records so
 * callers (e.g. the CLI) can log a summary.
 */
export async function runIntrospect(
  dbOptions: DatabaseClientOptions,
  cliOptions: IntrospectionCliOptions = {},
): Promise<IntrospectionCliResult> {
  const logger = new Logger("Introspect");
  const dialect = dialectFromOptions(dbOptions);
  const client = DatabaseClient.getInstance();
  const connector = await client.connect(dbOptions);

  try {
    const queryFn = (q: any) => connector.query(q);
    const generator = new IntrospectionGenerator(queryFn, dialect, {
      schema: cliOptions.schema,
      includeTables: cliOptions.includeTables,
      excludeTables: cliOptions.excludeTables,
      codeBuilderOptions: cliOptions.codeBuilderOptions,
    });

    const entities = await generator.generate();
    if (entities.length === 0) {
      logger.warn("Introspection produced no entities — nothing to write.");
      return { writtenFiles: [], entities };
    }

    if (cliOptions.dryRun) {
      logger.info(
        `Dry run: ${entities.length} entities would be written (skipping disk I/O).`,
      );
      return { writtenFiles: [], entities };
    }

    const outputDir = resolve(
      process.cwd(),
      cliOptions.outputDir ?? "./entities",
    );
    await mkdir(outputDir, { recursive: true });

    const writtenFiles: string[] = [];
    for (const entity of entities) {
      const filePath = resolve(outputDir, entity.fileName);
      await writeFile(filePath, entity.code, "utf8");
      writtenFiles.push(filePath);
    }

    logger.info(
      `Introspection complete: ${writtenFiles.length} entities written to ${outputDir}`,
    );
    return { writtenFiles, entities };
  } finally {
    await client.close().catch(() => {});
  }
}

import * as fs from "fs";
import { PrismaParser } from "./PrismaParser";
import { PrismaSchemaAnalyzer } from "./PrismaSchemaAnalyzer";
import { RelationResolver } from "./RelationResolver";
import { EntityCodeGenerator } from "./EntityCodeGenerator";
import { FileWriter, WriteResult } from "./FileWriter";

export interface PrismaImportOptions {
  /** Path to the .prisma schema file */
  schemaPath: string;
  /** Output directory for generated entity files */
  outputDir: string;
  /** Overwrite existing files (default: false) */
  force?: boolean;
  /** Override the detected provider */
  provider?: "postgresql" | "mysql" | "sqlite";
}

export interface PrismaImportResult {
  /** Successfully written file paths */
  written: string[];
  /** Skipped file paths (already exist, --force not set) */
  skipped: string[];
  /** Warnings generated during import */
  warnings: string[];
  /** Generated files as name → source map */
  files: Map<string, string>;
}

/**
 * Orchestrates the full Prisma schema → stingerloom entity pipeline.
 */
export class PrismaImporter {
  /**
   * Import a Prisma schema file and write entity files to disk.
   */
  async import(options: PrismaImportOptions): Promise<PrismaImportResult> {
    const source = fs.readFileSync(options.schemaPath, "utf-8");
    const warnings: string[] = [];
    const files = await this.generateAsync(source, options.provider, warnings);

    const writer = new FileWriter();
    const writeResult: WriteResult = await writer.write(files, {
      outputDir: options.outputDir,
      force: options.force,
    });

    return {
      written: writeResult.written,
      skipped: writeResult.skipped,
      warnings,
      files,
    };
  }

  /**
   * Parse and generate entity source code without writing to disk.
   * Useful for testing and programmatic use.
   */
  generate(
    source: string,
    provider?: string,
  ): Map<string, string> {
    const warnings: string[] = [];
    return this.generateSync(source, provider, warnings);
  }

  /**
   * Internal async generation (uses dynamic import for prisma-ast).
   */
  private async generateAsync(
    source: string,
    providerOverride?: string,
    warnings: string[] = [],
  ): Promise<Map<string, string>> {
    const parser = new PrismaParser();
    const ast = await parser.parse(source);
    return this.generateFromAst(ast, providerOverride, warnings);
  }

  /**
   * Internal sync generation (requires prisma-ast to be already loadable).
   */
  private generateSync(
    source: string,
    providerOverride?: string,
    warnings: string[] = [],
  ): Map<string, string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let getSchema: (source: string) => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const prismaAst = require("@mrleebo/prisma-ast");
      getSchema = prismaAst.getSchema;
    } catch {
      throw new Error(
        'Package "@mrleebo/prisma-ast" is required. Install with: pnpm add -D @mrleebo/prisma-ast',
      );
    }

    const ast = getSchema(source);
    return this.generateFromAst(ast, providerOverride, warnings);
  }

  private generateFromAst(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ast: any,
    providerOverride?: string,
    warnings: string[] = [],
  ): Map<string, string> {
    const analyzer = new PrismaSchemaAnalyzer();
    const context = analyzer.analyze(ast);

    // Apply provider override
    if (providerOverride) {
      (context as { provider: string }).provider = providerOverride;
    }

    // Warn about unsupported types
    for (const model of context.models) {
      for (const field of model.fields) {
        if (field.fieldType === "Unsupported") {
          warnings.push(
            `Model "${model.name}", field "${field.name}": Unsupported type skipped`,
          );
        }
      }
    }

    // Filter out Unsupported fields
    for (const model of context.models) {
      model.fields = model.fields.filter(
        (f) => f.fieldType !== "Unsupported",
      );
    }

    const resolver = new RelationResolver();
    const relations = resolver.resolve(context);

    const generator = new EntityCodeGenerator(context, relations);
    return generator.generateAll();
  }
}

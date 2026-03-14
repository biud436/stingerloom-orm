import * as fs from "fs";
import * as path from "path";

export interface FileWriterOptions {
  outputDir: string;
  force?: boolean;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Writes generated entity files to disk.
 */
export class FileWriter {
  async write(
    files: Map<string, string>,
    options: FileWriterOptions,
  ): Promise<WriteResult> {
    const { outputDir, force } = options;

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const written: string[] = [];
    const skipped: string[] = [];

    for (const [fileName, content] of files) {
      const filePath = path.join(outputDir, fileName);

      if (fs.existsSync(filePath) && !force) {
        skipped.push(filePath);
        continue;
      }

      fs.writeFileSync(filePath, content, "utf-8");
      written.push(filePath);
    }

    return { written, skipped };
  }
}

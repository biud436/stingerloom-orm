import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Plain CJS build tool — imported with require so ts-jest does not transform it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rewriteSpecifier, rewriteSource } = require("../../scripts/fix-esm.js");

describe("fix-esm specifier rewriting", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-esm-"));
    fs.writeFileSync(path.join(dir, "DatabaseClient.js"), "");
    fs.mkdirSync(path.join(dir, "core"));
    fs.writeFileSync(path.join(dir, "core", "index.js"), "");
    fs.mkdirSync(path.join(dir, "dialects"));
    fs.writeFileSync(path.join(dir, "dialects", "SqlDriver.js"), "");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("rewriteSpecifier", () => {
    it("appends .js to relative file imports", () => {
      expect(rewriteSpecifier("./DatabaseClient", dir)).toBe(
        "./DatabaseClient.js",
      );
    });

    it("resolves directory imports to index.js", () => {
      expect(rewriteSpecifier("./core", dir)).toBe("./core/index.js");
    });

    it("resolves parent-relative imports", () => {
      expect(rewriteSpecifier("../core", path.join(dir, "dialects"))).toBe(
        "../core/index.js",
      );
    });

    it("leaves bare package specifiers alone", () => {
      expect(rewriteSpecifier("reflect-metadata", dir)).toBe("reflect-metadata");
      expect(rewriteSpecifier("sql-template-tag", dir)).toBe("sql-template-tag");
    });

    it("leaves already-extensioned specifiers alone", () => {
      expect(rewriteSpecifier("./DatabaseClient.js", dir)).toBe(
        "./DatabaseClient.js",
      );
    });
  });

  describe("rewriteSource", () => {
    it("rewrites static import, export-from and side-effect imports", () => {
      const source = [
        'import "reflect-metadata";',
        'import "./DatabaseClient";',
        'import { A } from "./core";',
        'export { B } from "./DatabaseClient";',
        'export * from "./core";',
      ].join("\n");

      expect(rewriteSource(source, dir)).toBe(
        [
          'import "reflect-metadata";',
          'import "./DatabaseClient.js";',
          'import { A } from "./core/index.js";',
          'export { B } from "./DatabaseClient.js";',
          'export * from "./core/index.js";',
        ].join("\n"),
      );
    });

    it("rewrites dynamic imports (driver lazy-loading)", () => {
      const source = 'const { X } = await import("./core");';
      expect(rewriteSource(source, dir)).toBe(
        'const { X } = await import("./core/index.js");',
      );
    });

    it("does not touch generated-code templates with interpolated specifiers", () => {
      const source =
        "lines.push(`import { X } from \"./${refFileName.replace(/\\.ts$/, \"\")}\";`);";
      expect(rewriteSource(source, dir)).toBe(source);
    });

    it("does not touch SQL strings containing from", () => {
      const source = 'const sql = `select * from "user" where id = 1`;';
      expect(rewriteSource(source, dir)).toBe(source);
    });

    it("does not touch dynamic imports of bare packages", () => {
      const source = 'const mod = await import("better-sqlite3");';
      expect(rewriteSource(source, dir)).toBe(source);
    });
  });
});

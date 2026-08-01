/**
 * PrismaImporter.generate() parser loading (#436).
 *
 * The sync API resolves @mrleebo/prisma-ast with require() in the CJS build
 * and a createRequire() shim in the ESM build (where bare require used to
 * crash with a ReferenceError). Jest's module registry cannot require the
 * ESM chevrotain dependency in-process, so the success paths run against
 * dist/ in child processes — exactly what a consumer executes — and are
 * skipped when dist/ has not been built (CI builds before testing).
 */
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

jest.mock("@mrleebo/prisma-ast", () => {
  throw new Error("simulated resolution failure");
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaImporter } = require("../../src/integration/prisma-import/PrismaImporter");

const MINI_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Widget {
  id   Int    @id @default(autoincrement())
  name String
}
`;

const projectRoot = path.resolve(__dirname, "../..");

describe("PrismaImporter.generate() — parser resolution failure", () => {
  it("names the async alternatives in the error", () => {
    expect(() => new PrismaImporter().generate(MINI_SCHEMA)).toThrow(
      /generateAsync\(\)/,
    );
    expect(() => new PrismaImporter().generate(MINI_SCHEMA)).toThrow(
      /pnpm add -D @mrleebo\/prisma-ast/,
    );
  });

  it("generateAsync() is part of the public surface", () => {
    expect(typeof new PrismaImporter().generateAsync).toBe("function");
  });
});

function runNodeScript(fileName: string, source: string): string {
  const tmpFile = path.join(projectRoot, fileName);
  try {
    fs.writeFileSync(tmpFile, source, "utf-8");
    return execSync(`node "${tmpFile}"`, {
      cwd: projectRoot,
      encoding: "utf-8",
    });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

const distBuilt =
  fs.existsSync(path.join(projectRoot, "dist/integration/prisma-import/index.js")) &&
  fs.existsSync(path.join(projectRoot, "dist/esm/integration/prisma-import/index.js"));

(distBuilt ? describe : describe.skip)(
  "PrismaImporter.generate() — dist smoke (CJS and ESM builds)",
  () => {
    it("CJS build: generate() works via native require", () => {
      const out = runNodeScript(
        `.prisma-smoke-cjs-${process.pid}.js`,
        `const { PrismaImporter } = require("./dist/integration/prisma-import");
         const files = new PrismaImporter().generate(${JSON.stringify(MINI_SCHEMA)});
         process.stdout.write([...files.keys()].sort().join(","));`,
      );
      expect(out).toContain("widget.entity.ts");
    });

    it("ESM build: generate() works via the createRequire shim", () => {
      const out = runNodeScript(
        `.prisma-smoke-esm-${process.pid}.mjs`,
        `import { PrismaImporter } from "./dist/esm/integration/prisma-import/index.js";
         const files = new PrismaImporter().generate(${JSON.stringify(MINI_SCHEMA)});
         process.stdout.write([...files.keys()].sort().join(","));`,
      );
      expect(out).toContain("widget.entity.ts");
    });

    it("ESM build: generateAsync() works via dynamic import", () => {
      const out = runNodeScript(
        `.prisma-smoke-esm-async-${process.pid}.mjs`,
        `import { PrismaImporter } from "./dist/esm/integration/prisma-import/index.js";
         const files = await new PrismaImporter().generateAsync(${JSON.stringify(MINI_SCHEMA)});
         process.stdout.write([...files.keys()].sort().join(","));`,
      );
      expect(out).toContain("widget.entity.ts");
    });
  },
);

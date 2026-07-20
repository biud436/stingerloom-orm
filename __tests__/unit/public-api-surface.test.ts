import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Guards the published API surface of every entry point declared in the
 * package's `exports` map.
 *
 * Each barrel lists its public symbols explicitly (no `export *`), so adding an
 * export to an internal module must not widen the published API by accident.
 * When a symbol is added or removed on purpose, update the fixture in the same
 * commit — the diff is then reviewable as an intentional API change.
 */

const ROOT = path.resolve(__dirname, "../..");
const FIXTURE = path.join(__dirname, "__fixtures__/public-api-surface.json");

/** Subpath in package.json `exports` -> barrel that backs it. */
const ENTRY_POINTS: Record<string, string> = {
  ".": "src/index.ts",
  "./core": "src/core/index.ts",
  "./decorators": "src/decorators/index.ts",
  "./errors": "src/errors/index.ts",
  "./introspection": "src/introspection/index.ts",
  "./metadata": "src/metadata/index.ts",
  "./migration": "src/migration/index.ts",
  "./plugin": "src/core/plugin/index.ts",
  "./schema": "src/schema/index.ts",
  "./seeding": "src/seeding/index.ts",
  "./mysql": "src/dialects/mysql/index.ts",
  "./postgres": "src/dialects/postgres/index.ts",
  "./sqlite": "src/dialects/sqlite/index.ts",
  "./nestjs": "src/integration/nestjs/index.ts",
  "./prisma-import": "src/integration/prisma-import/index.ts",
  "./testing": "src/testing/index.ts",
};

function collectSurfaces(): Record<string, string[]> {
  const configPath = path.join(ROOT, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);

  const files = Object.values(ENTRY_POINTS).map((f) => path.join(ROOT, f));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const surfaces: Record<string, string[]> = {};
  for (const [subpath, file] of Object.entries(ENTRY_POINTS)) {
    const source = program.getSourceFile(path.join(ROOT, file));
    if (!source) throw new Error(`entry not found: ${file}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${file} is not a module`);

    surfaces[subpath] = checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => symbol.getName())
      .sort((a, b) => a.localeCompare(b));
  }
  return surfaces;
}

describe("public API surface", () => {
  const actual = collectSurfaces();
  const expected: Record<string, string[]> = JSON.parse(
    fs.readFileSync(FIXTURE, "utf8"),
  );

  it.each(Object.keys(ENTRY_POINTS))("%s matches the recorded surface", (subpath) => {
    const recorded = expected[subpath] ?? [];
    const current = actual[subpath];

    const added = current.filter((name) => !recorded.includes(name));
    const removed = recorded.filter((name) => !current.includes(name));

    expect({ added, removed }).toEqual({ added: [], removed: [] });
  });

  it("does not re-export internal implementation details", () => {
    // Representative internals that used to leak through `export *`.
    const internals = [
      "SchemaRegistrar",
      "CascadeHandler",
      "RelationLoader",
      "EntityManagerInternals",
      "ResultTransformerFactory",
      "ReflectManager",
      "camelToSnakeCase",
      "buildAbs",
      "renderSubquery",
      "topologicalSort",
      "deepEquals",
      "resolveWhereClause",
      "deepCloneMetadata",
      "__clearQAliasCache",
    ];

    const leaked: string[] = [];
    for (const [subpath, names] of Object.entries(actual)) {
      for (const name of internals) {
        if (names.includes(name)) leaked.push(`${subpath}: ${name}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it.each(Object.entries(ENTRY_POINTS))(
    "%s declares its barrel without wildcard re-exports",
    (_subpath, file) => {
      const barrel = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(barrel).not.toMatch(/^export \* from/m);
    },
  );
});

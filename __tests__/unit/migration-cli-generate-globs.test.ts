/**
 * `migrate:generate` with glob entity patterns (V4-T2-1).
 *
 * `entities` accepts glob strings everywhere else in the ORM (the runtime
 * EntityManager resolves them through `resolveEntityGlobs`), but the CLI cast
 * the array straight to constructors — `SchemaDiff` then walked a string as if
 * it were an entity class and the command died with the empty message
 * "Migration failed: ".
 */
import "reflect-metadata";
import * as path from "path";
import { MigrationCli } from "../../src/migration";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";

const mockQuery = jest.fn().mockResolvedValue([]);
const mockConnect = jest.fn().mockResolvedValue({ query: mockQuery });
const mockClose = jest.fn();

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: mockConnect,
      close: mockClose,
      getConnection: async () => ({ query: mockQuery }),
      type: "sqlite",
    }),
  },
}));

const fixturesDir = path.join(__dirname, "fixtures", "glob-entities");
const entityGlob = path.join(fixturesDir, "**/*.entity.{ts,js}");

const emptyDiff = {
  addTables: [],
  dropTables: [],
  addColumns: [],
  dropColumns: [],
  alterColumns: [],
  renameColumns: [],
  addTableEntityMap: new Map(),
};

describe("MigrationCli.migrateGenerate() — entity globs", () => {
  let diffSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    diffSpy = jest
      .spyOn(SchemaDiff.prototype, "diff")
      .mockResolvedValue(emptyDiff as any);
  });

  afterEach(() => {
    diffSpy.mockRestore();
  });

  it("loads entity classes from a glob pattern before diffing", async () => {
    const cli = new MigrationCli([], {
      type: "sqlite",
      database: ":memory:",
      entities: [entityGlob],
    } as any);

    await cli.connect();
    await cli.migrateGenerate();

    expect(diffSpy).toHaveBeenCalledTimes(1);
    const passedEntities = diffSpy.mock.calls[0][0] as Function[];
    expect(passedEntities.every((e) => typeof e === "function")).toBe(true);
    expect(passedEntities.map((e) => e.name).sort()).toEqual(["Post", "User"]);
  });

  it("keeps directly listed entity classes alongside globs", async () => {
    class Inline {}
    const cli = new MigrationCli([], {
      type: "sqlite",
      database: ":memory:",
      entities: [Inline, entityGlob],
    } as any);

    await cli.connect();
    await cli.migrateGenerate();

    const passedEntities = diffSpy.mock.calls[0][0] as Function[];
    expect(passedEntities.map((e) => e.name).sort()).toEqual([
      "Inline",
      "Post",
      "User",
    ]);
  });

  it("fails with the pattern and the resolution directory when nothing matches", async () => {
    const cli = new MigrationCli([], {
      type: "sqlite",
      database: ":memory:",
      entities: [path.join(fixturesDir, "**/*.nope.ts")],
    } as any);

    await cli.connect();
    await expect(cli.migrateGenerate()).rejects.toThrow(
      /matched no files.*resolved from/s,
    );
    expect(diffSpy).not.toHaveBeenCalled();
  });

  it("warns that an empty entities list can only produce an empty diff", async () => {
    const cli = new MigrationCli([], {
      type: "sqlite",
      database: ":memory:",
      entities: [],
    } as any);
    const warn = jest
      .spyOn((cli as any).logger, "warn")
      .mockImplementation(() => undefined);

    await cli.connect();
    await cli.migrateGenerate();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("No entities configured"),
    );
  });
});

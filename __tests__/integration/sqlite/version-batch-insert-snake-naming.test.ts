/**
 * SQLite In-Memory: @Version auto-initialization on the BATCH insert paths
 * under a transforming NamingStrategy.
 *
 * Regression: saveMany()/insertMany()/insertManyAndReturn() initialized the
 * @Version column by writing `item[versionColumnName] = 1`. After
 * applyNamingStrategyToEntities rewrites VERSION_TOKEN to the resolved DB column
 * name, that column name no longer equals the property key — but the VALUES are
 * bound from the property key, so the version landed as NULL (or violated a
 * NOT NULL constraint). Single-word version properties happened to work because
 * column name == property key; a multi-word property (rowVersion -> row_version)
 * exposes the bug. The single-row save() path was already correct.
 */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Version,
} from "../../../src";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

describe("[Integration] SQLite: @Version batch-insert init under SnakeNamingStrategy", () => {
  let conn: TestConnectionResult;
  let Doc: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = `ver_snake_${String(Date.now()).slice(-6)}`;

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: tableName })
        class DocEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          // Multi-word property → snake_case column "row_version" (≠ propKey).
          @Version() rowVersion!: number;
        }

        Doc = DocEntity;
        return { entities: [DocEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  /** Reads the raw `row_version` column straight from the DB (not the entity). */
  async function readVersions(): Promise<unknown[]> {
    const connector = DatabaseClient.getInstance().getConnection();
    const rows = (await connector.query(
      `SELECT "row_version" FROM "${tableName}" ORDER BY "id"`,
    )) as any[];
    return rows.map((r) => r.row_version);
  }

  it("saveMany() initializes the @Version column to 1 (not NULL)", async () => {
    await conn.em.saveMany(Doc, [{ title: "a" }, { title: "b" }] as any);
    expect(await readVersions()).toEqual([1, 1]);
  });

  it("insertMany() initializes the @Version column to 1", async () => {
    const before = (await readVersions()).length;
    await conn.em.insertMany(Doc, [{ title: "c" }] as any);
    const versions = await readVersions();
    expect(versions.length).toBe(before + 1);
    expect(versions[versions.length - 1]).toBe(1);
  });

  it("insertManyAndReturn() returns rows with @Version = 1 and persists it", async () => {
    const returned = (await conn.em.insertManyAndReturn(Doc, [
      { title: "d" },
    ] as any)) as any[];
    expect(returned[0].rowVersion).toBe(1);

    const versions = await readVersions();
    expect(versions[versions.length - 1]).toBe(1);
  });
});

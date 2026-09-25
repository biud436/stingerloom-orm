/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `migrate:generate` writes a migration for every change kind the schema
 * diff reports, not only for added / dropped / altered columns.
 *
 * The CLI decided whether anything changed from the add/drop/alter lists
 * alone, so a diff whose only change was a `@Column({ renamedFrom })` rename
 * or a new `@ComputedColumn` printed "No schema changes detected" and wrote
 * nothing — while `synchronize` applied the same change at boot.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Column, ComputedColumn, Entity, PrimaryGeneratedColumn } from "../../../src";
import { MigrationCli } from "../../../src/migration/MigrationCli";
import { createTestConnection, resetMetadata } from "../helpers/test-connection";

describe("[Integration] SQLite: migrate:generate covers renames and computed columns", () => {
  let dir: string;
  let options: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-mgck-"));
    options = { type: "sqlite", database: path.join(dir, "db.sqlite") };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Boots `v1` with synchronize, then diffs `v2` against it through the CLI. */
  async function generate(
    v1: () => any[],
    v2: () => any[],
  ): Promise<{ up: string[]; filePath: string }> {
    const booted = await createTestConnection(
      { ...options, synchronize: true, logging: false },
      () => ({ entities: v1() }),
    );
    await booted.cleanup();

    resetMetadata();
    const cli = new MigrationCli([], {
      ...options,
      entities: v2(),
      synchronize: false,
      logging: false,
    });
    await cli.connect();
    cli.setGenerateOptions({ outputDir: path.join(dir, "migrations") });
    try {
      const result = (await cli.execute("migrate:generate")) as any;
      return { up: result.sql.up, filePath: result.filePath };
    } finally {
      await cli.close();
    }
  }

  /** Runs the generated statements on a plain connection and returns the columns. */
  async function applyAndReadColumns(
    up: string[],
    table: string,
    entities: () => any[],
  ): Promise<string[]> {
    const conn = await createTestConnection(
      { ...options, synchronize: false, logging: false },
      () => ({ entities: entities() }),
    );
    try {
      for (const statement of up) await conn.em.query(statement);
      const columns = (await conn.em.query(
        `PRAGMA table_xinfo("${table}")`,
      )) as unknown as Array<{ name: string }>;
      return columns.map((c) => c.name);
    } finally {
      await conn.cleanup();
    }
  }

  it("writes a migration for a renamedFrom rename alone", async () => {
    const v2 = () => {
      @Entity({ name: "mgck_rename" })
      class Profile {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40, renamedFrom: "handle" })
        nickname!: string;
      }
      return [Profile];
    };

    const { up, filePath } = await generate(() => {
      @Entity({ name: "mgck_rename" })
      class Profile {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) handle!: string;
      }
      return [Profile];
    }, v2);

    expect(filePath).not.toBe("");
    expect(up).toEqual([
      `ALTER TABLE "mgck_rename" RENAME COLUMN "handle" TO "nickname"`,
    ]);
    expect(await applyAndReadColumns(up, "mgck_rename", v2)).toEqual([
      "id",
      "nickname",
    ]);
  });

  it("writes a migration for an added computed column alone", async () => {
    const v2 = () => {
      @Entity({ name: "mgck_computed" })
      class Line {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "int" }) qty!: number;
        @ComputedColumn({ expression: "qty * 10", type: "int" }) total!: number;
      }
      return [Line];
    };

    const { up, filePath } = await generate(() => {
      @Entity({ name: "mgck_computed" })
      class Line {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "int" }) qty!: number;
      }
      return [Line];
    }, v2);

    expect(filePath).not.toBe("");
    expect(up).toHaveLength(1);
    expect(up[0]).toContain(`ADD COLUMN "total"`);
    expect(await applyAndReadColumns(up, "mgck_computed", v2)).toEqual([
      "id",
      "qty",
      "total",
    ]);
  });

  it("still reports no changes when the entity matches the table", async () => {
    const entities = () => {
      @Entity({ name: "mgck_same" })
      class Same {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "int" }) qty!: number;
      }
      return [Same];
    };

    const { up, filePath } = await generate(entities, entities);

    expect(filePath).toBe("");
    expect(up).toEqual([]);
  });
});

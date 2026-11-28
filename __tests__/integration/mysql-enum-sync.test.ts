/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL / MariaDB keep an ENUM's values in the column type itself, so a
 * changed value list is a change to the column. These read the live
 * information_schema: what synchronize and migrate:generate do when an
 * entity adds or removes a value, and that the MODIFY COLUMN applying it
 * keeps the column's default.
 */
import "reflect-metadata";
import type { Sql } from "sql-template-tag";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import { DatabaseClient } from "../../src/DatabaseClient";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaDiffMigrationGenerator } from "../../src/core/generators/SchemaDiffMigrationGenerator";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { Logger } from "../../src/utils/Logger";

const mysqlDrivers = getTestDrivers().filter((d) => d.type === "mysql");
const describeMySql = mysqlDrivers.length > 0 ? describe.each(mysqlDrivers) : describe.skip.each([{} as TestDriverConfig]);

describeMySql("[Integration] $label: ENUM value lists", ({ options }: TestDriverConfig) => {
  const table = `mes_post_${String(Date.now()).slice(-7)}`;
  let conn: TestConnectionResult | undefined;

  /** Each boot declares the entity the way the next release would. */
  function declare(values: string[], noteLength = 20) {
    @Entity({ name: table })
    class MesPost {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "enum", enumValues: values, default: "draft" }) status!: string;
      @Column({ type: "varchar", length: noteLength, default: "x" }) note!: string;
    }
    return MesPost;
  }

  async function boot(synchronize: unknown, values: string[], noteLength = 20) {
    if (conn) await conn.cleanup();
    conn = undefined;
    conn = await createTestConnection({ logging: false, ...options, synchronize } as any, () => ({
      entities: [declare(values, noteLength)],
    }));
  }

  async function column(name: string): Promise<{ type: string; default: string | null }> {
    const rows = (await rawQuery(
      `SELECT COLUMN_TYPE AS t, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${name}'`,
    )) as any[];
    // MariaDB reports a literal default quoted ('draft'), MySQL bare (draft).
    const d = rows[0].d === null ? null : String(rows[0].d).replace(/^'(.*)'$/, "$1");
    return { type: String(rows[0].t), default: d };
  }

  beforeAll(async () => {
    Logger.setOutput(() => undefined);
    await boot(true, ["draft", "published"]);
    await rawQuery(`INSERT INTO \`${table}\` (status, note) VALUES ('published', 'kept')`);
  }, 60000);

  afterAll(async () => {
    Logger.reset();
    await dropTestTable(table);
    if (conn) await conn.cleanup();
  }, 30000);

  it("synchronize adds a declared value and keeps the defaults of the columns it alters", async () => {
    await boot(true, ["draft", "published", "archived"], 40);

    expect(await column("status")).toEqual({
      type: "enum('draft','published','archived')",
      default: "draft",
    });
    expect(await column("note")).toEqual({ type: "varchar(40)", default: "x" });

    await rawQuery(`INSERT INTO \`${table}\` (status) VALUES ('archived')`);
    const rows = (await rawQuery(`SELECT status, note FROM \`${table}\` ORDER BY id`)) as any[];
    expect(rows).toEqual([
      { status: "published", note: "kept" },
      { status: "archived", note: "x" },
    ]);
  });

  it("a second boot with the same values changes nothing", async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    const diff = await new SchemaDiff().diff(
      [declare(["draft", "published", "archived"], 40)],
      { query: (s: string | Sql) => connector.query(s as any) },
      "mysql",
    );
    expect(diff.alterColumns).toEqual([]);
  });

  it("failOnDestructiveChange refuses to remove a value", async () => {
    await expect(
      boot(
        { mode: true, failOnDestructiveChange: true },
        ["draft", "archived"],
        40,
      ),
    ).rejects.toMatchObject({ code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE });

    if (conn) await conn.cleanup();
    conn = undefined;
    await boot(false, ["draft", "published", "archived"], 40);
    expect((await column("status")).type).toBe("enum('draft','published','archived')");
  });

  it("migrate:generate writes an up() and a down() that run on the server", async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    const diff = await new SchemaDiff().diff(
      [declare(["draft", "published", "archived", "hidden"], 40)],
      { query: (s: string | Sql) => connector.query(s as any) },
      "mysql",
    );
    const { up, down } = new SchemaDiffMigrationGenerator().dryRun(diff, "mysql");
    expect(up).toHaveLength(1);
    expect(down).toHaveLength(1);

    await rawQuery(up[0]);
    expect(await column("status")).toEqual({
      type: "enum('draft','published','archived','hidden')",
      default: "draft",
    });

    await rawQuery(down[0]);
    expect(await column("status")).toEqual({
      type: "enum('draft','published','archived')",
      default: "draft",
    });
  });
});

/**
 * synchronize on SQLite stops at an entity mistake or an unreadable schema
 * instead of booting against tables that do not match the entities.
 *
 * Before, a table named outside `[A-Za-z0-9_.]` (a Korean name, a hyphen)
 * failed the schema comparison on every boot after the first, and the
 * failure was downgraded to a warning that skipped every column change of
 * every table; an unknown column type such as "varchr" became a NUMERIC
 * column that stored "007" as 7.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { SchemaDiff } from "../../../src/core/generators/SchemaDiff";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "사용자_프로필" })
class BflProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) name!: string;
}

@Entity({ name: "bfl_items" })
class BflItemV1 {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) label!: string;
}

@Entity({ name: "bfl_items" })
class BflItemV2 {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) label!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) note!: string | null;
}

@Entity({ name: "bfl_typos" })
class BflTypo {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchr" as any, length: 10 }) code!: string;
}

async function register(database: string, entities: Array<new () => any>, extra: Record<string, unknown> = {}) {
  const em = new EntityManager();
  try {
    await em.register({ type: "sqlite", database, entities, synchronize: true, logging: false, ...extra } as any);
  } catch (e) {
    await em.propagateShutdown().catch(() => undefined);
    throw e;
  }
  return em;
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[SQLite] synchronize fails loud at boot", () => {
  let dir: string;
  let database: string;
  const open: EntityManager[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bfl-"));
    database = path.join(dir, "app.db");
  });

  afterEach(async () => {
    while (open.length > 0) await open.pop()!.propagateShutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const columnsOf = async (em: EntityManager, table: string): Promise<string[]> => {
    const rows: any[] = await em.query(`PRAGMA table_info("${table}")`);
    return rows.map((r) => r.name);
  };

  it("compares a table whose name is not a bare identifier and applies the other tables' changes", async () => {
    const first = await register(database, [BflProfile, BflItemV1]);
    await first.propagateShutdown();

    const second = await register(database, [BflProfile, BflItemV2]);
    open.push(second);

    expect(await columnsOf(second, "bfl_items")).toEqual(["id", "label", "note"]);
    await second.save(BflProfile, { name: "kim" });
    expect((await second.find(BflProfile, {})).map((p) => p.name)).toEqual(["kim"]);
  });

  it("throws when the comparison itself fails, whatever continueOnError says", async () => {
    const first = await register(database, [BflItemV1]);
    await first.propagateShutdown();

    jest.spyOn(SchemaDiff.prototype, "diff").mockRejectedValue(new Error("catalog unreadable"));
    const error = await rejectionOf(() =>
      register(database, [BflItemV2], { synchronize: { mode: true, continueOnError: true } }),
    );

    expect(error?.code).toBe(OrmErrorCode.SCHEMA_SYNC_FAILED);
    expect(error?.message).toContain("Could not compare the entities with the existing tables");
    expect(error?.message).toContain("catalog unreadable");
  });

  it("throws for an unknown column type before creating the table", async () => {
    const error = await rejectionOf(async () => open.push(await register(database, [BflTypo])));

    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain('Unknown column type "varchr" on bfl_typos.code. Did you mean "varchar"?');

    const em = await register(database, [BflItemV1], { synchronize: false });
    open.push(em);
    const tables: any[] = await em.query(`SELECT name FROM sqlite_master WHERE name = 'bfl_typos'`);
    expect(tables).toEqual([]);
  });
});

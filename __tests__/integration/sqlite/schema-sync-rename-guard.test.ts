/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 컬럼 리네임 추론 가드 (V6-T1-3) — SQLite 파일 DB 재부팅 시나리오
 *
 * 재현: v1의 `legacyNote`에 "old secret"이 든 행을 남긴 채 v2에서 컬럼을
 * `bio`로 교체하고 재부팅하면, 예전 synchronize는 타입만 같으면 첫 후보를
 * 리네임으로 확정해서 그 행이 `bio: "old secret"`으로 되살아났습니다. 이제는
 * 이름이 같은 컬럼으로 읽히거나 `renamedFrom`이 명시된 경우에만 RENAME을
 * 실행하고, 나머지는 경고와 함께 선언대로 drop + add 합니다.
 */

import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getScannerInstance,
  resetScannerContainer,
} from "../../../src/scanner/ScannerContainer";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { Logger } from "../../../src/utils/Logger";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";
import { ColumnScanner } from "../../../src/scanner";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import type { SynchronizeOption } from "../../../src/core/DatabaseClientOptions";

const TABLE_NAME = "rename_guard_profile";

function resetState(): void {
  MetadataLayerRegistry.reset();
  resetScannerContainer();
}

/** Builds the entity for the table with one extra text column. */
function createEntity(
  column: { name: string; renamedFrom?: string },
): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, column.name);
  Column({
    type: "varchar",
    length: 100,
    nullable: true,
    ...(column.renamedFrom ? { renamedFrom: column.renamedFrom } : {}),
  })(DynClass.prototype, column.name);

  Entity()(DynClass);
  return DynClass;
}

/** Builds the entity with two extra text columns (the ambiguous shape). */
function createTwoColumnEntity(names: [string, string]): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  for (const name of names) {
    Reflect.defineMetadata("design:type", String, DynClass.prototype, name);
    Column({ type: "varchar", length: 100, nullable: true })(
      DynClass.prototype,
      name,
    );
  }

  Entity()(DynClass);
  return DynClass;
}

async function boot(
  dbPath: string,
  entityClass: new () => any,
  synchronize: SynchronizeOption = true,
): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register({
    type: "sqlite",
    database: dbPath,
    entities: [entityClass],
    synchronize,
    logging: false,
  });
  return em;
}

async function closeDb(): Promise<void> {
  try {
    await DatabaseClient.getInstance().close();
  } catch {
    // already closed
  }
}

async function columnNames(): Promise<string[]> {
  const connector = DatabaseClient.getInstance().getConnection();
  const rows: any = await connector.query(`PRAGMA table_info("${TABLE_NAME}")`);
  const normalized = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return normalized.map((r: any) => r.name);
}

function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  Logger.reset();
  Logger.setOutput((message) => lines.push(message));
  return { lines, stop: () => Logger.reset() };
}

describe("[Integration] SQLite synchronize — column rename guard", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `rename_guard_${Date.now()}_${Math.floor(Math.random() * 1e4)}.sqlite`,
    );
    resetState();
  });

  afterEach(async () => {
    await closeDb();
    resetState();
    Logger.reset();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ok */
    }
  });

  /** Boot 1: one row whose secret lives in the column about to be replaced. */
  async function seedLegacyNote(): Promise<void> {
    const V1 = createEntity({ name: "legacyNote" });
    const em = await boot(dbPath, V1);
    await em.save(V1, { legacyNote: "old secret" });
    await closeDb();
    resetState();
  }

  it("does not carry a dropped column's data into an unrelated new column", async () => {
    await seedLegacyNote();

    const V2 = createEntity({ name: "bio" });
    const capture = captureLogs();
    const em = await boot(dbPath, V2);
    capture.stop();

    expect(await columnNames()).toEqual(["id", "bio"]);

    const rows: any[] = await em.find(V2, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].bio).toBeNull();

    const warning = capture.lines.find((l) => l.includes("is being added while"));
    expect(warning).toBeDefined();
    expect(warning).toContain("legacyNote");
    expect(warning).toContain('renamedFrom: "legacyNote"');
  });

  it("renames and keeps the data when the entity declares renamedFrom", async () => {
    await seedLegacyNote();

    const V2 = createEntity({ name: "bio", renamedFrom: "legacyNote" });
    const em = await boot(dbPath, V2);

    expect(await columnNames()).toEqual(["id", "bio"]);

    const rows: any[] = await em.find(V2, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].bio).toBe("old secret");
  });

  it("renames without a hint when the names read as the same column", async () => {
    const V1 = createEntity({ name: "user_name" });
    const em1 = await boot(dbPath, V1);
    await em1.save(V1, { user_name: "ada" });
    await closeDb();
    resetState();

    const V2 = createEntity({ name: "userName" });
    const em2 = await boot(dbPath, V2);

    expect(await columnNames()).toEqual(["id", "userName"]);
    const rows: any[] = await em2.find(V2, {});
    expect(rows[0].userName).toBe("ada");
  });

  it("refuses an ambiguous pair and reports every candidate", async () => {
    const V1 = createTwoColumnEntity(["alpha", "beta"]);
    const em1 = await boot(dbPath, V1);
    await em1.save(V1, { alpha: "a", beta: "b" });
    await closeDb();
    resetState();

    const V2 = createTwoColumnEntity(["gamma", "delta"]);
    const capture = captureLogs();
    const em2 = await boot(dbPath, V2);
    capture.stop();

    expect((await columnNames()).sort()).toEqual([
      "delta",
      "gamma",
      "id",
    ]);
    const rows: any[] = await em2.find(V2, {});
    expect(rows[0].gamma).toBeNull();
    expect(rows[0].delta).toBeNull();

    const warnings = capture.lines.filter((l) =>
      l.includes("is being added while"),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("alpha");
    expect(warnings.join("\n")).toContain("beta");
  });

  it("refuses to rename at all under failOnDestructiveChange", async () => {
    const V1 = createEntity({ name: "user_name" });
    const em1 = await boot(dbPath, V1);
    await em1.save(V1, { user_name: "ada" });
    await closeDb();
    resetState();

    const V2 = createEntity({ name: "userName" });
    await expect(
      boot(dbPath, V2, {
        mode: true,
        failOnDestructiveChange: true,
        continueOnError: false,
      }),
    ).rejects.toMatchObject({
      code: OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE,
    });

    expect(await columnNames()).toEqual(["id", "user_name"]);
  });
});

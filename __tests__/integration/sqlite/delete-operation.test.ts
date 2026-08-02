/**
 * SQLite In-Memory: shipped em.delete() criteria contract (issue #404).
 *
 * Backfills __tests__/unit/delete-operation.test.ts, which used to assert a
 * locally re-declared `buildDeleteSql` copy instead of the shipped builder
 * (WriteExecutor.deleteEntity → resolveWhereClause). The copy had drifted
 * from the real contract in two ways this file pins down against real SQL:
 *
 *  - `null` criteria values: the copy silently dropped them; the shipped
 *    resolver emits `IS NULL` (#372 operator-object support).
 *  - empty/all-undefined criteria: the copy threw a plain Error; the shipped
 *    path throws DeleteWithoutConditionsError (and the guard runs BEFORE
 *    tenant scoping so a tenant predicate alone can never satisfy it).
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
} from "../../../src";
import { DeleteWithoutConditionsError } from "../../../src/errors";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

describe("[Integration] SQLite: em.delete() criteria contract", () => {
  let conn: TestConnectionResult;
  let User: any;
  const table = `del_op_${String(Date.now()).slice(-6)}`;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        MetadataLayerRegistry.reset();
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: table })
        class UserEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @Column({ type: "varchar", nullable: true }) role!: string | null;
          @Column({ type: "boolean" }) active!: boolean;
        }

        User = UserEntity;
        return { entities: [UserEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${table}"`);
  });

  async function seed(rows: Array<Partial<any>>): Promise<any[]> {
    const saved = [];
    for (const row of rows) {
      saved.push(await conn.em.save(User, { active: true, role: "member", ...row }));
    }
    return saved;
  }

  async function remaining(): Promise<any[]> {
    return conn.em.find(User, {});
  }

  it("단일 조건 — 해당 행만 삭제되고 affected가 정확해야 한다", async () => {
    const [a] = await seed([{ name: "A" }, { name: "B" }]);

    const result = await conn.em.delete(User, { id: a.id });

    expect(result.affected).toBe(1);
    const rows = await remaining();
    expect(rows.map((r: any) => r.name)).toEqual(["B"]);
  });

  it("다중 조건 — AND 교집합만 삭제되어야 한다", async () => {
    await seed([
      { name: "Guest1", role: "guest", active: false },
      { name: "Guest2", role: "guest", active: true },
      { name: "Member", role: "member", active: false },
    ]);

    const result = await conn.em.delete(User, { role: "guest", active: false });

    expect(result.affected).toBe(1);
    const names = (await remaining()).map((r: any) => r.name).sort();
    expect(names).toEqual(["Guest2", "Member"]);
  });

  it("undefined 값은 조건에서 무시되어야 한다", async () => {
    const [a] = await seed([{ name: "A" }, { name: "B" }]);

    const result = await conn.em.delete(User, {
      id: a.id,
      name: undefined,
    } as any);

    expect(result.affected).toBe(1);
    expect((await remaining()).map((r: any) => r.name)).toEqual(["B"]);
  });

  it("null 값은 IS NULL 조건이 되어야 한다 (무시 아님 — 구 유닛 사본과 다른 실제 계약)", async () => {
    await seed([
      { name: "HasRole", role: "admin" },
      { name: "NoRole1", role: null },
      { name: "NoRole2", role: null },
    ]);

    const result = await conn.em.delete(User, { role: null } as any);

    expect(result.affected).toBe(2);
    expect((await remaining()).map((r: any) => r.name)).toEqual(["HasRole"]);
  });

  it("빈 조건은 DeleteWithoutConditionsError를 던져야 한다", async () => {
    await seed([{ name: "Survivor" }]);

    await expect(conn.em.delete(User, {} as any)).rejects.toThrow(
      DeleteWithoutConditionsError,
    );
    expect((await remaining()).length).toBe(1);
  });

  it("모든 값이 undefined인 조건도 DeleteWithoutConditionsError를 던져야 한다", async () => {
    await seed([{ name: "Survivor" }]);

    await expect(
      conn.em.delete(User, { id: undefined, name: undefined } as any),
    ).rejects.toThrow(DeleteWithoutConditionsError);
    expect((await remaining()).length).toBe(1);
  });

  it("매칭 0건이면 affected 0을 반환하고 아무것도 삭제하지 않아야 한다", async () => {
    await seed([{ name: "Keep" }]);

    const result = await conn.em.delete(User, { name: "NoSuchRow" });

    expect(result.affected).toBe(0);
    expect((await remaining()).length).toBe(1);
  });

  it("SQL injection 시도 값이 데이터로 바인딩되어야 한다 (테이블 보존)", async () => {
    const payload = `'; DROP TABLE "${table}"; --`;
    await seed([{ name: payload }, { name: "Innocent" }]);

    const result = await conn.em.delete(User, { name: payload });

    expect(result.affected).toBe(1);
    // The table still exists and the untouched row is intact.
    const rows = await remaining();
    expect(rows.map((r: any) => r.name)).toEqual(["Innocent"]);
  });

  it("IN 배열 조건 — 배열 값은 IN 절이 되어야 한다", async () => {
    const [a, b] = await seed([{ name: "A" }, { name: "B" }, { name: "C" }]);

    const result = await conn.em.delete(User, { id: [a.id, b.id] } as any);

    expect(result.affected).toBe(2);
    expect((await remaining()).map((r: any) => r.name)).toEqual(["C"]);
  });

  it("연산자 객체 조건 — { gt } 필터가 적용되어야 한다 (#372)", async () => {
    const [a] = await seed([{ name: "A" }, { name: "B" }, { name: "C" }]);

    const result = await conn.em.delete(User, { id: { gt: a.id } } as any);

    expect(result.affected).toBe(2);
    expect((await remaining()).map((r: any) => r.name)).toEqual(["A"]);
  });
});

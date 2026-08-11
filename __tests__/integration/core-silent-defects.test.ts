/**
 * core 무음 결함 3건 (V4-T0-2) — MySQL / PostgreSQL 미러
 *
 * SQLite in-memory 재현 테스트의 실 드라이버 미러:
 * - find take/limit 0 → LIMIT 0 (수정 전: falsy 폴백으로 LIMIT이 사라져 전체 행 반환)
 * - save() 0행 UPDATE → EntityNotFoundError (수정 전: null 반환 + afterUpdate 유령 발화).
 *   값이 그대로인 UPDATE는 계속 성공해야 한다 — MySQL은 value-identical UPDATE에서
 *   affectedRows가 0일 수 있어 존재 프로브가 이 케이스를 지킨다 (이 미러의 핵심).
 * - afterTransactionCommit 예외 → 롤백 훅 미발화 + 커밋 유지 (수정 전: 롤백 경로 진입)
 */

import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../src";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import { EntityNotFoundError } from "../../src/errors/EntityNotFoundError";
import type { EntitySubscriber } from "../../src/core/EntitySubscriber";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe.each(getTestDrivers())(
  "[Integration] $label: core 무음 결함 3건 (V4-T0-2)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let User: any;
    const table = `silent_defects_${type}_${String(Date.now()).slice(-6)}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          MetadataLayerRegistry.reset();
          getScannerInstance(ColumnScanner).clear();

          @Entity({ name: table })
          class UserEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() name!: string;
          }

          User = UserEntity;
          return { entities: [UserEntity] };
        },
      );
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    const registered: EntitySubscriber<any>[] = [];
    function subscribe(sub: EntitySubscriber<any>): void {
      conn.em.addSubscriber(sub);
      registered.push(sub);
    }

    afterEach(() => {
      while (registered.length) conn.em.removeSubscriber(registered.pop()!);
    });

    beforeEach(async () => {
      await truncateTestTable(table);
    });

    describe("find take/limit 0", () => {
      it("take: 0과 limit: 0은 LIMIT 0이어야 한다", async () => {
        await conn.em.save(User, { name: "a" });
        await conn.em.save(User, { name: "b" });

        expect(await conn.em.find(User, { take: 0 })).toEqual([]);
        expect(await conn.em.find(User, { limit: 0 })).toEqual([]);
        expect((await conn.em.find(User, { take: 1 })).length).toBe(1);
      });
    });

    describe("save() 0행 UPDATE", () => {
      it("존재하지 않는 PK로 save() → EntityNotFoundError, afterUpdate 미발화", async () => {
        const fired: string[] = [];
        subscribe({
          listenTo: () => User,
          afterUpdate: () => { fired.push("afterUpdate"); },
        });

        await expect(
          conn.em.save(User, { id: 99999, name: "ghost" }),
        ).rejects.toThrow(EntityNotFoundError);
        expect(fired).toEqual([]);
      });

      it("값이 그대로인 save()는 성공해야 한다 (MySQL affectedRows 0 — 존재 프로브)", async () => {
        const saved: any = await conn.em.save(User, { name: "same" });

        const result: any = await conn.em.save(User, {
          id: saved.id,
          name: "same",
        });

        expect(result).toMatchObject({ id: saved.id, name: "same" });
      });
    });

    describe("post-commit 구독자 예외", () => {
      it("afterTransactionCommit 예외 → 원본 전파, 롤백 훅 미발화, 커밋 유지", async () => {
        const events: string[] = [];
        subscribe({
          listenTo: () => User,
          afterTransactionCommit: () => {
            events.push("afterTxCommit");
            throw new Error("webhook down");
          },
          beforeTransactionRollback: () => { events.push("beforeTxRollback"); },
          afterTransactionRollback: () => { events.push("afterTxRollback"); },
        });

        await expect(
          conn.em.transaction(async (tem) => {
            await tem.save(User, { name: "Durable" });
          }),
        ).rejects.toThrow("webhook down");

        expect(events).toEqual(["afterTxCommit"]);

        const rows: any[] = await conn.em.find(User, {});
        expect(rows.length).toBe(1);
        expect(rows[0].name).toBe("Durable");
      });
    });
  },
);

/**
 * SQLite In-Memory: TABLE_PER_CLASS 다형 루트 연산 통합 테스트
 *
 * TPC 루트 테이블은 자기 행이 없다(계층의 행은 콘크리트 테이블마다 있다).
 * find()는 UNION ALL로 전 서브타입을 읽지만 count/집계/커서/findAndCount/
 * findWithPage와 delete/updateMany/softDelete/restore/deleteMany/increment는
 * 빈 루트 테이블만 보고 무음 0을 반환했다(V6-T0-5). 이 파일은 루트 대상
 * 연산이 전부 전 서브타입을 대상으로 동작하는지 고정한다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  DeletedAt,
  OrmError,
  OrmErrorCode,
  sql,
} from "../../../../src";
import type { Logger } from "../../../../src/utils/Logger";
import { getScannerInstance } from "../../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

describe("[Integration] SQLite: TPC polymorphic root operations", () => {
  let conn: TestConnectionResult;
  let em: any;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        clearScanners();

        @Entity({ name: "tpc_ops_pay" })
        @Inheritance({ strategy: "TABLE_PER_CLASS" })
        @DiscriminatorColumn({ name: "dtype", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
          @Column({ type: "varchar", nullable: true }) note?: string | null;
          @DeletedAt() deletedAt?: Date | null;
        }

        @Entity({ name: "tpc_ops_cc" })
        @DiscriminatorValue("cc")
        class CreditCardPaymentEntity extends PaymentEntity {
          @Column() cardNumber!: string;
        }

        @Entity({ name: "tpc_ops_bt" })
        @DiscriminatorValue("bt")
        class BankTransferPaymentEntity extends PaymentEntity {
          @Column() bankCode!: string;
        }

        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );
    em = conn.em;

    // Two rows per subtype: each table numbers its own PKs, so ids 1 and 2
    // exist once per subtype (the PK collision TPC does not prevent).
    await em.save(CreditCardPayment, { amount: 10, cardNumber: "c1" });
    await em.save(CreditCardPayment, { amount: 20, cardNumber: "c2" });
    await em.save(BankTransferPayment, { amount: 30, bankCode: "b1" });
    await em.save(BankTransferPayment, { amount: 40, bankCode: "b2" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  const shape = (rows: any[]) =>
    rows.map((r) => `${r.constructor.name}#${r.id}`).sort();

  describe("reads on the root", () => {
    it("find() reads every subtype through UNION ALL (baseline)", async () => {
      const rows = await em.find(Payment, {});
      expect(rows).toHaveLength(4);
      expect(shape(rows)).toEqual([
        "BankTransferPaymentEntity#1",
        "BankTransferPaymentEntity#2",
        "CreditCardPaymentEntity#1",
        "CreditCardPaymentEntity#2",
      ]);
    });

    it("count() spans the hierarchy instead of the empty root table", async () => {
      expect(await em.count(Payment)).toBe(4);
      expect(await em.count(Payment, { amount: { gte: 30 } })).toBe(2);
      expect(await em.count(Payment, { id: 1 })).toBe(2);
    });

    it("exists() sees subtype rows", async () => {
      expect(await em.exists(Payment, { amount: 40 })).toBe(true);
      expect(await em.exists(Payment, { amount: 999 })).toBe(false);
    });

    it("sum/avg/min/max aggregate over every subtype", async () => {
      expect(await em.sum(Payment, "amount")).toBe(100);
      expect(await em.avg(Payment, "amount")).toBe(25);
      expect(await em.min(Payment, "amount")).toBe(10);
      expect(await em.max(Payment, "amount")).toBe(40);
      expect(await em.sum(Payment, "amount", { amount: { lt: 30 } })).toBe(30);
    });

    it("findAndCount() pairs the UNION rows with a matching total", async () => {
      const [rows, total] = await em.findAndCount(Payment, {
        where: { amount: { gte: 20 } },
      });
      expect(rows).toHaveLength(3);
      expect(total).toBe(3);
    });

    it("findWithPage() reports the hierarchy total", async () => {
      const page = await em.findWithPage(Payment, { page: 1, pageSize: 3 });
      expect(page.data).toHaveLength(3);
      expect(page.total).toBe(4);
      expect(page.totalPages).toBe(2);
      expect(page.hasNextPage).toBe(true);
    });

    it("SelectQueryBuilder getCount()/getMany() on the root agree with find()", async () => {
      const qb = em.createQueryBuilder(Payment, "p");
      expect(await qb.getCount()).toBe(4);
      expect(shape(await em.createQueryBuilder(Payment, "p").getMany())).toEqual(
        shape(await em.find(Payment, {})),
      );
    });

    it("findOne() by PK warns once when several subtypes share the key", async () => {
      const logger = (em as any).logger as Logger;
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const first = await em.findOne(Payment, { where: { id: 1 } });
        expect(first).not.toBeNull();
        await em.findOne(Payment, { where: { id: 2 } });
        const tpcWarnings = warnSpy.mock.calls.filter((c) =>
          String(c[0]).includes("TABLE_PER_CLASS subtype"),
        );
        expect(tpcWarnings).toHaveLength(1);

        // A non-PK lookup is not an identity question: no warning.
        warnSpy.mockClear();
        await em.findOne(Payment, { where: { amount: 10 } });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("cursor pagination on the root", () => {
    it("pages every subtype row exactly once despite PK collisions (default PK order)", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await em.findWithCursor(Payment, { take: 1, cursor });
        seen.push(...shape(page.data));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        if (pages > 10) throw new Error("cursor loop did not terminate");
      } while (cursor);
      expect(pages).toBe(4);
      expect([...seen].sort()).toEqual([
        "BankTransferPaymentEntity#1",
        "BankTransferPaymentEntity#2",
        "CreditCardPaymentEntity#1",
        "CreditCardPaymentEntity#2",
      ]);
    });

    it("orders by (pk, discriminator) so a page never mixes cursor ties", async () => {
      const first = await em.findWithCursor(Payment, { take: 2 });
      expect(first.data.map((r: any) => [r.id, r.dtype])).toEqual([
        [1, "bt"],
        [1, "cc"],
      ]);
      const second = await em.findWithCursor(Payment, { take: 2, cursor: first.nextCursor });
      expect(second.data.map((r: any) => [r.id, r.dtype])).toEqual([
        [2, "bt"],
        [2, "cc"],
      ]);
      expect(second.hasNextPage).toBe(false);
    });

    it("pages a non-PK order column with DESC direction without skipping rows", async () => {
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await em.findWithCursor(Payment, {
          take: 3,
          orderBy: "amount",
          direction: "DESC",
          cursor,
        });
        seen.push(...page.data.map((r: any) => r.amount));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual([40, 30, 20, 10]);
    });

    it("instantiates each row's subtype and honors where", async () => {
      const page = await em.findWithCursor(Payment, {
        take: 10,
        where: { amount: { gte: 30 } },
      });
      expect(page.data).toHaveLength(2);
      expect(page.data.every((r: any) => r instanceof BankTransferPayment)).toBe(true);
      expect(page.data[0].bankCode).toBe("b1");
    });
  });

  describe("writes on the root", () => {
    // Rows with amounts in the 1000 range belong to this block only.
    beforeAll(async () => {
      await em.save(CreditCardPayment, { amount: 1000, cardNumber: "w-c1" });
      await em.save(CreditCardPayment, { amount: 1001, cardNumber: "w-c2" });
      await em.save(BankTransferPayment, { amount: 1000, bankCode: "w-b1" });
      await em.save(BankTransferPayment, { amount: 1002, bankCode: "w-b2" });
    });

    it("updateMany() updates matching rows in every concrete table", async () => {
      const result = await em.updateMany(
        Payment,
        { note: "bulk" },
        { where: { amount: 1000 } },
      );
      expect(result.affected).toBe(2);

      const updated = await em.find(Payment, { where: { note: "bulk" } });
      expect(shape(updated).map((s) => s.split("#")[0])).toEqual([
        "BankTransferPaymentEntity",
        "CreditCardPaymentEntity",
      ]);
    });

    it("update() / increment() / decrement() span the hierarchy", async () => {
      expect((await em.update(Payment, { amount: 1001 }, { note: "one" })).affected).toBe(1);
      expect((await em.increment(Payment, { note: "bulk" }, "amount", 5)).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1005 })).toBe(2);
      expect((await em.decrement(Payment, { note: "bulk" }, "amount", 5)).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(2);
    });

    it("updateMany() with orderBy/limit on the root is rejected explicitly", async () => {
      let error: unknown;
      try {
        await em.updateMany(
          Payment,
          { note: "x" },
          { where: { amount: 1000 }, limit: 1 },
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OrmError);
      expect((error as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect((error as Error).message).toContain("TABLE_PER_CLASS");
      // Nothing was written.
      expect(await em.count(Payment, { note: "x" })).toBe(0);
    });

    it("createUpdateBuilder() on the root runs per concrete table and rejects limit", async () => {
      const result = await em
        .createUpdateBuilder(Payment, "p")
        .set({ note: "built" })
        .where(sql`"amount" = ${1000}`)
        .execute();
      expect(result.affected).toBe(2);
      expect(await em.count(Payment, { note: "built" })).toBe(2);

      let error: unknown;
      try {
        await em
          .createUpdateBuilder(Payment, "p")
          .set({ note: "bulk" })
          .where(sql`"amount" = ${1000}`)
          .limit(1)
          .execute();
      } catch (e) {
        error = e;
      }
      expect((error as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);

      // Put the rows back the way the next tests expect them.
      expect(
        (await em.updateMany(Payment, { note: "bulk" }, { where: { note: "built" } })).affected,
      ).toBe(2);
    });

    it("softDelete() / restore() stamp rows in every concrete table", async () => {
      const trashed = await em.softDelete(Payment, { amount: 1000 });
      expect(trashed.affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(0);
      expect(await em.count(Payment, { amount: 1000 }, { withDeleted: true })).toBe(2);
      expect(await em.find(Payment, { where: { amount: 1000 } })).toHaveLength(0);

      // Already-trashed rows are not re-stamped.
      expect((await em.softDelete(Payment, { amount: 1000 })).affected).toBe(0);

      const restored = await em.restore(Payment, { amount: 1000 });
      expect(restored.affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(2);
    });

    it("delete() removes matching rows from every concrete table", async () => {
      const before = await em.count(Payment);
      const result = await em.delete(Payment, { amount: 1000 });
      expect(result.affected).toBe(2);
      expect(await em.count(Payment)).toBe(before - 2);
      expect(await em.find(Payment, { where: { amount: 1000 } })).toHaveLength(0);
    });

    it("deleteMany() by PK removes the key from every concrete table", async () => {
      // amounts 1001 (cc#3) and 1002 (bt#3) share id 3.
      const targets = await em.find(Payment, { where: { amount: { gte: 1001 } } });
      expect(targets).toHaveLength(2);
      const ids = [...new Set(targets.map((r: any) => r.id))];
      expect(ids).toHaveLength(1);

      const result = await em.deleteMany(Payment, ids);
      expect(result.affected).toBe(2);
      expect(await em.count(Payment, { amount: { gte: 1001 } })).toBe(0);
      // The seed rows (ids 1 and 2 per subtype) are untouched.
      expect(await em.count(Payment)).toBe(4);
    });

    it("subclass writes still touch only their own table", async () => {
      const cc: any = await em.save(CreditCardPayment, { amount: 2000, cardNumber: "own" });
      const bt: any = await em.save(BankTransferPayment, { amount: 2000, bankCode: "own" });
      expect((await em.delete(CreditCardPayment, { amount: 2000 })).affected).toBe(1);
      expect(await em.count(Payment, { amount: 2000 })).toBe(1);
      expect((await em.delete(BankTransferPayment, { id: bt.id })).affected).toBe(1);
      expect(await em.count(Payment, { amount: 2000 })).toBe(0);
      expect(cc.id).toBeGreaterThan(0);
    });
  });
});

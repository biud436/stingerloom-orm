/**
 * MySQL / PostgreSQL: TABLE_PER_CLASS 다형 루트 연산 듀얼 드라이버 통합 테스트
 *
 * 루트 대상 count/집계/커서/findAndCount/findWithPage와
 * delete/updateMany/softDelete/restore/deleteMany가 빈 루트 테이블이 아니라
 * 전 콘크리트 테이블을 대상으로 동작하는지 실 드라이버에서 고정한다
 * (SQLite 버전: __tests__/integration/sqlite/inheritance/tpc-polymorphic-ops.test.ts).
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "../helpers/driver-config";
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
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTable(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-6)}`;
}

const drivers = getTestDrivers();

describe.each(drivers)(
  "[Integration] $label: TPC polymorphic root operations",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: any;
    let Payment: any;
    let CreditCardPayment: any;
    let BankTransferPayment: any;
    let rootTable: string;
    let ccTable: string;
    let btTable: string;

    const shape = (rows: any[]) =>
      rows.map((r) => `${r.constructor.name}#${r.id}`).sort();

    beforeAll(async () => {
      rootTable = shortTable("tpcop_p");
      ccTable = shortTable("tpcop_cc");
      btTable = shortTable("tpcop_bt");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          clearScanners();

          @Entity({ name: rootTable })
          @Inheritance({ strategy: "TABLE_PER_CLASS" })
          @DiscriminatorColumn({ name: "dtype", type: "varchar", length: 50 })
          class PaymentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() amount!: number;
            @Column({ type: "varchar", length: 255, nullable: true }) note?: string | null;
            @DeletedAt() deletedAt?: Date | null;
          }

          @Entity({ name: ccTable })
          @DiscriminatorValue("cc")
          class CreditCardPaymentEntity extends PaymentEntity {
            @Column() cardNumber!: string;
          }

          @Entity({ name: btTable })
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

      // Two rows per subtype; each table numbers its own PKs (1, 2 twice).
      await em.save(CreditCardPayment, { amount: 10, cardNumber: "c1" });
      await em.save(CreditCardPayment, { amount: 20, cardNumber: "c2" });
      await em.save(BankTransferPayment, { amount: 30, bankCode: "b1" });
      await em.save(BankTransferPayment, { amount: 40, bankCode: "b2" });
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try { await dropTestTable(ccTable); } catch {}
      try { await dropTestTable(btTable); } catch {}
      try { await dropTestTable(rootTable); } catch {}
      await conn.cleanup();
    }, 15000);

    it("count()/exists()/aggregates on the root span every concrete table", async () => {
      expect(await em.count(Payment)).toBe(4);
      expect(await em.count(Payment, { id: 1 })).toBe(2);
      expect(await em.exists(Payment, { amount: 40 })).toBe(true);
      expect(await em.sum(Payment, "amount")).toBe(100);
      expect(await em.avg(Payment, "amount")).toBe(25);
      expect(await em.min(Payment, "amount")).toBe(10);
      expect(await em.max(Payment, "amount")).toBe(40);
    });

    it("findAndCount()/findWithPage() totals match the UNION rows", async () => {
      const [rows, total] = await em.findAndCount(Payment, {
        where: { amount: { gte: 20 } },
      });
      expect(rows).toHaveLength(3);
      expect(total).toBe(3);

      const page = await em.findWithPage(Payment, { page: 1, pageSize: 3 });
      expect(page.data).toHaveLength(3);
      expect(page.total).toBe(4);
      expect(page.hasNextPage).toBe(true);
    });

    it("findWithCursor() pages every subtype row exactly once despite PK collisions", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: any = await em.findWithCursor(Payment, { take: 1, cursor });
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

      const desc: number[] = [];
      cursor = undefined;
      do {
        const page: any = await em.findWithCursor(Payment, {
          take: 3,
          orderBy: "amount",
          direction: "DESC",
          cursor,
        });
        desc.push(...page.data.map((r: any) => Number(r.amount)));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(desc).toEqual([40, 30, 20, 10]);
    });

    it("updateMany()/softDelete()/restore()/delete()/deleteMany() on the root run per concrete table", async () => {
      await em.save(CreditCardPayment, { amount: 1000, cardNumber: "w-c1" });
      await em.save(BankTransferPayment, { amount: 1000, bankCode: "w-b1" });
      await em.save(CreditCardPayment, { amount: 1001, cardNumber: "w-c2" });
      await em.save(BankTransferPayment, { amount: 1002, bankCode: "w-b2" });

      expect(
        (await em.updateMany(Payment, { note: "bulk" }, { where: { amount: 1000 } })).affected,
      ).toBe(2);
      expect(await em.count(Payment, { note: "bulk" })).toBe(2);

      expect((await em.increment(Payment, { note: "bulk" }, "amount", 5)).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1005 })).toBe(2);
      expect((await em.decrement(Payment, { note: "bulk" }, "amount", 5)).affected).toBe(2);

      let error: unknown;
      try {
        await em.updateMany(Payment, { note: "x" }, { where: { amount: 1000 }, limit: 1 });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OrmError);
      expect((error as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);

      expect((await em.softDelete(Payment, { amount: 1000 })).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(0);
      expect(await em.count(Payment, { amount: 1000 }, { withDeleted: true })).toBe(2);
      expect((await em.restore(Payment, { amount: 1000 })).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(2);

      expect((await em.delete(Payment, { amount: 1000 })).affected).toBe(2);
      expect(await em.count(Payment, { amount: 1000 })).toBe(0);

      const rest = await em.find(Payment, { where: { amount: { gte: 1001 } } });
      const ids = [...new Set(rest.map((r: any) => r.id))];
      expect(ids).toHaveLength(1);
      expect((await em.deleteMany(Payment, ids)).affected).toBe(2);
      expect(await em.count(Payment)).toBe(4);
    });
  },
);

/**
 * MySQL / PostgreSQL: Table Per Class (TPC) 듀얼 드라이버 통합 테스트
 *
 * CRUD + 다형성 UNION ALL 쿼리 + 릴레이션 역직렬화 검증
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
  "[Integration] $label: TPC Inheritance",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let Payment: any;
    let CreditCardPayment: any;
    let BankTransferPayment: any;
    let rootTable: string;
    let ccTable: string;
    let btTable: string;

    beforeAll(async () => {
      rootTable = shortTable("tpc_p");
      ccTable = shortTable("tpc_cc");
      btTable = shortTable("tpc_bt");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          clearScanners();

          @Entity({ name: rootTable })
          @Inheritance({ strategy: "TABLE_PER_CLASS" })
          @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
          class PaymentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() amount!: number;
          }

          @Entity({ name: ccTable })
          @DiscriminatorValue("credit_card")
          class CreditCardPaymentEntity extends PaymentEntity {
            @Column() cardNumber!: string;
          }

          @Entity({ name: btTable })
          @DiscriminatorValue("bank_transfer")
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
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try { await dropTestTable(ccTable); } catch {}
      try { await dropTestTable(btTable); } catch {}
      try { await dropTestTable(rootTable); } catch {}
      await conn.cleanup();
    }, 15000);

    // ── INSERT ────────────────────────────────────────────

    it("should insert into independent child tables", async () => {
      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 500,
        cardNumber: "9999-TPC",
      });
      expect(cc.id).toBeGreaterThan(0);

      const bt: any = await conn.em.save(BankTransferPayment, {
        amount: 600,
        bankCode: "TPC-SWIFT",
      });
      expect(bt.id).toBeGreaterThan(0);

      await conn.em.save(Payment, { amount: 50 });
    });

    // ── SELECT ────────────────────────────────────────────

    it("should find TPC child from its own table", async () => {
      const results = await conn.em.find(CreditCardPayment, {});
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);

      const cc = arr[0] as any;
      expect(cc.amount).toBeDefined();
      expect(cc.cardNumber).toBeDefined();
    });

    it("should find ALL payments via UNION ALL with correct instanceof", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];
      expect(allArray.length).toBeGreaterThanOrEqual(3);

      const cc = allArray.filter((p) => p instanceof CreditCardPayment);
      const bt = allArray.filter((p) => p instanceof BankTransferPayment);
      expect(cc.length).toBeGreaterThanOrEqual(1);
      expect(bt.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter child by WHERE in its own table", async () => {
      const results = await conn.em.find(CreditCardPayment, {
        where: { amount: 500 },
      });
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      expect((arr[0] as any).cardNumber).toBe("9999-TPC");
    });

    // ── UPDATE ────────────────────────────────────────────

    it("should update TPC child in its own table", async () => {
      const cc: any = await conn.em.findOne(CreditCardPayment, { where: { amount: 500 } });
      expect(cc).toBeDefined();
      cc.amount = 550;
      await conn.em.save(CreditCardPayment, cc);

      const reloaded: any = await conn.em.findOne(CreditCardPayment, { where: { id: cc.id } });
      expect(reloaded.amount).toBe(550);
    });

    // ── DELETE ────────────────────────────────────────────

    it("should delete from the child's own table", async () => {
      const saved: any = await conn.em.save(BankTransferPayment, {
        amount: 888,
        bankCode: "DEL_TPC",
      });

      await conn.em.delete(BankTransferPayment, { id: saved.id } as any);

      const found = await conn.em.findOne(BankTransferPayment, { where: { id: saved.id } });
      expect(found == null).toBe(true);
    });
  },
);

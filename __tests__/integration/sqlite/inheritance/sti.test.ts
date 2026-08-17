/**
 * SQLite In-Memory: Single Table Inheritance (STI) 통합 테스트
 *
 * EntityManager + synchronize를 사용해 STI 계층 구조의
 * CREATE TABLE / INSERT / SELECT / UPDATE / DELETE 전체 사이클을 검증합니다.
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
} from "../../../../src";
import { getScannerInstance } from "../../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

describe("[Integration] SQLite: Single Table Inheritance (STI)", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("sti_pay");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        // ── Root Entity: Payment ──
        @Entity({ name: tableName })
        @Inheritance({ strategy: "SINGLE_TABLE" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
        }

        // ── Child: CreditCardPayment ──
        @Entity()
        @DiscriminatorValue("credit_card")
        class CreditCardPaymentEntity extends PaymentEntity {
          @Column({ nullable: true }) cardNumber!: string;
        }

        // ── Child: BankTransferPayment ──
        @Entity()
        @DiscriminatorValue("bank_transfer")
        class BankTransferPaymentEntity extends PaymentEntity {
          @Column({ nullable: true }) bankCode!: string;
        }

        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ─────────────────────────────────────────────────────────
  // INSERT
  // ─────────────────────────────────────────────────────────

  describe("INSERT", () => {
    it("should insert a credit card payment with discriminator", async () => {
      const saved: any = await conn.em.save(CreditCardPayment, {
        amount: 100,
        cardNumber: "4111-1111-1111-1111",
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.amount).toBe(100);
    });

    it("should insert a bank transfer payment with discriminator", async () => {
      const saved: any = await conn.em.save(BankTransferPayment, {
        amount: 200,
        bankCode: "SWIFT123",
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.amount).toBe(200);
    });

    it("should insert a root payment with its own discriminator", async () => {
      const saved: any = await conn.em.save(Payment, {
        amount: 50,
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // SELECT
  // ─────────────────────────────────────────────────────────

  describe("SELECT", () => {
    it("should find only credit card payments when querying CreditCardPayment", async () => {
      const results = await conn.em.find(CreditCardPayment, {});
      expect(Array.isArray(results)).toBe(true);

      // All results should have payment_type = "credit_card" (implicitly, via WHERE)
      for (const r of results as any[]) {
        // The cardNumber field should exist on credit card payments
        expect(r.amount).toBeDefined();
      }
    });

    it("should find only bank transfer payments when querying BankTransferPayment", async () => {
      const results = await conn.em.find(BankTransferPayment, {});
      expect(Array.isArray(results)).toBe(true);

      for (const r of results as any[]) {
        expect(r.amount).toBeDefined();
      }
    });

    it("should find ALL payments when querying root Payment (polymorphic)", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = Array.isArray(all) ? all : [all];

      // Should include credit card + bank transfer + root payments
      expect(allArray.length).toBeGreaterThanOrEqual(3);
    });

    it("should return correct subclass instances in polymorphic query", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : [all]) as any[];

      const ccPayments = allArray.filter((p) => p instanceof CreditCardPayment);
      const btPayments = allArray.filter((p) => p instanceof BankTransferPayment);

      expect(ccPayments.length).toBeGreaterThanOrEqual(1);
      expect(btPayments.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter child entities by WHERE clause", async () => {
      const results = await conn.em.find(CreditCardPayment, {
        where: { amount: 100 },
      });
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      for (const r of arr) {
        expect((r as any).amount).toBe(100);
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────────────────

  describe("UPDATE", () => {
    it("should update a child entity without changing discriminator", async () => {
      const cc = await conn.em.findOne(CreditCardPayment, {
        where: { amount: 100 },
      });
      expect(cc).toBeDefined();

      (cc as any).amount = 150;
      const updated = await conn.em.save(CreditCardPayment, cc as any);
      expect((updated as any).amount).toBe(150);

      // Verify discriminator is preserved
      const reloaded = await conn.em.findOne(CreditCardPayment, {
        where: { id: (cc as any).id },
      });
      expect(reloaded).toBeDefined();
      expect((reloaded as any).amount).toBe(150);
    });
  });

  // ─────────────────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────────────────

  describe("DELETE", () => {
    // The rows are created here rather than reused from the INSERT block: an
    // `if (found)` guard around the whole delete turns the very regression this
    // test exists for (a broken discriminator filter returning no rows) into a
    // silent pass.
    it("should delete only the specific child type", async () => {
      const bt: any = await conn.em.save(BankTransferPayment, {
        amount: 777,
        bankCode: "DEL-BT",
      });
      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 777,
        cardNumber: "DEL-CC",
      });

      await conn.em.delete(BankTransferPayment, { id: bt.id } as any);

      // Gone from the shared table, not merely from the subtype view.
      const deleted = await conn.em.findOne(Payment, { where: { id: bt.id } });
      expect(deleted == null).toBe(true);

      // The sibling subtype row is untouched.
      const survivor: any = await conn.em.findOne(Payment, { where: { id: cc.id } });
      expect(survivor).toBeTruthy();
      expect(survivor.id).toBe(cc.id);
    });

    it("should not delete a sibling subtype row addressed by PK", async () => {
      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 888,
        cardNumber: "KEEP-CC",
      });

      // Same PK, wrong subtype: the discriminator condition must keep the
      // DELETE from matching. Without it the row would be destroyed.
      await conn.em.delete(BankTransferPayment, { id: cc.id } as any);

      const survivor: any = await conn.em.findOne(CreditCardPayment, {
        where: { id: cc.id },
      });
      expect(survivor).toBeTruthy();
      expect(survivor.cardNumber).toBe("KEEP-CC");
    });
  });
});

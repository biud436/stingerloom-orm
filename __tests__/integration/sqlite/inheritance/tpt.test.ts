/**
 * SQLite In-Memory: Table Per Type (TPT / JOINED) 통합 테스트
 *
 * EntityManager + synchronize를 사용해 TPT 계층 구조의
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

describe("[Integration] SQLite: Table Per Type (TPT / JOINED)", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let rootTableName: string;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("tpt_pay");
    ccTableName = shortTableName("tpt_cc");
    btTableName = shortTableName("tpt_bt");

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
        @Entity({ name: rootTableName })
        @Inheritance({ strategy: "JOINED" })
        @DiscriminatorColumn({
          name: "payment_type",
          type: "varchar",
          length: 50,
        })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
        }

        // ── Child: CreditCardPayment ──
        @Entity({ name: ccTableName })
        @DiscriminatorValue("credit_card")
        class CreditCardPaymentEntity extends PaymentEntity {
          @Column() cardNumber!: string;
        }

        // ── Child: BankTransferPayment ──
        @Entity({ name: btTableName })
        @DiscriminatorValue("bank_transfer")
        class BankTransferPaymentEntity extends PaymentEntity {
          @Column() bankCode!: string;
        }

        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [
            PaymentEntity,
            CreditCardPaymentEntity,
            BankTransferPaymentEntity,
          ],
        };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ─────────────────────────────────────────────────────────
  // TABLE STRUCTURE
  // ─────────────────────────────────────────────────────────

  describe("TABLE STRUCTURE", () => {
    it("should create separate tables for root and children", async () => {
      const driver = conn.em.getDriver()!;
      const rootExists = await driver.hasTable(rootTableName);
      const ccExists = await driver.hasTable(ccTableName);
      const btExists = await driver.hasTable(btTableName);

      expect(rootExists?.length).toBeGreaterThan(0);
      expect(ccExists?.length).toBeGreaterThan(0);
      expect(btExists?.length).toBeGreaterThan(0);
    });

    it("root table should have discriminator column", async () => {
      const driver = conn.em.getDriver()!;
      const hasDiscCol = await driver.hasColumn(rootTableName, "payment_type");
      expect(hasDiscCol).toBeTruthy();
    });

    it("child table should NOT have parent-only columns", async () => {
      const driver = conn.em.getDriver()!;
      // 'amount' belongs to the parent, not the child
      const ccHasAmount = await driver.hasColumn(ccTableName, "amount");
      expect(ccHasAmount).toBeFalsy();
    });

    it("child table should have its own columns + PK", async () => {
      const driver = conn.em.getDriver()!;
      const ccHasId = await driver.hasColumn(ccTableName, "id");
      const ccHasCard = await driver.hasColumn(ccTableName, "cardNumber");
      expect(ccHasId).toBeTruthy();
      expect(ccHasCard).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────
  // INSERT
  // ─────────────────────────────────────────────────────────

  describe("INSERT", () => {
    it("should insert a credit card payment into both tables", async () => {
      const saved: any = await conn.em.save(CreditCardPayment, {
        amount: 100,
        cardNumber: "4111-1111-1111-1111",
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.amount).toBe(100);
      expect(saved.cardNumber).toBe("4111-1111-1111-1111");
    });

    it("should insert a bank transfer payment", async () => {
      const saved: any = await conn.em.save(BankTransferPayment, {
        amount: 200,
        bankCode: "SWIFT123",
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.amount).toBe(200);
      expect(saved.bankCode).toBe("SWIFT123");
    });

    it("should insert a root payment", async () => {
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
    it("should find credit card payment with parent columns via JOIN", async () => {
      const results = await conn.em.find(CreditCardPayment, {});
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);

      const cc = arr[0] as any;
      expect(cc.amount).toBeDefined();
      expect(cc.cardNumber).toBeDefined();
    });

    it("should find bank transfer payment with parent columns", async () => {
      const results = await conn.em.find(BankTransferPayment, {});
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);

      const bt = arr[0] as any;
      expect(bt.amount).toBeDefined();
      expect(bt.bankCode).toBeDefined();
    });

    it("should find ALL payments when querying root (polymorphic)", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = Array.isArray(all) ? all : all ? [all] : [];

      // Should include credit card + bank transfer + root payments
      expect(allArray.length).toBeGreaterThanOrEqual(3);
    });

    it("should return correct subclass instances in polymorphic query", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];

      const ccPayments = allArray.filter((p) => p instanceof CreditCardPayment);
      const btPayments = allArray.filter(
        (p) => p instanceof BankTransferPayment,
      );

      expect(ccPayments.length).toBeGreaterThanOrEqual(1);
      expect(btPayments.length).toBeGreaterThanOrEqual(1);

      // Verify child-specific fields are populated
      for (const cc of ccPayments) {
        expect(cc.cardNumber).toBeDefined();
      }
      for (const bt of btPayments) {
        expect(bt.bankCode).toBeDefined();
      }
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
    it("should update parent column (amount) on child entity", async () => {
      const cc = (await conn.em.findOne(CreditCardPayment, {
        where: { amount: 100 },
      })) as any;
      expect(cc).toBeDefined();

      cc.amount = 150;
      const updated = (await conn.em.save(CreditCardPayment, cc)) as any;
      expect(updated.amount).toBe(150);

      const reloaded = (await conn.em.findOne(CreditCardPayment, {
        where: { id: cc.id },
      })) as any;
      expect(reloaded).toBeDefined();
      expect(reloaded.amount).toBe(150);
      expect(reloaded.cardNumber).toBe("4111-1111-1111-1111");
    });

    it("should update child column (cardNumber) on child entity", async () => {
      const cc = (await conn.em.findOne(CreditCardPayment, {})) as any;
      expect(cc).toBeDefined();

      cc.cardNumber = "5555-5555-5555-5555";
      const updated = (await conn.em.save(CreditCardPayment, cc)) as any;
      expect(updated.cardNumber).toBe("5555-5555-5555-5555");
    });
  });

  // ─────────────────────────────────────────────────────────
  // DELETE
  // ─────────────────────────────────────────────────────────

  describe("DELETE", () => {
    it("should delete from both child and parent tables", async () => {
      // Insert a new one to delete
      const saved: any = await conn.em.save(BankTransferPayment, {
        amount: 999,
        bankCode: "DELETE_ME",
      });
      expect(saved.id).toBeGreaterThan(0);

      await conn.em.delete(BankTransferPayment, { id: saved.id } as any);

      // Verify not found in child entity query
      const found = await conn.em.findOne(BankTransferPayment, {
        where: { id: saved.id },
      });
      expect(found == null).toBe(true);

      // Also verify it's gone from root polymorphic query
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];
      const deleted = allArray.find((p: any) => p.id === saved.id);
      expect(deleted).toBeUndefined();
    });
  });
});

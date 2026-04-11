/**
 * MySQL / PostgreSQL: Table Per Type (TPT / JOINED) 듀얼 드라이버 통합 테스트
 *
 * CRUD + 다형성 쿼리 + TPT 2-phase INSERT/DELETE + 릴레이션 역직렬화 검증
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
  ManyToOne,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner, ManyToOneScanner, OneToManyScanner } from "../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

function shortTable(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-6)}`;
}

const drivers = getTestDrivers();

describe.each(drivers)(
  "[Integration] $label: TPT Inheritance",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let Store: any;
    let Payment: any;
    let CreditCardPayment: any;
    let BankTransferPayment: any;
    let storeTable: string;
    let rootTable: string;
    let ccTable: string;
    let btTable: string;

    beforeAll(async () => {
      storeTable = shortTable("tpt_s");
      rootTable = shortTable("tpt_p");
      ccTable = shortTable("tpt_cc");
      btTable = shortTable("tpt_bt");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          clearScanners();

          @Entity({ name: storeTable })
          class StoreEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() storeName!: string;
          }

          @Entity({ name: rootTable })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
          class PaymentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() amount!: number;
            @Column({ type: "int", nullable: true }) storeFk!: number;
            @ManyToOne(() => StoreEntity, (e: any) => e.store, {
              joinColumn: "storeFk",
              eager: false,
            })
            store!: any;
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

          Store = StoreEntity;
          Payment = PaymentEntity;
          CreditCardPayment = CreditCardPaymentEntity;
          BankTransferPayment = BankTransferPaymentEntity;

          return {
            entities: [StoreEntity, PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
          };
        },
      );
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try { await dropTestTable(ccTable); } catch {}
      try { await dropTestTable(btTable); } catch {}
      try { await dropTestTable(rootTable); } catch {}
      try { await dropTestTable(storeTable); } catch {}
      await conn.cleanup();
    }, 15000);

    // ── INSERT ────────────────────────────────────────────

    it("should insert TPT child into both root and child tables", async () => {
      const store: any = await conn.em.save(Store, { storeName: "TPTStore" });

      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 300,
        cardNumber: "5555-5555",
        storeFk: store.id,
      });
      expect(cc.id).toBeGreaterThan(0);
      expect(cc.amount).toBe(300);

      const bt: any = await conn.em.save(BankTransferPayment, {
        amount: 400,
        bankCode: "IBAN123",
        storeFk: store.id,
      });
      expect(bt.id).toBeGreaterThan(0);

      await conn.em.save(Payment, { amount: 50 });
    });

    // ── SELECT ────────────────────────────────────────────

    it("should find TPT child with parent columns via INNER JOIN", async () => {
      const results = await conn.em.find(CreditCardPayment, {});
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);

      const cc = arr[0] as any;
      expect(cc.amount).toBeDefined();
      expect(cc.cardNumber).toBeDefined();
    });

    it("should find ALL payments polymorphically with correct instanceof", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];
      expect(allArray.length).toBeGreaterThanOrEqual(3);

      const cc = allArray.filter((p) => p instanceof CreditCardPayment);
      const bt = allArray.filter((p) => p instanceof BankTransferPayment);
      expect(cc.length).toBeGreaterThanOrEqual(1);
      expect(bt.length).toBeGreaterThanOrEqual(1);

      for (const c of cc) expect(c.cardNumber).toBeDefined();
      for (const b of bt) expect(b.bankCode).toBeDefined();
    });

    it("should find TPT child with ManyToOne relation", async () => {
      const results = await conn.em.find(CreditCardPayment, {
        relations: ["store"],
      });
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);

      const cc = arr[0] as any;
      expect(cc.store).toBeDefined();
      expect(cc.store.storeName).toBe("TPTStore");
    });

    // ── UPDATE ────────────────────────────────────────────

    it("should update parent column on TPT child", async () => {
      const cc: any = await conn.em.findOne(CreditCardPayment, { where: { amount: 300 } });
      expect(cc).toBeDefined();
      cc.amount = 350;
      await conn.em.save(CreditCardPayment, cc);

      const reloaded: any = await conn.em.findOne(CreditCardPayment, { where: { id: cc.id } });
      expect(reloaded.amount).toBe(350);
      expect(reloaded.cardNumber).toBe("5555-5555");
    });

    // ── DELETE ────────────────────────────────────────────

    it("should delete from both child and root tables", async () => {
      const saved: any = await conn.em.save(BankTransferPayment, {
        amount: 999,
        bankCode: "DEL_ME",
      });

      await conn.em.delete(BankTransferPayment, { id: saved.id } as any);

      const found = await conn.em.findOne(BankTransferPayment, { where: { id: saved.id } });
      expect(found == null).toBe(true);

      const allRoot = await conn.em.find(Payment, {});
      const allArr = (Array.isArray(allRoot) ? allRoot : allRoot ? [allRoot] : []) as any[];
      expect(allArr.find((p: any) => p.id === saved.id)).toBeUndefined();
    });
  },
);

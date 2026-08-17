/**
 * MySQL / PostgreSQL: Single Table Inheritance (STI) 듀얼 드라이버 통합 테스트
 *
 * CRUD + 다형성 쿼리 + 릴레이션 역직렬화 검증
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
  OneToMany,
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
  "[Integration] $label: STI Inheritance",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let Store: any;
    let Payment: any;
    let CreditCardPayment: any;
    let BankTransferPayment: any;
    let storeTable: string;
    let paymentTable: string;

    beforeAll(async () => {
      storeTable = shortTable("sti_s");
      paymentTable = shortTable("sti_p");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          clearScanners();

          @Entity({ name: storeTable })
          class StoreEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() storeName!: string;
            @OneToMany(() => PaymentEntity, { mappedBy: "store" })
            payments!: any[];
          }

          @Entity({ name: paymentTable })
          @Inheritance({ strategy: "SINGLE_TABLE" })
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

          @Entity()
          @DiscriminatorValue("credit_card")
          class CreditCardPaymentEntity extends PaymentEntity {
            @Column({ nullable: true }) cardNumber!: string;
          }

          @Entity()
          @DiscriminatorValue("bank_transfer")
          class BankTransferPaymentEntity extends PaymentEntity {
            @Column({ nullable: true }) bankCode!: string;
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
      try { await dropTestTable(paymentTable); } catch {}
      try { await dropTestTable(storeTable); } catch {}
      await conn.cleanup();
    }, 15000);

    // ── INSERT ────────────────────────────────────────────

    it("should insert child entities with discriminator", async () => {
      const store: any = await conn.em.save(Store, { storeName: "TestStore" });
      expect(store.id).toBeGreaterThan(0);

      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 100,
        cardNumber: "4111-1111",
        storeFk: store.id,
      });
      expect(cc.id).toBeGreaterThan(0);

      const bt: any = await conn.em.save(BankTransferPayment, {
        amount: 200,
        bankCode: "SWIFT",
        storeFk: store.id,
      });
      expect(bt.id).toBeGreaterThan(0);

      await conn.em.save(Payment, { amount: 50 });
    });

    // ── SELECT ────────────────────────────────────────────

    it("should find only credit card payments (discriminator WHERE)", async () => {
      const results = await conn.em.find(CreditCardPayment, {});
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      for (const r of arr as any[]) {
        expect(r.amount).toBeDefined();
      }
    });

    it("should find ALL payments polymorphically with correct instanceof", async () => {
      const all = await conn.em.find(Payment, {});
      const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];
      expect(allArray.length).toBeGreaterThanOrEqual(3);

      const cc = allArray.filter((p) => p instanceof CreditCardPayment);
      const bt = allArray.filter((p) => p instanceof BankTransferPayment);
      expect(cc.length).toBeGreaterThanOrEqual(1);
      expect(bt.length).toBeGreaterThanOrEqual(1);
    });

    it("should find child with ManyToOne relation", async () => {
      const results = await conn.em.find(CreditCardPayment, {
        relations: ["store"],
      });
      const arr = Array.isArray(results) ? results : results ? [results] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      expect((arr[0] as any).store).toBeDefined();
      expect((arr[0] as any).store.storeName).toBe("TestStore");
    });

    it("should find store with OneToMany payments", async () => {
      const stores = await conn.em.find(Store, { relations: ["payments"] });
      const arr = Array.isArray(stores) ? stores : stores ? [stores] : [];
      expect(arr.length).toBeGreaterThanOrEqual(1);
      expect((arr[0] as any).payments.length).toBeGreaterThanOrEqual(2);
    });

    // ── UPDATE ────────────────────────────────────────────

    it("should update child entity without changing discriminator", async () => {
      const cc: any = await conn.em.findOne(CreditCardPayment, { where: { amount: 100 } });
      expect(cc).toBeDefined();
      cc.amount = 150;
      await conn.em.save(CreditCardPayment, cc);

      const reloaded: any = await conn.em.findOne(CreditCardPayment, { where: { id: cc.id } });
      expect(reloaded.amount).toBe(150);
    });

    // ── DELETE ────────────────────────────────────────────

    // Own fixtures instead of `findOne(...)` + `if (bt)`: the guard made a
    // broken discriminator filter (no rows returned) pass silently.
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

      const deleted = await conn.em.findOne(Payment, { where: { id: bt.id } });
      expect(deleted == null).toBe(true);

      const survivor: any = await conn.em.findOne(Payment, { where: { id: cc.id } });
      expect(survivor).toBeTruthy();
      expect(survivor.id).toBe(cc.id);
    });

    it("should not delete a sibling subtype row addressed by PK", async () => {
      const cc: any = await conn.em.save(CreditCardPayment, {
        amount: 888,
        cardNumber: "KEEP-CC",
      });

      // Same PK, wrong subtype — the discriminator condition must keep the
      // DELETE from matching.
      await conn.em.delete(BankTransferPayment, { id: cc.id } as any);

      const survivor: any = await conn.em.findOne(CreditCardPayment, {
        where: { id: cc.id },
      });
      expect(survivor).toBeTruthy();
      expect(survivor.cardNumber).toBe("KEEP-CC");
    });

    // ── STI aggregate parity (#403) ───────────────────────

    it("count() honors the discriminator exactly like find() (#403)", async () => {
      // Before #403, count()/aggregate() skipped the STI discriminator and
      // counted sibling subtypes, so a child-class count over-reported vs the
      // rows find() actually returned. Assert count == find().length per class,
      // independent of the absolute row counts left by earlier tests.
      const len = (r: any) => (Array.isArray(r) ? r.length : r ? 1 : 0);

      const ccCount = await conn.em.count(CreditCardPayment);
      const btCount = await conn.em.count(BankTransferPayment);
      const rootCount = await conn.em.count(Payment);

      expect(ccCount).toBe(len(await conn.em.find(CreditCardPayment, {})));
      expect(btCount).toBe(len(await conn.em.find(BankTransferPayment, {})));
      // Root query is polymorphic — no discriminator filter — so it counts all.
      expect(rootCount).toBe(len(await conn.em.find(Payment, {})));
      // The child counts must never exceed the polymorphic total.
      expect(ccCount + btCount).toBeLessThanOrEqual(rootCount);
    });
  },
);

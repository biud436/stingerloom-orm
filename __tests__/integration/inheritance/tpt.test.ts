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

    // V6-T1-6: criteria naming non-PK columns, and deletes called on the root.
    describe("delete by criteria across the hierarchy", () => {
      const q = (t: string) => (type === "mysql" ? `\`${t}\`` : `"${t}"`);

      async function idsIn(table: string, ids: number[]): Promise<number[]> {
        const raw: any = await conn.em
          .getDriver()!
          .executeRaw(
            `SELECT id FROM ${q(table)} WHERE id IN (${ids.join(", ")}) ORDER BY id`,
          );
        const rows: any[] = Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
        return rows.map((r) => Number(r.id));
      }

      /** One row per class, all sharing `amount`, so a root-column criteria can over-reach. */
      async function seed(amount: number) {
        const plain: any = await conn.em.save(Payment, { amount });
        const cc: any = await conn.em.save(CreditCardPayment, {
          amount,
          cardNumber: `cc-${amount}`,
        });
        const bt: any = await conn.em.save(BankTransferPayment, {
          amount,
          bankCode: `bt-${amount}`,
        });
        return { plain: plain.id, cc: cc.id, bt: bt.id, all: [plain.id, cc.id, bt.id] };
      }

      it("a child delete by its own column removes both rows", async () => {
        const s = await seed(71001);
        const result = await conn.em.delete(BankTransferPayment, {
          bankCode: "bt-71001",
        } as any);
        expect(result.affected).toBe(1);
        expect(await idsIn(btTable, s.all)).toEqual([]);
        expect(await idsIn(rootTable, s.all)).toEqual([s.plain, s.cc]);
      });

      it("a child delete by a root column touches only that class's rows", async () => {
        const s = await seed(71002);
        const result = await conn.em.delete(BankTransferPayment, { amount: 71002 } as any);
        expect(result.affected).toBe(1);
        expect(await idsIn(ccTable, s.all)).toEqual([s.cc]);
        expect(await idsIn(rootTable, s.all)).toEqual([s.plain, s.cc]);
      });

      it("a child delete does not reach a sibling's row by its primary key", async () => {
        const s = await seed(71003);
        expect((await conn.em.delete(BankTransferPayment, { id: s.cc } as any)).affected).toBe(0);
        expect(await idsIn(rootTable, s.all)).toEqual(s.all);
      });

      it("a root delete removes every class's matching row and its child rows", async () => {
        const s = await seed(71004);
        const result = await conn.em.delete(Payment, { amount: 71004 } as any);
        expect(result.affected).toBe(3);
        expect(await idsIn(rootTable, s.all)).toEqual([]);
        expect(await idsIn(ccTable, s.all)).toEqual([]);
        expect(await idsIn(btTable, s.all)).toEqual([]);
      });

      it("deleteMany on a child and on the root removes every table's rows", async () => {
        const s = await seed(71005);
        expect((await conn.em.deleteMany(CreditCardPayment, [s.cc, s.bt])).affected).toBe(1);
        expect(await idsIn(ccTable, s.all)).toEqual([]);
        expect(await idsIn(rootTable, s.all)).toEqual([s.plain, s.bt]);

        expect((await conn.em.deleteMany(Payment, [s.plain, s.bt])).affected).toBe(2);
        expect(await idsIn(btTable, s.all)).toEqual([]);
        expect(await idsIn(rootTable, s.all)).toEqual([]);
      });
    });
  },
);

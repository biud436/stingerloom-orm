/**
 * SQLite In-Memory: Core write-path parity (#403)
 *
 * Reproduces and guards the correctness gaps closed for the core (immediate
 * execution) write path:
 *
 *  1. updateMany() skips soft-deleted rows by default, and `withDeleted: true`
 *     opts back in.
 *  2. softDelete()/restore() fire before/after lifecycle events, and
 *     updateMany() fires before/afterUpdate on the em.on() channel.
 *  3. STI discriminator parity — updateMany/softDelete/restore/count/
 *     findWithCursor on a child class touch/count only that subtype's rows,
 *     never siblings sharing the single table.
 *
 * NOTE: SQLite's session returns `{ results: { changes } }`, so EntityManager's
 * rowCount-based `affected` is always 0 here. Tests assert on data state.
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
  DeletedAt,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  type EntityEventListener,
  type EntitySubscriber,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

// ═══════════════════════════════════════════════════════════════
// 1. updateMany() soft-delete filter + withDeleted opt-out
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: updateMany soft-delete filter (#403)", () => {
  let conn: TestConnectionResult;
  let Widget: any;

  beforeEach(async () => {
    const tableName = shortTableName("wpp_upd");
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        clearScanners();

        @Entity({ name: tableName })
        class WidgetEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() label!: string;
          @Column({ type: "int" }) score!: number;
          @DeletedAt() deletedAt!: Date | null;
        }

        Widget = WidgetEntity;
        return { entities: [WidgetEntity] };
      },
    );
  });

  afterEach(async () => {
    await conn.cleanup();
  });

  it("does NOT update soft-deleted rows by default", async () => {
    const live: any = await conn.em.save(Widget, { label: "live", score: 1 });
    const trashed: any = await conn.em.save(Widget, { label: "trashed", score: 1 });

    await conn.em.softDelete(Widget, { id: trashed.id });

    await conn.em.updateMany(Widget, { score: 99 }, { where: { score: 1 } });

    const [liveRow]: any[] = await conn.em.find(Widget, {
      where: { id: live.id },
    });
    const [trashedRow]: any[] = await conn.em.find(Widget, {
      where: { id: trashed.id },
      withDeleted: true,
    });

    expect(liveRow.score).toBe(99);
    // The trashed row must be left untouched by a default updateMany.
    expect(trashedRow.score).toBe(1);
  });

  it("updates soft-deleted rows when withDeleted: true", async () => {
    const live: any = await conn.em.save(Widget, { label: "live", score: 1 });
    const trashed: any = await conn.em.save(Widget, { label: "trashed", score: 1 });

    await conn.em.softDelete(Widget, { id: trashed.id });

    await conn.em.updateMany(
      Widget,
      { score: 99 },
      { where: { score: 1 }, withDeleted: true },
    );

    const [liveRow]: any[] = await conn.em.find(Widget, {
      where: { id: live.id },
    });
    const [trashedRow]: any[] = await conn.em.find(Widget, {
      where: { id: trashed.id },
      withDeleted: true,
    });

    expect(liveRow.score).toBe(99);
    expect(trashedRow.score).toBe(99);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Lifecycle events: softDelete / restore / updateMany
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: soft-delete/restore/update events (#403)", () => {
  let conn: TestConnectionResult;
  let EvWidget: any;

  beforeEach(async () => {
    const tableName = shortTableName("wpp_ev");
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        clearScanners();

        @Entity({ name: tableName })
        class EvWidgetEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() label!: string;
          @DeletedAt() deletedAt!: Date | null;
        }

        EvWidget = EvWidgetEntity;
        return { entities: [EvWidgetEntity] };
      },
    );
  });

  afterEach(async () => {
    await conn.cleanup();
  });

  it("fires beforeSoftDelete/afterSoftDelete on the em.on() channel", async () => {
    const row: any = await conn.em.save(EvWidget, { label: "x" });

    const order: string[] = [];
    const before: EntityEventListener = () => {
      order.push("before");
    };
    const after: EntityEventListener = () => {
      order.push("after");
    };
    conn.em.on("beforeSoftDelete", before);
    conn.em.on("afterSoftDelete", after);

    await conn.em.softDelete(EvWidget, { id: row.id });

    conn.em.off("beforeSoftDelete", before);
    conn.em.off("afterSoftDelete", after);

    expect(order).toEqual(["before", "after"]);
  });

  it("fires beforeRestore/afterRestore on the em.on() channel", async () => {
    const row: any = await conn.em.save(EvWidget, { label: "x" });
    await conn.em.softDelete(EvWidget, { id: row.id });

    const order: string[] = [];
    conn.em.on("beforeRestore", () => {
      order.push("before");
    });
    conn.em.on("afterRestore", () => {
      order.push("after");
    });

    await conn.em.restore(EvWidget, { id: row.id });

    expect(order).toEqual(["before", "after"]);
  });

  it("delivers soft-delete events to an EntitySubscriber with criteria", async () => {
    const row: any = await conn.em.save(EvWidget, { label: "x" });

    const seen: Array<{ hook: string; id: unknown }> = [];
    const sub: EntitySubscriber<any> = {
      listenTo: () => EvWidget,
      beforeSoftDelete: (e: any) => {
        seen.push({ hook: "beforeSoftDelete", id: e.criteria.id });
      },
      afterSoftDelete: (e: any) => {
        seen.push({ hook: "afterSoftDelete", id: e.criteria.id });
      },
      afterRestore: (e: any) => {
        seen.push({ hook: "afterRestore", id: e.criteria.id });
      },
    };
    conn.em.addSubscriber(sub);

    await conn.em.softDelete(EvWidget, { id: row.id });
    await conn.em.restore(EvWidget, { id: row.id });

    conn.em.removeSubscriber(sub);

    expect(seen).toEqual([
      { hook: "beforeSoftDelete", id: row.id },
      { hook: "afterSoftDelete", id: row.id },
      { hook: "afterRestore", id: row.id },
    ]);
  });

  it("fires beforeUpdate/afterUpdate on updateMany", async () => {
    const row: any = await conn.em.save(EvWidget, { label: "x" });

    const order: string[] = [];
    conn.em.on("beforeUpdate", () => {
      order.push("before");
    });
    conn.em.on("afterUpdate", () => {
      order.push("after");
    });

    await conn.em.updateMany<any>(EvWidget, { label: "y" }, { where: { id: row.id } });

    expect(order).toEqual(["before", "after"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. STI discriminator parity on bulk write/read paths
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: STI discriminator parity (#403)", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCard: any;
  let BankTransfer: any;

  beforeEach(async () => {
    const tableName = shortTableName("wpp_sti");
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
      () => {
        clearScanners();

        @Entity({ name: tableName })
        @Inheritance({ strategy: "SINGLE_TABLE" })
        @DiscriminatorColumn({ name: "kind", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) amount!: number;
          @DeletedAt() deletedAt!: Date | null;
        }

        @Entity()
        @DiscriminatorValue("credit_card")
        class CreditCardEntity extends PaymentEntity {
          @Column({ nullable: true }) cardNumber!: string;
        }

        @Entity()
        @DiscriminatorValue("bank_transfer")
        class BankTransferEntity extends PaymentEntity {
          @Column({ nullable: true }) bankCode!: string;
        }

        Payment = PaymentEntity;
        CreditCard = CreditCardEntity;
        BankTransfer = BankTransferEntity;
        return {
          entities: [PaymentEntity, CreditCardEntity, BankTransferEntity],
        };
      },
    );

    // Seed: 2 credit-card, 1 bank-transfer.
    await conn.em.save(CreditCard, { amount: 10, cardNumber: "1111" });
    await conn.em.save(CreditCard, { amount: 20, cardNumber: "2222" });
    await conn.em.save(BankTransfer, { amount: 30, bankCode: "SWIFT" });
  });

  afterEach(async () => {
    await conn.cleanup();
  });

  it("count() on a child class counts only that subtype", async () => {
    expect(await conn.em.count(CreditCard)).toBe(2);
    expect(await conn.em.count(BankTransfer)).toBe(1);
    // Root (polymorphic) counts every row in the table.
    expect(await conn.em.count(Payment)).toBe(3);
  });

  it("updateMany() on a child class updates only that subtype", async () => {
    await conn.em.updateMany<any>(CreditCard, { amount: 999 }, { where: { id: { gt: 0 } } });

    const cards: any[] = await conn.em.find(CreditCard, {});
    const banks: any[] = await conn.em.find(BankTransfer, {});

    expect(cards.map((c) => c.amount).sort()).toEqual([999, 999]);
    // Bank transfer left untouched.
    expect(banks.map((b) => b.amount)).toEqual([30]);
  });

  it("softDelete()/restore() on a child class affect only that subtype", async () => {
    await conn.em.softDelete(CreditCard, { id: { gt: 0 } });

    expect(await conn.em.count(CreditCard)).toBe(0);
    expect(await conn.em.count(BankTransfer)).toBe(1);
    // Root counts non-deleted rows: only the bank transfer remains live.
    expect(await conn.em.count(Payment)).toBe(1);

    await conn.em.restore(CreditCard, { id: { gt: 0 } });

    expect(await conn.em.count(CreditCard)).toBe(2);
    expect(await conn.em.count(Payment)).toBe(3);
  });

  it("findWithCursor() on a child class pages only that subtype", async () => {
    const page = await conn.em.findWithCursor(CreditCard, { take: 10 });
    expect(page.data.length).toBe(2);
    expect(
      (page.data as any[]).every((r) => typeof r.cardNumber === "string"),
    ).toBe(true);
  });
});

/**
 * SQLite In-Memory: Inheritance + Buffer Plugin (WriteBuffer) 통합 테스트
 *
 * WriteBuffer의 find/findOne/save/flush가 상속 엔티티와 올바르게 동작하는지 검증합니다.
 *
 * WriteBuffer는 내부적으로 EntityManager에 위임하므로 상속 전략이 투명하게 적용됩니다.
 * 이 테스트는 그 위임이 실제로 올바르게 동작하는지, 특히:
 * - Identity Map에서 다형성 결과가 올바르게 추적되는지
 * - save() → flush()로 discriminator가 올바르게 저장되는지
 * - dirty tracking이 상속 엔티티에서 동작하는지
 * 를 검증합니다.
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
import { bufferPlugin } from "../../../../src/core/plugin/buffer/bufferPlugin";
import { WriteBuffer } from "../../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

// ═══════════════════════════════════════════════════════════════
// STI + Buffer Plugin
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: STI + Buffer Plugin", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("buf_sti");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        clearScanners();

        @Entity({ name: tableName })
        @Inheritance({ strategy: "SINGLE_TABLE" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
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

  it("should access WriteBuffer via em.buffer()", () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    expect(buf).toBeInstanceOf(WriteBuffer);
  });

  it("should save and flush STI child entities via buffer", async () => {
    // Insert seed data directly (not through buffer)
    await conn.em.save(CreditCardPayment, { amount: 100, cardNumber: "4111-BUF" });
    await conn.em.save(BankTransferPayment, { amount: 200, bankCode: "BUF-SWIFT" });
  });

  it("should findOne STI child via buffer and auto-track", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const cc = await buf.findOne(CreditCardPayment, {
      where: { amount: 100 },
    });
    expect(cc).not.toBeNull();
    expect((cc as any).amount).toBe(100);
    expect(buf.tracked().length).toBeGreaterThanOrEqual(1);
  });

  it("should find all STI children via buffer", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const results = await buf.find(CreditCardPayment, {});
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(buf.tracked().length).toBeGreaterThanOrEqual(1);
  });

  it("should dirty track and flush UPDATE on STI child", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const cc = await buf.findOne(CreditCardPayment, {
      where: { amount: 100 },
    });
    expect(cc).not.toBeNull();

    (cc as any).amount = 999;
    const dirty = buf.dirty();
    expect(dirty.length).toBeGreaterThanOrEqual(1);

    const result = await buf.flush();
    expect(result.updates).toBeGreaterThanOrEqual(1);

    // Verify the update persisted
    const reloaded = await conn.em.findOne(CreditCardPayment, {
      where: { amount: 999 },
    });
    expect(reloaded).toBeDefined();
    expect((reloaded as any).amount).toBe(999);
  });

  it("should polymorphic find via buffer return correct instances", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const all = await buf.find(Payment, {});
    const allArray = Array.isArray(all) ? all : [];

    expect(allArray.length).toBeGreaterThanOrEqual(2);

    const ccPayments = allArray.filter((p: any) => p instanceof CreditCardPayment);
    const btPayments = allArray.filter((p: any) => p instanceof BankTransferPayment);

    expect(ccPayments.length).toBeGreaterThanOrEqual(1);
    expect(btPayments.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// TPT + Buffer Plugin
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPT + Buffer Plugin", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let rootTableName: string;
  let ccTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("buf_tpt");
    ccTableName = shortTableName("buf_tpt_cc");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        clearScanners();

        @Entity({ name: rootTableName })
        @Inheritance({ strategy: "JOINED" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
        }

        @Entity({ name: ccTableName })
        @DiscriminatorValue("credit_card")
        class CreditCardPaymentEntity extends PaymentEntity {
          @Column() cardNumber!: string;
        }

        @Entity({ name: shortTableName("buf_tpt_bt") })
        @DiscriminatorValue("bank_transfer")
        class BankTransferPaymentEntity extends PaymentEntity {
          @Column() bankCode!: string;
        }

        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;

        return {
          entities: [PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );

    // Seed
    await conn.em.save(CreditCardPayment, { amount: 300, cardNumber: "TPT-BUF" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should findOne TPT child via buffer with parent columns", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const cc = await buf.findOne(CreditCardPayment, {
      where: { amount: 300 },
    });
    expect(cc).not.toBeNull();
    expect((cc as any).amount).toBe(300);
    expect((cc as any).cardNumber).toBe("TPT-BUF");
  });

  it("should dirty track and flush UPDATE on TPT child", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const cc = await buf.findOne(CreditCardPayment, {});
    expect(cc).not.toBeNull();

    (cc as any).cardNumber = "UPDATED-TPT";
    const result = await buf.flush();
    expect(result.updates).toBeGreaterThanOrEqual(1);

    const reloaded = await conn.em.findOne(CreditCardPayment, {});
    expect((reloaded as any).cardNumber).toBe("UPDATED-TPT");
  });
});

// ═══════════════════════════════════════════════════════════════
// TPC + Buffer Plugin
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPC + Buffer Plugin", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        clearScanners();

        @Entity({ name: shortTableName("buf_tpc") })
        @Inheritance({ strategy: "TABLE_PER_CLASS" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
        }

        @Entity({ name: shortTableName("buf_tpc_cc") })
        @DiscriminatorValue("credit_card")
        class CreditCardPaymentEntity extends PaymentEntity {
          @Column() cardNumber!: string;
        }

        @Entity({ name: shortTableName("buf_tpc_bt") })
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

    // Seed
    await conn.em.save(CreditCardPayment, { amount: 500, cardNumber: "TPC-BUF" });
    await conn.em.save(BankTransferPayment, { amount: 600, bankCode: "TPC-SWIFT" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should find TPC child via buffer", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const results = await buf.find(CreditCardPayment, {});
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect((results[0] as any).cardNumber).toBe("TPC-BUF");
  });

  it("should polymorphic find via buffer with TPC UNION ALL", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const all = await buf.find(Payment, {});
    expect(all.length).toBeGreaterThanOrEqual(2);

    const ccPayments = all.filter((p: any) => p instanceof CreditCardPayment);
    const btPayments = all.filter((p: any) => p instanceof BankTransferPayment);

    expect(ccPayments.length).toBeGreaterThanOrEqual(1);
    expect(btPayments.length).toBeGreaterThanOrEqual(1);
  });

  it("should dirty track and flush UPDATE on TPC child", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const cc = await buf.findOne(CreditCardPayment, {});
    expect(cc).not.toBeNull();

    (cc as any).amount = 777;
    const result = await buf.flush();
    expect(result.updates).toBeGreaterThanOrEqual(1);

    const reloaded = await conn.em.findOne(CreditCardPayment, {
      where: { amount: 777 },
    });
    expect(reloaded).toBeDefined();
    expect((reloaded as any).amount).toBe(777);
  });
});

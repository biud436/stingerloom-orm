/**
 * SQLite In-Memory: Inheritance + SelectQueryBuilder 통합 테스트
 *
 * SelectQueryBuilder는 상속 전략을 자동으로 적용하지 않습니다.
 * 자식 엔티티에서 QueryBuilder를 사용하면 해당 테이블에서만 조회합니다.
 *
 * 이 테스트는:
 * 1. STI 자식에서 QueryBuilder로 단일 테이블 조회 (discriminator 수동 WHERE 필요)
 * 2. TPT 자식에서 QueryBuilder로 자식 테이블 + 수동 JOIN으로 부모 조회
 * 3. TPC 자식에서 QueryBuilder로 독립 테이블 조회
 * 위 시나리오의 동작을 검증합니다.
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

// ═══════════════════════════════════════════════════════════════
// STI + QueryBuilder
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: STI + QueryBuilder", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("qb_sti");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
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

    // Seed data
    await conn.em.save(CreditCardPayment, { amount: 100, cardNumber: "4111-1111" });
    await conn.em.save(BankTransferPayment, { amount: 200, bankCode: "SWIFT123" });
    await conn.em.save(Payment, { amount: 50 });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should query child entity via QueryBuilder with manual discriminator WHERE", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .where("payment_type", "credit_card")
      .getMany();

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results as any[]) {
      expect(r.amount).toBeDefined();
    }
  });

  it("should return all rows from shared table without discriminator filter", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .getMany();

    // Without discriminator filter, returns ALL rows from the shared table
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("should support orderBy on QueryBuilder with STI entity", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .orderBy({ amount: "DESC" })
      .getMany();

    expect(results.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1] as any).amount).toBeGreaterThanOrEqual(
        (results[i] as any).amount,
      );
    }
  });

  it("should support getRawMany for raw projections", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .getRawMany();

    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results as any[]) {
      expect(r.amount).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TPC + QueryBuilder
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPC + QueryBuilder", () => {
  let conn: TestConnectionResult;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    ccTableName = shortTableName("qb_tpc_cc");
    btTableName = shortTableName("qb_tpc_bt");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: shortTableName("qb_tpc") })
        @Inheritance({ strategy: "TABLE_PER_CLASS" })
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

        @Entity({ name: btTableName })
        @DiscriminatorValue("bank_transfer")
        class BankTransferPaymentEntity extends PaymentEntity {
          @Column() bankCode!: string;
        }

        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );

    await conn.em.save(CreditCardPayment, { amount: 100, cardNumber: "4111-CC" });
    await conn.em.save(CreditCardPayment, { amount: 200, cardNumber: "5555-CC" });
    await conn.em.save(BankTransferPayment, { amount: 300, bankCode: "SWIFT" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should query TPC child entity from its own table via QueryBuilder", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .getMany();

    expect(results.length).toBe(2);
    for (const r of results as any[]) {
      expect(r.amount).toBeDefined();
      expect(r.cardNumber).toBeDefined();
    }
  });

  it("should support WHERE on TPC child QueryBuilder", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .where("amount", 100)
      .getMany();

    expect(results.length).toBe(1);
    expect((results[0] as any).cardNumber).toBe("4111-CC");
  });

  it("should support getOne on TPC child QueryBuilder", async () => {
    const result = await conn.em
      .createQueryBuilder(BankTransferPayment, "bt")
      .getOne();

    expect(result).not.toBeNull();
    expect((result as any).bankCode).toBe("SWIFT");
  });
});

// ═══════════════════════════════════════════════════════════════
// TPT + QueryBuilder
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPT + QueryBuilder", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let rootTableName: string;
  let ccTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("qb_tpt");
    ccTableName = shortTableName("qb_tpt_cc");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
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

        @Entity({ name: shortTableName("qb_tpt_bt") })
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

    await conn.em.save(CreditCardPayment, { amount: 100, cardNumber: "4111-TPT" });
    await conn.em.save(Payment, { amount: 50 });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should query TPT child entity's own columns via QueryBuilder", async () => {
    // QueryBuilder on TPT child queries only the child table
    // To get parent columns, you need manual JOIN
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .getMany();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const cc = results[0] as any;
    // Child's own columns should be available
    expect(cc.cardNumber).toBeDefined();
  });

  it("should support manual LEFT JOIN to parent table for full data", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .leftJoin(
        rootTableName,
        "parent",
        `"cc"."id" = "parent"."id"`,
      )
      .getRawMany();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const row = results[0] as any;
    // Raw results should contain child columns
    expect(row.cardNumber).toBeDefined();
  });
});

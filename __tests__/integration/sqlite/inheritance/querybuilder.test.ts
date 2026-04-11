/**
 * SQLite In-Memory: Inheritance + SelectQueryBuilder 통합 테스트
 *
 * SelectQueryBuilder는 상속 전략을 자동으로 적용합니다:
 * 1. STI 자식: discriminator WHERE 자동 추가
 * 2. STI 루트: 다형성 결과 (올바른 서브클래스 인스턴스)
 * 3. TPT 자식: 부모 테이블 INNER JOIN 자동 추가, 양쪽 컬럼 조회
 * 4. TPT 루트: 다형성 결과 (LEFT JOIN + 서브클래스 역직렬화)
 * 5. TPC 자식: 독립 테이블 조회 (변경 없음)
 * 6. TPC 루트: UNION ALL 다형성 쿼리
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
    await conn.em.save(CreditCardPayment, { amount: 150, cardNumber: "5555-2222" });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should auto-filter child entity by discriminator (no manual WHERE needed)", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .getMany();

    // Should only return credit card payments, not all rows
    expect(results.length).toBe(2);
    for (const r of results as any[]) {
      expect(r.amount).toBeDefined();
    }
  });

  it("should auto-filter bank transfer child entity", async () => {
    const results = await conn.em
      .createQueryBuilder(BankTransferPayment, "p")
      .getMany();

    expect(results.length).toBe(1);
    expect((results[0] as any).amount).toBe(200);
  });

  it("should support additional WHERE on auto-filtered child query", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .where("amount", ">=", 150)
      .getMany();

    expect(results.length).toBe(1);
    expect((results[0] as any).amount).toBe(150);
  });

  it("should return polymorphic results from root entity", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .getMany();

    // Root query returns ALL rows with correct subclass instances
    expect(results.length).toBe(3);

    const ccResults = results.filter((r) => r instanceof CreditCardPayment);
    const btResults = results.filter((r) => r instanceof BankTransferPayment);
    expect(ccResults.length).toBe(2);
    expect(btResults.length).toBe(1);
  });

  it("should support orderBy on polymorphic root query", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .orderBy({ amount: "DESC" })
      .getMany();

    expect(results.length).toBe(3);
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1] as any).amount).toBeGreaterThanOrEqual(
        (results[i] as any).amount,
      );
    }
  });

  it("should support getCount on child entity", async () => {
    const count = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .getCount();

    expect(count).toBe(2);
  });

  it("should support exists on child entity", async () => {
    const hasCC = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .exists();
    expect(hasCC).toBe(true);
  });

  it("should support getOne on child entity", async () => {
    const result = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .where("amount", 100)
      .getOne();

    expect(result).not.toBeNull();
    expect((result as any).cardNumber).toBe("4111-1111");
  });

  it("should support getRawMany on child entity", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "p")
      .getRawMany();

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.amount).toBeDefined();
    }
  });

  it("should support clone on inheritance-aware query builder", async () => {
    const base = conn.em
      .createQueryBuilder(CreditCardPayment, "p");
    const cloned = base.clone();

    const results = await cloned.getMany();
    expect(results.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// TPC + QueryBuilder
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPC + QueryBuilder", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let rootTableName: string;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("qb_tpc");
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

        @Entity({ name: rootTableName })
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

        Payment = PaymentEntity;
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

  it("should return polymorphic results from TPC root entity via UNION ALL", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .getMany();

    // Root query returns ALL rows across all child tables
    expect(results.length).toBe(3);

    const ccResults = results.filter((r) => r instanceof CreditCardPayment);
    const btResults = results.filter((r) => r instanceof BankTransferPayment);
    expect(ccResults.length).toBe(2);
    expect(btResults.length).toBe(1);
  });

  it("should support WHERE on TPC polymorphic query", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .where("amount", ">=", 200)
      .getMany();

    expect(results.length).toBe(2);
  });

  it("should support getCount on TPC polymorphic query", async () => {
    const count = await conn.em
      .createQueryBuilder(Payment, "p")
      .getCount();

    expect(count).toBe(3);
  });

  it("should support exists on TPC polymorphic query", async () => {
    const result = await conn.em
      .createQueryBuilder(Payment, "p")
      .exists();

    expect(result).toBe(true);
  });

  it("should support orderBy on TPC polymorphic query", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .orderBy({ amount: "ASC" })
      .getRawMany();

    expect(results.length).toBe(3);
    for (let i = 1; i < results.length; i++) {
      expect(Number(results[i].amount)).toBeGreaterThanOrEqual(
        Number(results[i - 1].amount),
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TPT + QueryBuilder
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPT + QueryBuilder", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let rootTableName: string;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("qb_tpt");
    ccTableName = shortTableName("qb_tpt_cc");
    btTableName = shortTableName("qb_tpt_bt");

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

        @Entity({ name: btTableName })
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

    await conn.em.save(CreditCardPayment, { amount: 100, cardNumber: "4111-TPT" });
    await conn.em.save(CreditCardPayment, { amount: 250, cardNumber: "5555-TPT" });
    await conn.em.save(BankTransferPayment, { amount: 300, bankCode: "SWIFT-TPT" });
    await conn.em.save(Payment, { amount: 50 });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should auto-join parent table and return both parent+child columns", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .getMany();

    expect(results.length).toBe(2);
    for (const r of results as any[]) {
      // Child's own column
      expect(r.cardNumber).toBeDefined();
      // Parent's column (via auto-join)
      expect(r.amount).toBeDefined();
    }
  });

  it("should support WHERE on parent column in TPT child query", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .where("amount", ">=", 200)
      .getMany();

    expect(results.length).toBe(1);
    expect((results[0] as any).cardNumber).toBe("5555-TPT");
  });

  it("should support WHERE on child column in TPT child query", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .where("cardNumber", "4111-TPT")
      .getMany();

    expect(results.length).toBe(1);
    expect((results[0] as any).amount).toBe(100);
  });

  it("should support getCount on TPT child query", async () => {
    const count = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .getCount();

    expect(count).toBe(2);
  });

  it("should support getOne on TPT child query", async () => {
    const result = await conn.em
      .createQueryBuilder(BankTransferPayment, "bt")
      .getOne();

    expect(result).not.toBeNull();
    expect((result as any).bankCode).toBe("SWIFT-TPT");
    expect((result as any).amount).toBe(300);
  });

  it("should return polymorphic results from TPT root entity", async () => {
    const results = await conn.em
      .createQueryBuilder(Payment, "p")
      .getMany();

    // Root query returns all rows with correct subclass instances
    expect(results.length).toBe(4);

    const ccResults = results.filter((r) => r instanceof CreditCardPayment);
    const btResults = results.filter((r) => r instanceof BankTransferPayment);
    expect(ccResults.length).toBe(2);
    expect(btResults.length).toBe(1);

    // Verify child columns are populated on subclass instances
    for (const cc of ccResults as any[]) {
      expect(cc.cardNumber).toBeDefined();
      expect(cc.amount).toBeDefined();
    }
    for (const bt of btResults as any[]) {
      expect(bt.bankCode).toBeDefined();
      expect(bt.amount).toBeDefined();
    }
  });

  it("should support getCount on TPT polymorphic query", async () => {
    const count = await conn.em
      .createQueryBuilder(Payment, "p")
      .getCount();

    expect(count).toBe(4);
  });

  it("should support orderBy on TPT child query", async () => {
    const results = await conn.em
      .createQueryBuilder(CreditCardPayment, "cc")
      .orderBy({ amount: "DESC" })
      .getMany();

    expect(results.length).toBe(2);
    expect((results[0] as any).amount).toBe(250);
    expect((results[1] as any).amount).toBe(100);
  });
});

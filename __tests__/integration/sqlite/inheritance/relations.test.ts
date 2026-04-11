/**
 * SQLite In-Memory: Inheritance + Relations 통합 테스트
 *
 * STI / TPT / TPC 상속 엔티티에 @ManyToOne / @OneToMany 관계를 추가했을 때
 * EntityManager.find()의 역직렬화가 정확한지 검증합니다.
 *
 * 검증 항목:
 * - 상속 자식 엔티티에 @ManyToOne 관계 설정 후 INSERT + SELECT
 * - 루트 엔티티 다형성 쿼리에서 릴레이션 로드
 * - 자식 엔티티 WHERE 조건과 릴레이션 동시 사용
 * - findOne + relations 옵션
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
  ManyToOne,
  OneToMany,
} from "../../../../src";
import { getScannerInstance } from "../../../../src/scanner/ScannerContainer";
import { ColumnScanner, ManyToOneScanner, OneToManyScanner } from "../../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

// ═══════════════════════════════════════════════════════════════
// STI + Relations
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: STI + Relations", () => {
  let conn: TestConnectionResult;
  let Store: any;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let storeTableName: string;
  let paymentTableName: string;

  beforeAll(async () => {
    storeTableName = shortTableName("sti_store");
    paymentTableName = shortTableName("sti_rpay");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: storeTableName })
        class StoreEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() storeName!: string;
          @OneToMany(() => PaymentEntity, { mappedBy: "store" })
          payments!: any[];
        }

        @Entity({ name: paymentTableName })
        @Inheritance({ strategy: "SINGLE_TABLE" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
          @Column({ type: "int", nullable: true }) storeFk!: number;
          @ManyToOne(() => StoreEntity, (e: any) => e.store, {
            joinColumn: "storeFk",
            eager: false,
            createForeignKeyConstraints: false,
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
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should insert child entities with FK relation", async () => {
    const store: any = await conn.em.save(Store, { storeName: "MyStore" });
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
  });

  it("should find child entity with ManyToOne eager relation", async () => {
    const results = await conn.em.find(CreditCardPayment, {
      relations: ["store"],
    });
    const arr = Array.isArray(results) ? results : results ? [results] : [];
    expect(arr.length).toBeGreaterThanOrEqual(1);

    const cc = arr[0] as any;
    expect(cc.store).toBeDefined();
    expect(cc.store).not.toBeNull();
    expect(cc.store.storeName).toBe("MyStore");
  });

  it("should find parent entity with OneToMany relation (all payments)", async () => {
    const stores = await conn.em.find(Store, {
      relations: ["payments"],
    });
    const arr = Array.isArray(stores) ? stores : stores ? [stores] : [];
    expect(arr.length).toBeGreaterThanOrEqual(1);

    const store = arr[0] as any;
    expect(store.payments).toBeDefined();
    expect(Array.isArray(store.payments)).toBe(true);
    expect(store.payments.length).toBeGreaterThanOrEqual(2);
  });

  it("should filter child by WHERE and still load relation", async () => {
    const results = await conn.em.find(CreditCardPayment, {
      where: { amount: 100 },
      relations: ["store"],
    });
    const arr = Array.isArray(results) ? results : results ? [results] : [];
    expect(arr.length).toBeGreaterThanOrEqual(1);
    expect((arr[0] as any).store).toBeDefined();
    expect((arr[0] as any).store.storeName).toBe("MyStore");
  });

  it("should findOne child with relation", async () => {
    const result = await conn.em.findOne(CreditCardPayment, {
      where: { amount: 100 },
      relations: ["store"],
    });
    expect(result).toBeDefined();
    expect((result as any).store).toBeDefined();
    expect((result as any).store.storeName).toBe("MyStore");
  });
});

// ═══════════════════════════════════════════════════════════════
// TPT + Relations
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPT + Relations", () => {
  let conn: TestConnectionResult;
  let Store: any;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let storeTableName: string;
  let rootTableName: string;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    storeTableName = shortTableName("tpt_rstr");
    rootTableName = shortTableName("tpt_rpay");
    ccTableName = shortTableName("tpt_rcc");
    btTableName = shortTableName("tpt_rbt");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: storeTableName })
        class StoreEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() storeName!: string;
        }

        @Entity({ name: rootTableName })
        @Inheritance({ strategy: "JOINED" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
          @Column({ type: "int", nullable: true }) storeFk!: number;
          @ManyToOne(() => StoreEntity, (e: any) => e.store, {
            joinColumn: "storeFk",
            eager: false,
            createForeignKeyConstraints: false,
          })
          store!: any;
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

        Store = StoreEntity;
        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [StoreEntity, PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should insert TPT child entities with FK", async () => {
    const store: any = await conn.em.save(Store, { storeName: "TPTStore" });
    expect(store.id).toBeGreaterThan(0);

    const cc: any = await conn.em.save(CreditCardPayment, {
      amount: 300,
      cardNumber: "5555-5555",
      storeFk: store.id,
    });
    expect(cc.id).toBeGreaterThan(0);

    const bt: any = await conn.em.save(BankTransferPayment, {
      amount: 400,
      bankCode: "IBAN123",
      storeFk: store.id,
    });
    expect(bt.id).toBeGreaterThan(0);
  });

  it("should find TPT child with parent columns and relation via JOIN", async () => {
    const results = await conn.em.find(CreditCardPayment, {
      relations: ["store"],
    });
    const arr = Array.isArray(results) ? results : results ? [results] : [];
    expect(arr.length).toBeGreaterThanOrEqual(1);

    const cc = arr[0] as any;
    expect(cc.amount).toBeDefined();
    expect(cc.cardNumber).toBeDefined();
    expect(cc.store).toBeDefined();
    expect(cc.store.storeName).toBe("TPTStore");
  });

  it("should find TPT child with findOne + relation", async () => {
    const result = await conn.em.findOne(CreditCardPayment, {
      where: { amount: 300 },
      relations: ["store"],
    });
    expect(result).toBeDefined();
    expect((result as any).cardNumber).toBe("5555-5555");
    expect((result as any).store).toBeDefined();
    expect((result as any).store.storeName).toBe("TPTStore");
  });

  it("should find TPT polymorphic results with correct subclass types", async () => {
    const all = await conn.em.find(Payment, {});
    const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];

    expect(allArray.length).toBeGreaterThanOrEqual(2);

    const ccPayments = allArray.filter((p) => p instanceof CreditCardPayment);
    const btPayments = allArray.filter((p) => p instanceof BankTransferPayment);

    expect(ccPayments.length).toBeGreaterThanOrEqual(1);
    expect(btPayments.length).toBeGreaterThanOrEqual(1);

    for (const cc of ccPayments) {
      expect(cc.cardNumber).toBeDefined();
    }
    for (const bt of btPayments) {
      expect(bt.bankCode).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TPC + Relations
// ═══════════════════════════════════════════════════════════════

describe("[Integration] SQLite: TPC + Relations", () => {
  let conn: TestConnectionResult;
  let Store: any;
  let Payment: any;
  let CreditCardPayment: any;
  let BankTransferPayment: any;
  let storeTableName: string;
  let rootTableName: string;
  let ccTableName: string;
  let btTableName: string;

  beforeAll(async () => {
    storeTableName = shortTableName("tpc_rstr");
    rootTableName = shortTableName("tpc_rpay");
    ccTableName = shortTableName("tpc_rcc");
    btTableName = shortTableName("tpc_rbt");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: storeTableName })
        class StoreEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() storeName!: string;
        }

        @Entity({ name: rootTableName })
        @Inheritance({ strategy: "TABLE_PER_CLASS" })
        @DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
          @Column({ type: "int", nullable: true }) storeFk!: number;
          @ManyToOne(() => StoreEntity, (e: any) => e.store, {
            joinColumn: "storeFk",
            eager: false,
            createForeignKeyConstraints: false,
          })
          store!: any;
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

        Store = StoreEntity;
        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        BankTransferPayment = BankTransferPaymentEntity;

        return {
          entities: [StoreEntity, PaymentEntity, CreditCardPaymentEntity, BankTransferPaymentEntity],
        };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("should insert TPC child entities with FK", async () => {
    const store: any = await conn.em.save(Store, { storeName: "TPCStore" });
    expect(store.id).toBeGreaterThan(0);

    const cc: any = await conn.em.save(CreditCardPayment, {
      amount: 500,
      cardNumber: "9999-9999",
      storeFk: store.id,
    });
    expect(cc.id).toBeGreaterThan(0);

    const bt: any = await conn.em.save(BankTransferPayment, {
      amount: 600,
      bankCode: "ROUTE999",
      storeFk: store.id,
    });
    expect(bt.id).toBeGreaterThan(0);
  });

  it("should find TPC child entity from its own table", async () => {
    const results = await conn.em.find(CreditCardPayment, {});
    const arr = Array.isArray(results) ? results : results ? [results] : [];
    expect(arr.length).toBeGreaterThanOrEqual(1);

    const cc = arr[0] as any;
    expect(cc.amount).toBeDefined();
    expect(cc.cardNumber).toBeDefined();
  });

  it("should find ALL payments via UNION ALL (polymorphic)", async () => {
    const all = await conn.em.find(Payment, {});
    const allArray = (Array.isArray(all) ? all : all ? [all] : []) as any[];

    expect(allArray.length).toBeGreaterThanOrEqual(2);

    const ccPayments = allArray.filter((p) => p instanceof CreditCardPayment);
    const btPayments = allArray.filter((p) => p instanceof BankTransferPayment);

    expect(ccPayments.length).toBeGreaterThanOrEqual(1);
    expect(btPayments.length).toBeGreaterThanOrEqual(1);
  });

  it("should find TPC child with findOne", async () => {
    const result = await conn.em.findOne(CreditCardPayment, {
      where: { amount: 500 },
    });
    expect(result).toBeDefined();
    expect((result as any).cardNumber).toBe("9999-9999");
    expect((result as any).amount).toBe(500);
  });
});

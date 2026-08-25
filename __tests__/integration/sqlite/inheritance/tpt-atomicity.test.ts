/**
 * SQLite In-Memory: TPT (JOINED) 다중 테이블 쓰기 원자성 검증
 *
 * TPT 자식 저장은 부모 테이블 INSERT → 자식 테이블 INSERT 2문장이다.
 * 자식 INSERT가 실패하면 부모 행도 남아서는 안 되고(고아 부모 = 부분
 * 쓰기), 명시적 트랜잭션 롤백 시 두 테이블 모두 원복되어야 한다.
 *
 * mock 호출 수가 아니라 실제 persisted state(테이블 행 수)를 단언한다.
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

describe("[Integration] SQLite: TPT 다중 테이블 쓰기 원자성", () => {
  let conn: TestConnectionResult;
  let Payment: any;
  let CreditCardPayment: any;
  let rootTableName: string;
  let ccTableName: string;

  async function countRows(table: string): Promise<number> {
    const driver = conn.em.getDriver()!;
    const raw: any = await driver.executeRaw(
      `SELECT COUNT(*) AS cnt FROM "${table}"`,
    );
    const rows: any[] = Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
    return Number(rows[0]?.cnt ?? rows[0]?.["COUNT(*)"] ?? 0);
  }

  beforeAll(async () => {
    rootTableName = shortTableName("tpta_pay");
    ccTableName = shortTableName("tpta_cc");

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
        @DiscriminatorColumn({
          name: "payment_type",
          type: "varchar",
          length: 50,
        })
        class PaymentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() amount!: number;
        }

        @Entity({ name: ccTableName })
        @DiscriminatorValue("credit_card")
        class CreditCardPaymentEntity extends PaymentEntity {
          // NOT NULL(기본값 없음): cardNumber 누락 저장 → 자식 INSERT만 실패
          @Column() cardNumber!: string;
        }

        Payment = PaymentEntity;
        CreditCardPayment = CreditCardPaymentEntity;
        return { entities: [PaymentEntity, CreditCardPaymentEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("자식 INSERT 실패 시 부모 행이 남지 않는다 (고아 부모 = 부분 쓰기 금지)", async () => {
    // cardNumber(NOT NULL) 누락 → 부모 INSERT 성공 후 자식 INSERT가
    // NOT NULL 위반으로 실패한다. save 전체가 한 트랜잭션이므로 부모
    // 행도 롤백되어야 한다.
    await expect(
      conn.em.save(CreditCardPayment, { amount: 100 } as any),
    ).rejects.toThrow();

    expect(await countRows(rootTableName)).toBe(0);
    expect(await countRows(ccTableName)).toBe(0);
  });

  it("명시적 트랜잭션 롤백 시 부모/자식 두 테이블 모두 원복된다", async () => {
    await expect(
      conn.em.transaction(async (tx: any) => {
        await tx.save(CreditCardPayment, {
          amount: 200,
          cardNumber: "4111-xxxx",
        });
        // 저장 자체는 성공 — 이후 강제 실패로 전체 롤백
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(await countRows(rootTableName)).toBe(0);
    expect(await countRows(ccTableName)).toBe(0);
  });

  it("정상 저장은 부모/자식 각 1행씩 남긴다 (sanity)", async () => {
    const saved: any = await conn.em.save(CreditCardPayment, {
      amount: 300,
      cardNumber: "4222-xxxx",
    });
    expect(saved.id).toBeDefined();
    expect(await countRows(rootTableName)).toBe(1);
    expect(await countRows(ccTableName)).toBe(1);

    // 다음 테스트 영향 없도록 정리
    await conn.em.delete(CreditCardPayment, { id: saved.id } as any);
    expect(await countRows(rootTableName)).toBe(0);
    expect(await countRows(ccTableName)).toBe(0);
  });
});

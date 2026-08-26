/**
 * SQLite In-Memory: TPT (JOINED) + @Version 낙관적 잠금 UPDATE 계약
 *
 * TPT 자식 UPDATE는 부모/자식 테이블 2문장으로 분리 실행된다. 이때
 * 일반(단일 테이블) UPDATE 경로의 낙관적 잠금 계약이 그대로 지켜져야 한다:
 *
 * 1. version 컬럼은 루트 테이블에만 있으므로 version WHERE 가드가 자식
 *    UPDATE로 새면 안 된다 (새면 "no such column" SQL 에러).
 * 2. stale version으로 부모 UPDATE가 0행 매치되면 OptimisticLockError를
 *    던져야 한다 — 조용한 no-op 후 예전 행을 돌려주는 것 금지.
 *
 * mock이 아니라 실제 persisted state(재조회 값)를 단언한다.
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
  Version,
  OptimisticLockError,
} from "../../../../src";
import { getScannerInstance } from "../../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

describe("[Integration] SQLite: TPT + @Version UPDATE 계약", () => {
  let conn: TestConnectionResult;
  let ReviewedDocument: any;
  let rootTableName: string;
  let childTableName: string;

  beforeAll(async () => {
    rootTableName = shortTableName("tptv_doc");
    childTableName = shortTableName("tptv_rev");

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
        @DiscriminatorColumn({ name: "doc_type", type: "varchar", length: 50 })
        class DocumentEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @Version() version!: number;
        }

        @Entity({ name: childTableName })
        @DiscriminatorValue("reviewed")
        class ReviewedDocumentEntity extends DocumentEntity {
          @Column() reviewer!: string;
        }

        ReviewedDocument = ReviewedDocumentEntity;
        return { entities: [DocumentEntity, ReviewedDocumentEntity] };
      },
    );
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("부모 컬럼만 갱신하면 version이 증가한다 (sanity)", async () => {
    const saved: any = await conn.em.save(ReviewedDocument, {
      title: "draft",
      reviewer: "alice",
    });
    expect(saved.version).toBe(1);

    const updated: any = await conn.em.save(ReviewedDocument, {
      id: saved.id,
      title: "v2",
      version: saved.version,
    });
    expect(updated.title).toBe("v2");
    expect(updated.version).toBe(2);
  });

  it("자식 컬럼 갱신 시 version 가드가 자식 UPDATE로 새지 않는다", async () => {
    const saved: any = await conn.em.save(ReviewedDocument, {
      title: "guarded",
      reviewer: "bob",
    });

    // version 컬럼은 루트 테이블에만 있다. WHERE 가드가 자식 UPDATE에
    // 그대로 실리면 "no such column: version"으로 죽는다.
    const updated: any = await conn.em.save(ReviewedDocument, {
      id: saved.id,
      reviewer: "carol",
      version: saved.version,
    });
    expect(updated.reviewer).toBe("carol");
    expect(updated.version).toBe(saved.version + 1);

    const reread: any = await conn.em.findOne(ReviewedDocument, {
      where: { id: saved.id } as any,
    });
    expect(reread.reviewer).toBe("carol");
  });

  it("stale version이면 OptimisticLockError를 던지고 아무것도 쓰지 않는다", async () => {
    const saved: any = await conn.em.save(ReviewedDocument, {
      title: "original",
      reviewer: "dave",
    });
    const bumped: any = await conn.em.save(ReviewedDocument, {
      id: saved.id,
      title: "bumped",
      version: saved.version,
    });
    expect(bumped.version).toBe(saved.version + 1);

    // 이미 지나간 version으로 다시 쓰기 — 부모 UPDATE가 0행 매치
    await expect(
      conn.em.save(ReviewedDocument, {
        id: saved.id,
        title: "stale write",
        version: saved.version,
      }),
    ).rejects.toThrow(OptimisticLockError);

    const reread: any = await conn.em.findOne(ReviewedDocument, {
      where: { id: saved.id } as any,
    });
    expect(reread.title).toBe("bumped");
    expect(reread.version).toBe(saved.version + 1);
  });

  it("stale version + 자식 컬럼 갱신도 OptimisticLockError — 자식 테이블에 부분 쓰기가 남지 않는다", async () => {
    const saved: any = await conn.em.save(ReviewedDocument, {
      title: "mixed",
      reviewer: "erin",
    });
    const bumped: any = await conn.em.save(ReviewedDocument, {
      id: saved.id,
      title: "mixed v2",
      version: saved.version,
    });

    // 부모 UPDATE(0행)가 낙관적 잠금 실패를 감지하면, PK로만 필터하는
    // 자식 UPDATE가 실행되기 전에 중단돼야 한다(또는 롤백돼야 한다).
    await expect(
      conn.em.save(ReviewedDocument, {
        id: saved.id,
        title: "stale",
        reviewer: "mallory",
        version: saved.version,
      }),
    ).rejects.toThrow(OptimisticLockError);

    const reread: any = await conn.em.findOne(ReviewedDocument, {
      where: { id: saved.id } as any,
    });
    expect(reread.reviewer).toBe("erin");
    expect(reread.title).toBe("mixed v2");
    expect(reread.version).toBe(bumped.version);
  });
});

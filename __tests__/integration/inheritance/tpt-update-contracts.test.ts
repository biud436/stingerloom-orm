/**
 * MySQL / PostgreSQL: TPT (JOINED) UPDATE 계약 듀얼 드라이버 통합 테스트
 *
 * SQLite 재현(sqlite/inheritance/tpt-atomicity, tpt-version-update)의
 * 실 DB 미러 — TPT 자식 UPDATE는 부모/자식 2문장으로 분리 실행되며,
 * 일반(단일 테이블) UPDATE 경로와 같은 계약을 지켜야 한다:
 *
 * 1. @Version WHERE 가드는 루트 테이블 UPDATE에만 실린다 (자식 테이블에는
 *    version 컬럼이 없다).
 * 2. stale version → OptimisticLockError, 자식 테이블 부분 쓰기 금지.
 * 3. 존재하지 않는 PK → EntityNotFoundError (조용한 no-op 금지) —
 *    MySQL은 값-동일 UPDATE도 affectedRows 0이므로 존재 프로브 경유.
 * 4. 자식 UPDATE 실패 시 부모 UPDATE도 롤백 (다중 테이블 원자성).
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
  Version,
  EntityNotFoundError,
  OptimisticLockError,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

function shortTable(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-6)}`;
}

const drivers = getTestDrivers();

describe.each(drivers)(
  "[Integration] $label: TPT UPDATE 계약",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let ReviewedDocument: any;
    let rootTable: string;
    let childTable: string;

    beforeAll(async () => {
      rootTable = shortTable("tptu_doc");
      childTable = shortTable("tptu_rev");

      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          clearScanners();

          @Entity({ name: rootTable })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "doc_type", type: "varchar", length: 50 })
          class DocumentEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @Version() version!: number;
          }

          @Entity({ name: childTable })
          @DiscriminatorValue("reviewed")
          class ReviewedDocumentEntity extends DocumentEntity {
            // NOT NULL: 부분 실패 원자성 테스트에서 자식 UPDATE만 실패시키는 지렛대
            @Column() reviewer!: string;
          }

          ReviewedDocument = ReviewedDocumentEntity;
          return { entities: [DocumentEntity, ReviewedDocumentEntity] };
        },
      );
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      try { await dropTestTable(childTable); } catch { /* ignore */ }
      try { await dropTestTable(rootTable); } catch { /* ignore */ }
      await conn.cleanup();
    }, 15000);

    it("자식 컬럼 갱신 시 version 가드가 자식 UPDATE로 새지 않는다", async () => {
      const saved: any = await conn.em.save(ReviewedDocument, {
        title: "guarded",
        reviewer: "bob",
      });
      expect(saved.version).toBe(1);

      const updated: any = await conn.em.save(ReviewedDocument, {
        id: saved.id,
        reviewer: "carol",
        version: saved.version,
      });
      expect(updated.reviewer).toBe("carol");
      expect(Number(updated.version)).toBe(saved.version + 1);
    });

    it("stale version이면 OptimisticLockError — 자식 테이블 부분 쓰기가 남지 않는다", async () => {
      const saved: any = await conn.em.save(ReviewedDocument, {
        title: "original",
        reviewer: "dave",
      });
      const bumped: any = await conn.em.save(ReviewedDocument, {
        id: saved.id,
        title: "bumped",
        version: saved.version,
      });

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
      expect(reread.title).toBe("bumped");
      expect(reread.reviewer).toBe("dave");
      expect(Number(reread.version)).toBe(Number(bumped.version));
    });

    it("존재하지 않는 PK로 자식을 save() 하면 EntityNotFoundError를 던진다", async () => {
      await expect(
        conn.em.save(ReviewedDocument, {
          id: 987654,
          title: "ghost",
          reviewer: "nobody",
          version: undefined,
        } as any),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it("UPDATE 부분 실패(자식 NOT NULL 위반) 시 부모 테이블 변경도 롤백된다", async () => {
      const saved: any = await conn.em.save(ReviewedDocument, {
        title: "atomic",
        reviewer: "erin",
      });

      // 부모(title) UPDATE 성공 후 자식 UPDATE가 reviewer NOT NULL 위반으로
      // 실패한다. 한 트랜잭션이므로 부모 변경도 원복돼야 한다.
      let rejection: unknown;
      try {
        await conn.em.save(ReviewedDocument, {
          id: saved.id,
          title: "partial",
          reviewer: null,
          version: saved.version,
        } as any);
      } catch (e) {
        rejection = e;
      }
      expect(rejection).toBeDefined();
      expect(rejection).not.toBeInstanceOf(OptimisticLockError);

      const reread: any = await conn.em.findOne(ReviewedDocument, {
        where: { id: saved.id } as any,
      });
      expect(reread.title).toBe("atomic");
      expect(reread.reviewer).toBe("erin");
      expect(Number(reread.version)).toBe(Number(saved.version));
    });
  },
);

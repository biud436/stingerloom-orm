/**
 * ManyToMany 관계 통합 테스트
 *
 * @ManyToMany 데코레이터를 사용한 다대다 관계의
 * 중간 테이블 생성, 데이터 삽입, relations 옵션 로딩을 검증합니다.
 *
 * 엔티티 구조:
 * - PostClass: id, title
 * - TagClass: id, label
 * - 중간 테이블: <joinTableName>(post_id, tag_id)
 *
 * NOTE: 현재 ORM은 ManyToMany 중간 테이블을 자동 생성하지 않으므로
 * rawQuery()로 수동 생성합니다.
 *
 * 실행 전 필요 사항:
 * - MySQL 또는 PostgreSQL 서버 실행 중
 * - 연결 정보가 유효
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToMany,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner, ManyToManyScanner } from "../../src/scanner";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import {
  qi,
  disableFkChecksSql,
  enableFkChecksSql,
  createJoinTableSql,
  setAutocommitSql,
} from "./helpers/driver-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// DML 헬퍼: 트랜잭션을 올바르게 관리하여 pool 상태를 깨끗하게 유지
// ─────────────────────────────────────────────────────────────────────────────

async function execDml(driverType: TestDriverType, sqlStr: string): Promise<any> {
  const tx = new TransactionSessionManager();
  try {
    await tx.connect();
    // autocommit 리셋 (이전 ORM 트랜잭션이 0으로 남겨놨을 수 있음)
    const autocommitSql = setAutocommitSql(driverType, 1);
    if (autocommitSql) {
      await tx.query(autocommitSql);
    }
    await tx.startTransaction();
    const result = await tx.query(sqlStr);
    await tx.commit();
    return result;
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    throw e;
  } finally {
    try { await tx.close(); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리
// ─────────────────────────────────────────────────────────────────────────────

interface ManyToManyEntitiesResult {
  PostClass: new () => any;
  TagClass: new () => any;
  postTableName: string;
  tagTableName: string;
  joinTableName: string;
}

function shortName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function createManyToManyTestEntities(): ManyToManyEntitiesResult {
  const postTableName = shortName("mp");
  const tagTableName = shortName("mt");
  const joinTableName = shortName("mj");

  // 스캐너 초기화
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();

  // ── TagClass ──────────────────────────────────────────────────────────────
  const TagClass = class {} as any;
  Object.defineProperty(TagClass, "name", {
    value: tagTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, TagClass.prototype, "id");
  PrimaryGeneratedColumn()(TagClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, TagClass.prototype, "label");
  Column({ type: "varchar", length: 100 })(TagClass.prototype, "label");

  Entity()(TagClass);

  // ── PostClass ─────────────────────────────────────────────────────────────
  const PostClass = class {} as any;
  Object.defineProperty(PostClass, "name", {
    value: postTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, PostClass.prototype, "id");
  PrimaryGeneratedColumn()(PostClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, PostClass.prototype, "title");
  Column({ type: "varchar", length: 255 })(PostClass.prototype, "title");

  // @ManyToMany (소유측): joinTable 설정
  Reflect.defineMetadata("design:type", Array, PostClass.prototype, "tags");
  ManyToMany(() => TagClass, {
    joinTable: {
      name: joinTableName,
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })(PostClass.prototype, "tags");

  Entity()(PostClass);

  return {
    PostClass,
    TagClass,
    postTableName,
    tagTableName,
    joinTableName,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] ManyToMany 관계 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: ManyToManyEntitiesResult;
    let postRepo: BaseRepository<any>;
    let tagRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createManyToManyTestEntities();
          return { entities: [entities.TagClass, entities.PostClass] };
        },
      );
      em = conn.em;
      postRepo = em.getRepository(entities.PostClass);
      tagRepo = em.getRepository(entities.TagClass);

      // 중간 테이블 수동 생성 (ORM이 자동 생성하지 않으므로)
      await rawQuery(
        createJoinTableSql(
          type,
          entities.joinTableName,
          "post_id",
          "tag_id",
          entities.postTableName,
          "id",
          entities.tagTableName,
          "id",
        ),
      );
    }, 30000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        await dropTestTable(entities.joinTableName);
        await dropTestTable(entities.postTableName);
        await dropTestTable(entities.tagTableName);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      // FK 제약 때문에 중간 테이블 먼저 삭제
      await execDml(type, `DELETE FROM ${qi(type, entities.joinTableName)}`);
      await execDml(type, `DELETE FROM ${qi(type, entities.postTableName)}`);
      await execDml(type, `DELETE FROM ${qi(type, entities.tagTableName)}`);
    });

    // ─── 중간 테이블 데이터 삽입 및 검증 ─────────────────────────────────────

    describe("중간 테이블 데이터", () => {
      it("Post와 Tag를 생성하고 중간 테이블에 관계를 삽입할 수 있어야 한다", async () => {
        const post = await postRepo.save({ title: "First Post" });
        const tag = await tagRepo.save({ label: "TypeScript" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES (${post.id}, ${tag.id})`,
        );

        const rows = await rawQuery(
          `SELECT * FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "post_id")} = ${post.id}`,
        );
        const rs = rows?.results ?? rows;
        const data = Array.isArray(rs) ? rs : [rs];
        expect(data.length).toBe(1);
        expect(Number(data[0].post_id)).toBe(post.id);
        expect(Number(data[0].tag_id)).toBe(tag.id);
      });

      it("하나의 Post에 여러 Tag를 연결할 수 있어야 한다", async () => {
        const post = await postRepo.save({ title: "Multi-tag Post" });
        const tag1 = await tagRepo.save({ label: "JS" });
        const tag2 = await tagRepo.save({ label: "TS" });
        const tag3 = await tagRepo.save({ label: "Node" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES
           (${post.id}, ${tag1.id}),
           (${post.id}, ${tag2.id}),
           (${post.id}, ${tag3.id})`,
        );

        const rows = await rawQuery(
          `SELECT * FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "post_id")} = ${post.id}`,
        );
        const rs = rows?.results ?? rows;
        const data = Array.isArray(rs) ? rs : [rs];
        expect(data.length).toBe(3);
      });

      it("하나의 Tag에 여러 Post를 연결할 수 있어야 한다", async () => {
        const tag = await tagRepo.save({ label: "Shared Tag" });
        const post1 = await postRepo.save({ title: "Post A" });
        const post2 = await postRepo.save({ title: "Post B" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES
           (${post1.id}, ${tag.id}),
           (${post2.id}, ${tag.id})`,
        );

        const rows = await rawQuery(
          `SELECT * FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "tag_id")} = ${tag.id}`,
        );
        const rs = rows?.results ?? rows;
        const data = Array.isArray(rs) ? rs : [rs];
        expect(data.length).toBe(2);
      });
    });

    // ─── relations 옵션으로 ManyToMany 로드 ──────────────────────────────────

    describe("relations 옵션으로 ManyToMany 로드", () => {
      it("find({ relations: ['tags'] })로 Post의 Tag 목록을 로드할 수 있어야 한다", async () => {
        const post = await postRepo.save({ title: "Relations Post" });
        const tag1 = await tagRepo.save({ label: "Alpha" });
        const tag2 = await tagRepo.save({ label: "Beta" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES
           (${post.id}, ${tag1.id}),
           (${post.id}, ${tag2.id})`,
        );

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        const posts = Array.isArray(result) ? result : [result];
        const found = posts[0];

        expect(found).toBeDefined();
        expect(found.tags).toBeDefined();
        expect(Array.isArray(found.tags)).toBe(true);
        expect(found.tags.length).toBe(2);
      });

      it("로드된 Tag의 id와 label이 올바르게 매핑되어야 한다", async () => {
        const post = await postRepo.save({ title: "Label Check" });
        const tag = await tagRepo.save({ label: "Gamma" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES (${post.id}, ${tag.id})`,
        );

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        const posts = Array.isArray(result) ? result : [result];
        const loadedTags = posts[0]?.tags;

        expect(loadedTags).toBeDefined();
        expect(loadedTags.length).toBe(1);
        expect(loadedTags[0].id).toBe(tag.id);
        expect(loadedTags[0].label).toBe("Gamma");
      });

      it("관련 Tag가 없는 Post의 tags는 빈 배열이어야 한다", async () => {
        const post = await postRepo.save({ title: "No Tags" });

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        const posts = Array.isArray(result) ? result : [result];
        const found = posts[0];

        expect(found).toBeDefined();
        expect(found.tags).toBeDefined();
        expect(found.tags.length).toBe(0);
      });

      it("relations 없이 조회하면 tags가 로드되지 않아야 한다", async () => {
        const post = await postRepo.save({ title: "No Relations" });
        const tag = await tagRepo.save({ label: "Hidden" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES (${post.id}, ${tag.id})`,
        );

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
        } as any);
        const posts = Array.isArray(result) ? result : [result];
        const found = posts[0];

        // tags가 undefined이거나 빈 배열이어야 한다
        const tags = found?.tags;
        const isEmpty =
          tags === undefined ||
          tags === null ||
          (Array.isArray(tags) && tags.length === 0);
        expect(isEmpty).toBe(true);
      });
    });

    // ─── 중간 테이블 변경 ─────────────────────────────────────────────────────

    describe("중간 테이블 변경", () => {
      it("중간 테이블에서 관계를 삭제하면 relations 로드 결과에 반영되어야 한다", async () => {
        const post = await postRepo.save({ title: "Remove Tag" });
        const tag1 = await tagRepo.save({ label: "Keep" });
        const tag2 = await tagRepo.save({ label: "Remove" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES
           (${post.id}, ${tag1.id}),
           (${post.id}, ${tag2.id})`,
        );

        // tag2 관계 삭제
        await execDml(
          type,
          `DELETE FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "post_id")} = ${post.id} AND ${qi(type, "tag_id")} = ${tag2.id}`,
        );

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        const posts = Array.isArray(result) ? result : [result];
        const found = posts[0];

        expect(found.tags.length).toBe(1);
        expect(found.tags[0].label).toBe("Keep");
      });

      it("중간 테이블의 모든 관계를 삭제하면 빈 배열이 반환되어야 한다", async () => {
        const post = await postRepo.save({ title: "Clear All" });
        const tag = await tagRepo.save({ label: "Temporary" });

        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES (${post.id}, ${tag.id})`,
        );

        // 모든 관계 삭제
        await execDml(
          type,
          `DELETE FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "post_id")} = ${post.id}`,
        );

        const result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        const posts = Array.isArray(result) ? result : [result];

        expect(posts[0].tags.length).toBe(0);
      });
    });

    // ─── 전체 라이프사이클 ────────────────────────────────────────────────────

    describe("전체 ManyToMany 라이프사이클", () => {
      it("Post 생성 → Tag 생성 → 관계 삽입 → 조회 → 관계 삭제 → 재조회", async () => {
        // 1. Post + Tag 생성
        const post = await postRepo.save({ title: "Lifecycle Post" });
        const tag1 = await tagRepo.save({ label: "LC-Tag1" });
        const tag2 = await tagRepo.save({ label: "LC-Tag2" });

        // 2. 관계 삽입
        await execDml(
          type,
          `INSERT INTO ${qi(type, entities.joinTableName)} (${qi(type, "post_id")}, ${qi(type, "tag_id")}) VALUES
           (${post.id}, ${tag1.id}),
           (${post.id}, ${tag2.id})`,
        );

        // 3. 조회 확인 — 2개 tag
        let result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        let posts = Array.isArray(result) ? result : [result];
        expect(posts[0].tags.length).toBe(2);

        // 4. tag1 관계 삭제
        await execDml(
          type,
          `DELETE FROM ${qi(type, entities.joinTableName)} WHERE ${qi(type, "post_id")} = ${post.id} AND ${qi(type, "tag_id")} = ${tag1.id}`,
        );

        // 5. 재조회 — 1개 tag
        result = await em.find(entities.PostClass, {
          where: { id: post.id },
          relations: ["tags"],
        } as any);
        posts = Array.isArray(result) ? result : [result];
        expect(posts[0].tags.length).toBe(1);
        expect(posts[0].tags[0].label).toBe("LC-Tag2");
      });
    });
  },
);

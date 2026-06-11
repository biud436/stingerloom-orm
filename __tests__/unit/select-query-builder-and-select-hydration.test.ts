/**
 * Issue #370: *AndSelect 조인 컬럼 alias + 엔티티 결과 중첩 하이드레이션 검증.
 *
 * - 조인 컬럼은 `alias_column` AS alias로 SELECT되어 루트 컬럼을 덮어쓰지 않음
 * - getMany()/getOne()에서 prefix 분리 후 관계 프로퍼티로 중첩
 * - ManyToOne/OneToOne: 객체, OneToMany: 배열 그룹핑 (루트 dedup)
 * - LEFT JOIN 미스: to-one → null, to-many → 빈 배열
 * - getRawMany()는 prefixed key 유지
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class HydUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @OneToMany(() => HydComment, { mappedBy: "user" })
  comments!: HydComment[];
}

@Entity()
class HydComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "int", nullable: true })
  userId!: number | null;

  @ManyToOne(
    () => HydUser,
    (e: any) => e.user,
  )
  user!: HydUser | null;
}

function createMockEm(rows: any[] = []) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  const queryMock = jest.fn().mockResolvedValue(rows);

  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDialect: () => "mysql",
    },
    query: queryMock,
  } as unknown as EntityManager;

  return { em, queryMock };
}

describe("*AndSelect SQL — alias 부여 (#370)", () => {
  it("조인 컬럼과 루트 컬럼 모두 alias_column으로 SELECT되어야 한다", () => {
    const { em } = createMockEm();
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const { text } = qb.getSql();
    // 루트 * 확장: `c`.`id` AS `c_id`
    expect(text).toContain("`c`.`id` AS `c_id`");
    expect(text).toContain("`c`.`content` AS `c_content`");
    // 조인 컬럼 alias: `u`.`id` AS `u_id`
    expect(text).toContain("`u`.`id` AS `u_id`");
    expect(text).toContain("`u`.`username` AS `u_username`");
    // SELECT 절에는 un-aliased 중복 컬럼이 없어야 함 (ON 절 제외)
    const selectClause = text.substring(0, text.indexOf(" FROM "));
    expect(selectClause).not.toMatch(/`u`\.`id`(?! AS)/);
    expect(selectClause).not.toContain("`c`.*");
  });
});

describe("getMany() — ManyToOne 중첩 하이드레이션 (#370)", () => {
  it("루트 PK가 보존되고 관계 프로퍼티가 채워져야 한다 (이슈 repro)", async () => {
    // 이슈 시나리오: 모든 comment가 user 1에 속함 — 이전에는
    // 조인된 user.id가 comment.id를 덮어써 전부 1로 보였다.
    const rows = [
      { c_id: 1, c_content: "c1", c_userId: 1, u_id: 1, u_username: "alice" },
      { c_id: 2, c_content: "c2", c_userId: 1, u_id: 1, u_username: "alice" },
      { c_id: 3, c_content: "c3", c_userId: 1, u_id: 1, u_username: "alice" },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const result = await qb.getMany();

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(result[0]).toBeInstanceOf(HydComment);
    for (const r of result) {
      expect(r.user).toBeInstanceOf(HydUser);
      expect(r.user!.id).toBe(1);
      expect(r.user!.username).toBe("alice");
    }
  });

  it("LEFT JOIN 미스(전부 NULL)는 관계를 null로 설정해야 한다", async () => {
    const rows = [
      { c_id: 1, c_content: "c1", c_userId: 1, u_id: 1, u_username: "alice" },
      { c_id: 2, c_content: "orphan", c_userId: null, u_id: null, u_username: null },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const result = await qb.getMany();

    expect(result).toHaveLength(2);
    expect(result[0].user).toBeInstanceOf(HydUser);
    expect(result[1].user).toBeNull();
  });

  it("getOne()도 동일하게 중첩되어야 한다", async () => {
    const rows = [
      { c_id: 7, c_content: "only", c_userId: 2, u_id: 2, u_username: "bob" },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const one = await qb.getOne();

    expect(one).not.toBeNull();
    expect(one!.id).toBe(7);
    expect(one!.user!.username).toBe("bob");
  });
});

describe("getMany() — OneToMany 배열 그룹핑 (#370)", () => {
  it("같은 루트의 여러 조인 행이 하나의 엔티티 + 배열로 그룹핑되어야 한다", async () => {
    const rows = [
      { u_id: 1, u_username: "alice", cm_id: 10, cm_content: "a", cm_userId: 1 },
      { u_id: 1, u_username: "alice", cm_id: 11, cm_content: "b", cm_userId: 1 },
      { u_id: 2, u_username: "bob", cm_id: null, cm_content: null, cm_userId: null },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydUser>(HydUser, "u", em);
    qb.leftJoinRelationAndSelect("comments", "cm");

    const result = await qb.getMany();

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[0].comments).toHaveLength(2);
    expect(result[0].comments.map((c) => c.id)).toEqual([10, 11]);
    expect(result[0].comments[0]).toBeInstanceOf(HydComment);
    // LEFT JOIN 미스 → 빈 배열
    expect(result[1].id).toBe(2);
    expect(result[1].comments).toEqual([]);
  });
});

describe("getMany() — 엔티티 조인 leftJoinAndSelect 관계 매칭 (#370)", () => {
  it("조인 대상 엔티티가 관계와 일치하면 자동으로 중첩되어야 한다", async () => {
    const rows = [
      { c_id: 1, c_content: "c1", c_userId: 1, u_id: 1, u_username: "alice" },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinAndSelect(HydUser, "u", (j) => j.on("c.userId", "=", "u.id"));

    const result = await qb.getMany();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    expect(result[0].user).toBeInstanceOf(HydUser);
    expect(result[0].user!.username).toBe("alice");
  });
});

describe("getRawMany() — prefixed key 유지 (#370)", () => {
  it("raw 결과는 alias_column 키를 그대로 노출해야 한다", async () => {
    const rows = [
      { c_id: 1, c_content: "c1", c_userId: 1, u_id: 1, u_username: "alice" },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const raw = await qb.getRawMany();

    expect(raw).toHaveLength(1);
    expect(raw[0]).toHaveProperty("c_id", 1);
    expect(raw[0]).toHaveProperty("u_id", 1);
    expect(raw[0]).toHaveProperty("u_username", "alice");
  });
});

describe("clone() — joinedSelections 복사 (#370)", () => {
  it("clone된 빌더에서도 중첩 하이드레이션이 동작해야 한다", async () => {
    const rows = [
      { c_id: 1, c_content: "c1", c_userId: 1, u_id: 1, u_username: "alice" },
    ];
    const { em } = createMockEm(rows);
    const qb = new SelectQueryBuilder<HydComment>(HydComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const result = await qb.clone().getMany();

    expect(result).toHaveLength(1);
    expect(result[0].user!.username).toBe("alice");
  });
});

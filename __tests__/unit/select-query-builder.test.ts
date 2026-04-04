import "reflect-metadata";
import { SelectQueryBuilder, WhereOperator } from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

// ── Test Entities ──────────────────────────────────────────
// @Entity uses camelToSnakeCase(className) as table name:
//   User → "user", Post → "post", SoftItem → "soft_item"

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "datetime" })
  createdAt!: Date;
}

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "int" })
  authorId!: number;
}

@Entity()
class SoftItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

// ── Mock EntityManager ─────────────────────────────────────

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();

  function wrap(col: string) {
    if (dbType === "mysql") {
      return `\`${col.replace(/`/g, "``")}\``;
    }
    return `"${col.replace(/"/g, '""')}"`;
  }

  const em = {
    wrap,
    wrapTable(tableName: string) {
      return wrap(tableName);
    },
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;

  return em;
}

// ── Tests ──────────────────────────────────────────────────

describe("SelectQueryBuilder", () => {
  describe("basic SELECT", () => {
    it("should generate SELECT * FROM with alias (MySQL)", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const { text } = qb.getSql();

      expect(text).toContain("SELECT `u`.*");
      expect(text).toContain("FROM `user` AS `u`");
    });

    it("should generate PostgreSQL-style identifiers", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const { text } = qb.getSql();

      expect(text).toContain('SELECT "u".*');
      expect(text).toContain('FROM "user" AS "u"');
    });

    it("should select specific columns with type-safe references", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.select(["id", "name", "email"]);
      const { text } = qb.getSql();

      expect(text).toContain("`u`.`id`");
      expect(text).toContain("`u`.`name`");
      expect(text).toContain("`u`.`email`");
      expect(text).not.toContain("`u`.`age`");
    });

    it("should support SELECT DISTINCT", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.select(["status"]).setDistinct();
      const { text } = qb.getSql();

      expect(text).toContain("SELECT DISTINCT");
      expect(text).toContain("`u`.`status`");
    });
  });

  describe("WHERE conditions", () => {
    it("should generate simple equals condition (2-arg)", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("name", "Alice");
      const { text, values } = qb.getSql();

      expect(text).toContain("WHERE");
      expect(text).toContain("`u`.`name` = ?");
      expect(values).toContain("Alice");
    });

    it("should generate operator condition (3-arg)", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("age", ">=", 18);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`age` >= ?");
      expect(values).toContain(18);
    });

    it("should support raw Sql condition", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where(Conditions.like("`u`.`name`", "%alice%"));
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`name` LIKE ?");
      expect(values).toContain("%alice%");
    });

    it("should chain multiple AND conditions", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("status", "active").andWhere("age", ">=", 18);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`status` = ?");
      expect(text).toContain("`u`.`age` >= ?");
      expect(values).toEqual(["active", 18]);
    });

    it("should handle NULL condition", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("email", null);
      const { text } = qb.getSql();

      expect(text).toContain("`u`.`email` IS NULL");
    });

    it("should handle whereNull()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereNull("email");
      const { text } = qb.getSql();

      expect(text).toContain("`u`.`email` IS NULL");
    });

    it("should handle whereNotNull()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereNotNull("email");
      const { text } = qb.getSql();

      expect(text).toContain("`u`.`email` IS NOT NULL");
    });

    it("should handle whereIn()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereIn("status", ["active", "pending"]);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`status` IN");
      expect(values).toEqual(["active", "pending"]);
    });

    it("should handle whereNotIn()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereNotIn("status", ["banned"]);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`status` NOT IN");
      expect(values).toEqual(["banned"]);
    });

    it("should handle whereBetween()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereBetween("age", 18, 65);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`age` BETWEEN");
      expect(values).toEqual([18, 65]);
    });

    it("should handle whereLike()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.whereLike("name", "%john%");
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`name` LIKE ?");
      expect(values).toEqual(["%john%"]);
    });

    it("should handle orWhere()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("status", "active").orWhere("status", "pending");
      const { text, values } = qb.getSql();

      expect(text).toContain("OR");
      expect(values).toEqual(["active", "pending"]);
    });

    it("should handle array value as IN via 2-arg where", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", [1, 2, 3] as any);
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`id` IN");
      expect(values).toEqual([1, 2, 3]);
    });

    it("should support all comparison operators via 3-arg", () => {
      const operators: WhereOperator[] = ["=", "!=", "<>", "<", ">", "<=", ">="];
      for (const op of operators) {
        const em = createMockEm("mysql");
        const qb = new SelectQueryBuilder(User, "u", em);
        qb.where("age", op, 25);
        const { text } = qb.getSql();
        expect(text).toContain("`u`.`age`");
      }
    });

    it("should throw for unsupported operator at runtime", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      // "REGEX" is now a compile-time error; cast to bypass for runtime test
      expect(() => qb.where("age", "REGEX" as any, ".*")).toThrow(
        "Unsupported operator",
      );
    });
  });

  describe("ORDER BY", () => {
    it("should generate ORDER BY with object spec", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.orderBy({ createdAt: "DESC", name: "ASC" });
      const { text } = qb.getSql();

      expect(text).toContain("ORDER BY");
      expect(text).toContain("`u`.`createdAt` DESC");
      expect(text).toContain("`u`.`name` ASC");
    });

    it("should support addOrderBy", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.addOrderBy("id", "ASC");
      const { text } = qb.getSql();

      expect(text).toContain("ORDER BY `u`.`id` ASC");
    });
  });

  describe("LIMIT / OFFSET", () => {
    it("should generate LIMIT clause", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.limit(10);
      const { text, values } = qb.getSql();

      expect(text).toContain("LIMIT");
      expect(values).toContain(10);
    });

    it("should generate OFFSET + LIMIT (MySQL syntax)", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.offset(20).limit(10);
      const { text, values } = qb.getSql();

      expect(text).toContain("LIMIT");
      expect(values).toContain(20);
      expect(values).toContain(10);
    });

    it("should generate OFFSET + LIMIT (PostgreSQL syntax)", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.offset(20).limit(10);
      const { text, values } = qb.getSql();

      expect(text).toContain("LIMIT");
      expect(text).toContain("OFFSET");
      expect(values).toContain(20);
      expect(values).toContain(10);
    });

    it("should support skip/take aliases", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.skip(5).take(15);
      const { text, values } = qb.getSql();

      expect(text).toContain("LIMIT");
      expect(values).toContain(5);
      expect(values).toContain(15);
    });
  });

  describe("GROUP BY / HAVING", () => {
    it("should generate GROUP BY clause", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.groupBy(["status"]);
      const { text } = qb.getSql();

      expect(text).toContain("GROUP BY `u`.`status`");
    });

    it("should generate GROUP BY + HAVING", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.groupBy(["status"]).having(Conditions.gt("COUNT(*)", 5));
      const { text, values } = qb.getSql();

      expect(text).toContain("GROUP BY");
      expect(text).toContain("HAVING");
      expect(text).toContain("COUNT(*)");
      expect(values).toContain(5);
    });
  });

  describe("JOIN", () => {
    it("should generate LEFT JOIN", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.leftJoin(
        "post",
        "p",
        Conditions.compareColumns("`u`.`id`", "=", "`p`.`authorId`"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN");
      expect(text).toContain("`post`");
      expect(text).toContain("`u`.`id` = `p`.`authorId`");
    });

    it("should generate INNER JOIN", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.innerJoin(
        "post",
        "p",
        Conditions.compareColumns("`u`.`id`", "=", "`p`.`authorId`"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("INNER JOIN");
    });

    it("should generate RIGHT JOIN", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.rightJoin(
        "post",
        "p",
        Conditions.compareColumns("`u`.`id`", "=", "`p`.`authorId`"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("RIGHT JOIN");
    });

    it("should support string condition for JOIN", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.leftJoin("post", "p", "`u`.`id` = `p`.`authorId`");
      const { text } = qb.getSql();

      expect(text).toContain("LEFT JOIN");
      expect(text).toContain("`u`.`id` = `p`.`authorId`");
    });
  });

  describe("LOCK", () => {
    it("should add FOR UPDATE", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forUpdate();
      const { text } = qb.getSql();

      expect(text).toContain("FOR UPDATE");
    });

    it("should add LOCK IN SHARE MODE for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShare();
      const { text } = qb.getSql();

      expect(text).toContain("LOCK IN SHARE MODE");
    });

    it("should add FOR SHARE for PostgreSQL", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShare();
      const { text } = qb.getSql();

      expect(text).toContain("FOR SHARE");
    });

    it("should add FOR UPDATE NOWAIT", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forUpdateNowait();
      const { text } = qb.getSql();

      expect(text).toContain("FOR UPDATE NOWAIT");
    });

    it("should add FOR UPDATE SKIP LOCKED", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forUpdateSkipLocked();
      const { text } = qb.getSql();

      expect(text).toContain("FOR UPDATE SKIP LOCKED");
    });

    it("should add FOR SHARE NOWAIT for PostgreSQL", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShareNowait();
      const { text } = qb.getSql();

      expect(text).toContain("FOR SHARE NOWAIT");
    });

    it("should add LOCK IN SHARE MODE NOWAIT for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShareNowait();
      const { text } = qb.getSql();

      expect(text).toContain("LOCK IN SHARE MODE NOWAIT");
    });

    it("should add FOR SHARE SKIP LOCKED for PostgreSQL", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShareSkipLocked();
      const { text } = qb.getSql();

      expect(text).toContain("FOR SHARE SKIP LOCKED");
    });

    it("should add LOCK IN SHARE MODE SKIP LOCKED for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", 1).forShareSkipLocked();
      const { text } = qb.getSql();

      expect(text).toContain("LOCK IN SHARE MODE SKIP LOCKED");
    });
  });

  describe("INDEX HINTS", () => {
    it("should add USE INDEX for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.useIndex("idx_user_email").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("USE INDEX (`idx_user_email`)");
    });

    it("should add FORCE INDEX for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.forceIndex("idx_user_status").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("FORCE INDEX (`idx_user_status`)");
    });

    it("should add IGNORE INDEX for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.ignoreIndex("idx_user_name").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("IGNORE INDEX (`idx_user_name`)");
    });

    it("should support multiple index hints for MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.useIndex("idx1").ignoreIndex("idx2").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("USE INDEX (`idx1`)");
      expect(text).toContain("IGNORE INDEX (`idx2`)");
    });

    it("should not add index hints for non-MySQL (PostgreSQL)", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.useIndex("idx_test").where("id", 1);
      const { text } = qb.getSql();

      // Index hints are MySQL-only; should not appear in PG SQL
      expect(text).not.toContain("USE INDEX");
    });

    it("should add pg_hint_plan comment for PostgreSQL", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.hint("IndexScan(u idx_user_date)").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("/*+ IndexScan(u idx_user_date) */");
      expect(text).toContain("SELECT");
    });

    it("should support multiple pg hints", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.hint("IndexScan(u idx1)").hint("NestLoop(u o)").where("id", 1);
      const { text } = qb.getSql();

      expect(text).toContain("/*+ IndexScan(u idx1) NestLoop(u o) */");
    });
  });

  describe("soft delete auto-filter", () => {
    it("should auto-add IS NULL on @DeletedAt column", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(SoftItem, "s", em);
      const { text } = qb.getSql();

      expect(text).toContain("`s`.`deletedAt` IS NULL");
    });

    it("should skip soft-delete filter with withDeleted()", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(SoftItem, "s", em);
      qb.withDeleted();
      const { text } = qb.getSql();

      expect(text).not.toContain("IS NULL");
    });
  });

  describe("complex queries", () => {
    it("should chain multiple clauses fluently", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);

      qb.select(["id", "name", "email"])
        .where("status", "active")
        .andWhere("age", ">=", 18)
        .orderBy({ createdAt: "DESC" })
        .limit(10)
        .offset(20);

      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`id`");
      expect(text).toContain("`u`.`name`");
      expect(text).toContain("`u`.`email`");
      expect(text).toContain("WHERE");
      expect(text).toContain("`u`.`status` = ?");
      expect(text).toContain("`u`.`age` >= ?");
      expect(text).toContain("ORDER BY");
      expect(text).toContain("`u`.`createdAt` DESC");
      expect(text).toContain("LIMIT");
      expect(values).toEqual(["active", 18, 20, 10]);
    });

    it("should generate full query with JOIN + WHERE + ORDER + LIMIT (PostgreSQL)", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);

      qb.select(["id", "name"])
        .leftJoin(
          "post",
          "p",
          Conditions.compareColumns('"u"."id"', "=", '"p"."authorId"'),
        )
        .where("status", "active")
        .andWhere("age", ">", 21)
        .orderBy({ name: "ASC" })
        .limit(50)
        .offset(0);

      const { text, values } = qb.getSql();

      expect(text).toContain("SELECT");
      expect(text).toContain('"u"."id"');
      expect(text).toContain('"u"."name"');
      expect(text).toContain('FROM "user" AS "u"');
      expect(text).toContain("LEFT JOIN");
      expect(text).toContain("WHERE");
      expect(text).toContain("ORDER BY");
      expect(text).toContain("LIMIT");
      expect(text).toContain("OFFSET");
      expect(values).toEqual(["active", 21, 50, 0]);
    });
  });

  describe("addSelect", () => {
    it("should add extra expressions to SELECT *", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.addSelect(Conditions.count("*"), "total");
      const { text } = qb.getSql();

      expect(text).toContain("`u`.*");
      expect(text).toContain("COUNT(*)");
    });
  });

  describe("appendSql", () => {
    it("should append raw SQL fragment", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const { raw } = require("sql-template-tag");
      qb.appendSql(raw("/* custom hint */"));
      const { text } = qb.getSql();

      expect(text).toContain("/* custom hint */");
    });
  });

  describe("asSubquery", () => {
    it("should wrap as subquery with alias", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.select(["id"]).where("status", "active");
      const sub = qb.asSubquery("active_users");

      expect(sub.sql).toContain("SELECT");
      expect(sub.sql).toContain("AS `active_users`");
    });
  });

  describe("execution methods (mocked)", () => {
    it("getMany should return empty array from mock", async () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const results = await qb.getMany();
      expect(results).toEqual([]);
    });

    it("getOne should return null from mock", async () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const result = await qb.getOne();
      expect(result).toBeNull();
    });

    it("getCount should return 0 from mock", async () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const count = await qb.getCount();
      expect(count).toBe(0);
    });

    it("getManyAndCount should return [[], 0] from mock", async () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const [results, count] = await qb.getManyAndCount();
      expect(results).toEqual([]);
      expect(count).toBe(0);
    });

    it("exists should return false from mock", async () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      const result = await qb.exists();
      expect(result).toBe(false);
    });
  });

  describe("BaseRepository.createQueryBuilder", () => {
    it("should create a SelectQueryBuilder from BaseRepository", () => {
      const em = createMockEm("mysql");
      const { BaseRepository } = require("../../src/core/BaseRepository");
      const repo = BaseRepository.of(User, em);
      const qb = repo.createQueryBuilder("u");

      expect(qb).toBeInstanceOf(SelectQueryBuilder);
      const { text } = qb.getSql();
      expect(text).toContain("SELECT `u`.*");
      expect(text).toContain("FROM `user` AS `u`");
    });
  });

  describe("BETWEEN via 3-arg where", () => {
    it("should handle BETWEEN operator", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("age", "BETWEEN", [18, 65]);
      const { text, values } = qb.getSql();

      expect(text).toContain("BETWEEN");
      expect(values).toEqual([18, 65]);
    });

    it("should throw for BETWEEN with non-array value", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      expect(() => qb.where("age", "BETWEEN", 18)).toThrow(
        "BETWEEN operator requires an array",
      );
    });
  });

  describe("LIKE / NOT LIKE via 3-arg where", () => {
    it("should handle LIKE operator", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("name", "LIKE", "%john%");
      const { text, values } = qb.getSql();

      expect(text).toContain("LIKE");
      expect(values).toEqual(["%john%"]);
    });

    it("should handle NOT LIKE operator", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("name", "NOT LIKE", "%test%");
      const { text, values } = qb.getSql();

      expect(text).toContain("NOT LIKE");
      expect(values).toEqual(["%test%"]);
    });
  });

  describe("IN / NOT IN via 3-arg where", () => {
    it("should handle IN operator with array", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", "IN", [1, 2, 3]);
      const { text, values } = qb.getSql();

      expect(text).toContain("IN");
      expect(values).toEqual([1, 2, 3]);
    });

    it("should handle NOT IN operator", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.where("id", "NOT IN", [4, 5]);
      const { text, values } = qb.getSql();

      expect(text).toContain("NOT IN");
      expect(values).toEqual([4, 5]);
    });
  });

  describe("3-tier execution methods", () => {
    // Entity with optional fields for required-column validation testing
    @Entity()
    class UserWithOptionals {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 255 })
      name!: string; // required (non-nullable, no default)

      @Column({ type: "varchar", nullable: true })
      bio!: string | null; // optional (nullable)

      @Column({ type: "varchar", default: "active" })
      status!: string; // optional (has default)
    }

    function createMockEmWithData(rows: any[], dbType: "mysql" | "postgresql" = "mysql") {
      const resolver = new RelationMetadataResolver();
      function wrap(col: string) {
        if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
        return `"${col.replace(/"/g, '""')}"`;
      }
      return {
        wrap,
        wrapTable: wrap,
        resolver,
        _ctx: {
          isMySqlFamily: () => dbType === "mysql",
          isPostgres: () => dbType === "postgresql",
        },
        async query<T>(): Promise<T[]> {
          return rows as T[];
        },
      } as unknown as EntityManager;
    }

    describe("getMany() — safe, class instances", () => {
      it("should return class instances when no select()", async () => {
        const em = createMockEmWithData([
          { id: 1, name: "Alice", email: "a@t.com", age: 30, status: "active", createdAt: new Date() },
        ]);
        const qb = new SelectQueryBuilder(User, "u", em);
        const results = await qb.getMany();

        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(User);
        expect(results[0].id).toBe(1);
        expect(results[0].name).toBe("Alice");
      });

      it("should return class instances when select('*')", async () => {
        const em = createMockEmWithData([
          { id: 2, name: "Bob", email: "b@t.com", age: 25, status: "active", createdAt: new Date() },
        ]);
        const qb = new SelectQueryBuilder(User, "u", em);
        qb.select("*");
        const results = await qb.getMany();

        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(User);
      });

      it("should return class instances when all required columns are selected", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice" }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // id is autoIncrement (optional), name is required, bio is nullable, status has default
        const results = await qb.select(["name"]).getMany();

        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(UserWithOptionals);
      });

      it("should throw MISSING_REQUIRED_COLUMNS when required column is omitted", async () => {
        const em = createMockEmWithData([{ id: 1, bio: null }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // Selecting only optional columns, omitting required "name"
        await expect(qb.select(["bio"]).getMany()).rejects.toThrow(
          /Missing.*name/,
        );
      });

      it("should not require nullable columns", async () => {
        const em = createMockEmWithData([{ name: "Alice" }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // bio is nullable — can be omitted
        const results = await qb.select(["name"]).getMany();
        expect(results).toHaveLength(1);
      });

      it("should not require columns with default values", async () => {
        const em = createMockEmWithData([{ name: "Alice" }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // status has default — can be omitted
        const results = await qb.select(["name"]).getMany();
        expect(results).toHaveLength(1);
      });

      it("should not require autoIncrement columns", async () => {
        const em = createMockEmWithData([{ name: "Alice" }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // id is autoIncrement — can be omitted
        const results = await qb.select(["name"]).getMany();
        expect(results).toHaveLength(1);
      });
    });

    describe("getOne() — safe, single class instance", () => {
      it("should return class instance when no select()", async () => {
        const em = createMockEmWithData([
          { id: 1, name: "Alice", email: "a@t.com", age: 30, status: "active", createdAt: new Date() },
        ]);
        const result = await new SelectQueryBuilder(User, "u", em).getOne();

        expect(result).not.toBeNull();
        expect(result).toBeInstanceOf(User);
      });

      it("should return null for empty result", async () => {
        const em = createMockEmWithData([]);
        const result = await new SelectQueryBuilder(User, "u", em).getOne();
        expect(result).toBeNull();
      });
    });

    describe("getManyAndCount() — safe", () => {
      it("should return class instances with count", async () => {
        const em = createMockEmWithData([
          { id: 1, name: "Alice", email: "a@t.com", age: 30, status: "active", createdAt: new Date() },
        ]);
        const qb = new SelectQueryBuilder(User, "u", em);
        jest.spyOn(qb, "getCount").mockResolvedValue(1);
        const [results, count] = await qb.getManyAndCount();

        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(User);
        expect(count).toBe(1);
      });
    });

    describe("getPartialMany() — typed plain objects", () => {
      it("should return plain objects (not class instances)", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice" }]);
        const qb = new SelectQueryBuilder(User, "u", em);
        const results = await qb.select(["id", "name"]).getPartialMany();

        expect(results).toHaveLength(1);
        expect(results[0]).not.toBeInstanceOf(User);
        expect(results[0].id).toBe(1);
        expect(results[0].name).toBe("Alice");
      });

      it("should not validate required columns", async () => {
        const em = createMockEmWithData([{ bio: null }]);
        const qb = new SelectQueryBuilder(UserWithOptionals, "u", em);
        // Omitting required "name" — getPartialMany should NOT throw
        const results = await qb.select(["bio"]).getPartialMany();
        expect(results).toHaveLength(1);
      });
    });

    describe("getPartialOne() — typed plain object", () => {
      it("should return plain object or null", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice" }]);
        const result = await new SelectQueryBuilder(User, "u", em)
          .select(["id", "name"])
          .getPartialOne();

        expect(result).not.toBeNull();
        expect(result).not.toBeInstanceOf(User);
      });
    });

    describe("getPartialManyAndCount()", () => {
      it("should return plain objects with count", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice" }]);
        const qb = new SelectQueryBuilder(User, "u", em).select(["id", "name"]);
        jest.spyOn(qb, "getCount").mockResolvedValue(5);
        const [results, count] = await qb.getPartialManyAndCount();

        expect(results[0]).not.toBeInstanceOf(User);
        expect(count).toBe(5);
      });
    });

    describe("getRawMany() — untyped plain objects", () => {
      it("should return Record<string, unknown>[]", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice", cnt: 42 }]);
        const qb = new SelectQueryBuilder(User, "u", em);
        const results = await qb.getRawMany();

        expect(results).toHaveLength(1);
        expect(results[0]).not.toBeInstanceOf(User);
        expect((results[0] as any).cnt).toBe(42);
      });
    });

    describe("getRawOne() — untyped plain object", () => {
      it("should return single record or null", async () => {
        const em = createMockEmWithData([{ id: 1, name: "Alice" }]);
        const result = await new SelectQueryBuilder(User, "u", em).getRawOne();

        expect(result).not.toBeNull();
        expect(result).not.toBeInstanceOf(User);
      });

      it("should return null for empty result", async () => {
        const em = createMockEmWithData([]);
        const result = await new SelectQueryBuilder(User, "u", em).getRawOne();
        expect(result).toBeNull();
      });
    });
  });

  describe("ILIKE dialect translation", () => {
    it("should generate ILIKE on PostgreSQL", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.setDialectExpression(createDialectExpression("postgres"));
      qb.where("name", "ILIKE", "%alice%");
      const { text, values } = qb.getSql();

      expect(text).toContain("ILIKE");
      expect(values).toContain("%alice%");
    });

    it("should translate ILIKE to LIKE on MySQL", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.setDialectExpression(createDialectExpression("mysql"));
      qb.where("name", "ILIKE", "%alice%");
      const { text, values } = qb.getSql();

      expect(text).toContain("LIKE");
      expect(text).not.toContain("ILIKE");
      expect(values).toContain("%alice%");
    });

    it("should translate ILIKE to LIKE on SQLite", () => {
      const em = createMockEm("postgresql"); // SQLite uses same quoting as PG
      const qb = new SelectQueryBuilder(User, "u", em);
      qb.setDialectExpression(createDialectExpression("sqlite"));
      qb.where("name", "ILIKE", "%alice%");
      const { text, values } = qb.getSql();

      expect(text).toContain("LIKE");
      expect(text).not.toContain("ILIKE");
      expect(values).toContain("%alice%");
    });

    it("should fall back to raw ILIKE when no dialectExpression is set", () => {
      const em = createMockEm("postgresql");
      const qb = new SelectQueryBuilder(User, "u", em);
      // No setDialectExpression() call
      qb.where("name", "ILIKE", "%alice%");
      const { text } = qb.getSql();

      expect(text).toContain("ILIKE");
    });
  });
});

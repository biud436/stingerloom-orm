import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

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
      const operators = ["=", "!=", "<>", "<", ">", "<=", ">="];
      for (const op of operators) {
        const em = createMockEm("mysql");
        const qb = new SelectQueryBuilder(User, "u", em);
        qb.where("age", op, 25);
        const { text } = qb.getSql();
        expect(text).toContain("`u`.`age`");
      }
    });

    it("should throw for unsupported operator", () => {
      const em = createMockEm("mysql");
      const qb = new SelectQueryBuilder(User, "u", em);
      expect(() => qb.where("age", "REGEX", ".*")).toThrow(
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
});

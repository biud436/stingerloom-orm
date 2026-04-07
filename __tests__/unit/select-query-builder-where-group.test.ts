import "reflect-metadata";
import {
  SelectQueryBuilder,
  WhereGroupBuilder,
} from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

// ── Test Entity ───────────────────────────────────────────

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "boolean" })
  verified!: boolean;

  @Column({ type: "varchar", length: 50 })
  role!: string;
}

// ── Mock EntityManager ────────────────────────────────────

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();

  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
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
      isSqlite: () => false,
      getDialect: () => (dbType === "mysql" ? "mysql" : "postgresql"),
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;

  return em;
}

function createQb<T>(
  entity: new () => T,
  alias: string,
  dbType: "mysql" | "postgresql" = "mysql",
) {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<T>(entity as any, alias, em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(entity as any);
  if (meta) {
    const map = new Map<string, string>();
    for (const col of meta.columns) {
      const prop = (col as any).propertyKey ?? col.name!;
      map.set(prop, col.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  return { qb, em };
}

// ── Tests ─────────────────────────────────────────────────

describe("SelectQueryBuilder — andWhereGroup / orWhereGroup", () => {
  describe("andWhereGroup", () => {
    it("should add a grouped AND condition", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.where("age", ">=", 18).where("role", "user"),
      );
      const { text, values } = qb.getSql();

      // The outer WHERE should contain the status condition AND the group
      expect(text).toContain("AND");
      expect(text).toContain("`u`.`age`");
      expect(text).toContain("`u`.`role`");
      expect(text).toContain("`u`.`status`");
      expect(values).toContain("active");
      expect(values).toContain(18);
      expect(values).toContain("user");
    });

    it("should add grouped condition as first WHERE", () => {
      const { qb } = createQb(User, "u");
      qb.andWhereGroup((g) => g.where("age", ">=", 18));
      const { text, values } = qb.getSql();

      expect(text).toContain("WHERE");
      expect(text).toContain("`u`.`age`");
      expect(text).toContain(">=");
      expect(values).toContain(18);
    });

    it("should handle single condition in group", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.where("verified", true),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`status`");
      expect(text).toContain("`u`.`verified`");
      expect(values).toContain("active");
      expect(values).toContain(true);
    });

    it("should throw on empty group", () => {
      const { qb } = createQb(User, "u");
      expect(() => {
        qb.andWhereGroup((_g) => {
          /* empty group */
        });
      }).toThrow(/empty/i);
    });
  });

  describe("orWhereGroup", () => {
    it("should add a grouped OR condition", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").orWhereGroup((g) =>
        g.where("role", "admin").where("verified", true),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("OR");
      expect(text).toContain("`u`.`role`");
      expect(text).toContain("`u`.`verified`");
      expect(values).toContain("active");
      expect(values).toContain("admin");
      expect(values).toContain(true);
    });

    it("should use OR to combine with existing conditions", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active")
        .where("age", ">=", 21)
        .orWhereGroup((g) =>
          g.where("role", "admin").where("verified", true),
        );
      const { text, values } = qb.getSql();

      // Existing conditions (status + age) should be OR-ed with the group
      expect(text).toContain("OR");
      expect(text).toContain("`u`.`status`");
      expect(text).toContain("`u`.`age`");
      expect(text).toContain("`u`.`role`");
      expect(text).toContain("`u`.`verified`");
      expect(values).toContain("active");
      expect(values).toContain(21);
      expect(values).toContain("admin");
      expect(values).toContain(true);
    });

    it("should handle first WHERE as orWhereGroup", () => {
      const { qb } = createQb(User, "u");
      qb.orWhereGroup((g) => g.where("role", "admin"));
      const { text, values } = qb.getSql();

      expect(text).toContain("WHERE");
      expect(text).toContain("`u`.`role`");
      expect(values).toContain("admin");
      // No OR should appear since there is no prior condition
      expect(text).not.toMatch(/\bOR\b/);
    });

    it("should throw on empty orWhereGroup", () => {
      const { qb } = createQb(User, "u");
      expect(() => {
        qb.orWhereGroup((_g) => {
          /* empty group */
        });
      }).toThrow(/empty/i);
    });
  });

  describe("WhereGroupBuilder methods", () => {
    it("should support whereIn inside group", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.whereIn("role", ["admin", "moderator"]),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("IN");
      expect(text).toContain("`u`.`role`");
      expect(values).toContain("admin");
      expect(values).toContain("moderator");
    });

    it("should support whereNull inside group", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.whereNull("email"),
      );
      const { text } = qb.getSql();

      expect(text).toContain("`u`.`email`");
      expect(text).toContain("IS NULL");
    });

    it("should support whereBetween inside group", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.whereBetween("age", 18, 65),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`age`");
      expect(text).toContain("BETWEEN");
      expect(values).toContain(18);
      expect(values).toContain(65);
    });

    it("should support whereLike inside group", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active").andWhereGroup((g) =>
        g.whereLike("name", "%John%"),
      );
      const { text, values } = qb.getSql();

      expect(text).toContain("`u`.`name`");
      expect(text).toContain("LIKE");
      expect(values).toContain("%John%");
    });
  });

  describe("chaining", () => {
    it("should chain andWhereGroup with orWhereGroup", () => {
      const { qb } = createQb(User, "u");
      qb.where("status", "active")
        .andWhereGroup((g) =>
          g.where("age", ">=", 18).where("role", "user"),
        )
        .orWhereGroup((g) =>
          g.where("role", "admin").where("verified", true),
        );
      const { text, values } = qb.getSql();

      // Should have both AND (from andWhereGroup) and OR (from orWhereGroup)
      expect(text).toContain("AND");
      expect(text).toContain("OR");
      // All columns present
      expect(text).toContain("`u`.`status`");
      expect(text).toContain("`u`.`age`");
      expect(text).toContain("`u`.`role`");
      expect(text).toContain("`u`.`verified`");
      // All values present
      expect(values).toContain("active");
      expect(values).toContain(18);
      expect(values).toContain("user");
      expect(values).toContain("admin");
      expect(values).toContain(true);
    });
  });
});

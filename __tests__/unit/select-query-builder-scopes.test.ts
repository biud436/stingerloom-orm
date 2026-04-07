import "reflect-metadata";
import { SelectQueryBuilder, WhereGroupBuilder } from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { OrmError } from "../../src/errors/OrmError";

// ── Test Entities ─────────────────────────────────────────

@Entity()
class ScopedUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  status!: string;

  @Column({ type: "int" })
  age!: number;

  static scopes = {
    active: (qb: SelectQueryBuilder<ScopedUser>) => qb.where("status", "active"),
    adult: (qb: SelectQueryBuilder<ScopedUser>) => qb.where("age", ">=", 18),
  };
}

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

describe("SelectQueryBuilder — applyScope()", () => {
  it("should apply a named scope", () => {
    const { qb } = createQb(ScopedUser, "u");
    qb.applyScope("active");

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(values).toContain("active");
  });

  it("should chain multiple scopes", () => {
    const { qb } = createQb(ScopedUser, "u");
    qb.applyScope("active").applyScope("adult");

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(values).toContain("active");
    expect(values).toContain(18);
  });

  it("should throw for unknown scope name", () => {
    const { qb } = createQb(ScopedUser, "u");

    expect(() => qb.applyScope("nonexistent")).toThrow(OrmError);
    expect(() => qb.applyScope("nonexistent")).toThrow(/Scope "nonexistent" not found/);
  });

  it("should throw for entity without scopes", () => {
    const { qb } = createQb(User, "u");

    expect(() => qb.applyScope("active")).toThrow(OrmError);
    expect(() => qb.applyScope("active")).toThrow(/Scope "active" not found/);
  });

  it("should chain scope with regular where", () => {
    const { qb } = createQb(ScopedUser, "u");
    qb.applyScope("active").where("name", "John");

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(text).toContain("name");
    expect(values).toContain("active");
    expect(values).toContain("John");
  });

  it("should return this for chaining", () => {
    const { qb } = createQb(ScopedUser, "u");
    const result = qb.applyScope("active");

    expect(result).toBe(qb);
  });
});

import "reflect-metadata";
import { SelectQueryBuilder, WhereGroupBuilder } from "../../src/core/SelectQueryBuilder";
import { Conditions } from "../../src/core/Conditions";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
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

describe("SelectQueryBuilder — when()", () => {
  it("should apply fn when condition is true", () => {
    const { qb } = createQb(User, "u");
    qb.when(true, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(values).toContain("active");
  });

  it("should NOT apply fn when condition is false", () => {
    const { qb } = createQb(User, "u");
    qb.when(false, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).not.toContain("WHERE");
    expect(values).not.toContain("active");
  });

  it("should call elseFn when condition is false and elseFn provided", () => {
    const { qb } = createQb(User, "u");
    qb.when(
      false,
      (q) => q.where("status", "active"),
      (q) => q.where("status", "inactive"),
    );

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(values).toContain("inactive");
    expect(values).not.toContain("active");
  });

  it("should support lazy condition (function returning true)", () => {
    const { qb } = createQb(User, "u");
    qb.when(() => true, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(values).toContain("active");
  });

  it("should support lazy condition (function returning false)", () => {
    const { qb } = createQb(User, "u");
    qb.when(() => false, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).not.toContain("WHERE");
    expect(values).not.toContain("active");
  });

  it("should chain multiple when() calls", () => {
    const { qb } = createQb(User, "u");
    qb.when(true, (q) => q.where("status", "active"))
      .when(true, (q) => q.where("role", "admin"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(text).toContain("role");
    expect(values).toContain("active");
    expect(values).toContain("admin");
  });

  it("should return this for chaining", () => {
    const { qb } = createQb(User, "u");
    const result = qb.when(true, (q) => q.where("status", "active"));

    expect(result).toBe(qb);
  });

  it("should work with 0 as falsy condition", () => {
    const { qb } = createQb(User, "u");
    qb.when(0 as any, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).not.toContain("WHERE");
    expect(values).not.toContain("active");
  });

  it("should work with non-zero number as truthy", () => {
    const { qb } = createQb(User, "u");
    qb.when(1 as any, (q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(values).toContain("active");
  });
});

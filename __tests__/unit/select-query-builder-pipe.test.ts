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

describe("SelectQueryBuilder — pipe()", () => {
  it("should apply the transform function", () => {
    const { qb } = createQb(User, "u");
    qb.pipe((q) => q.where("status", "active"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(values).toContain("active");
  });

  it("should return the result of the transform", () => {
    const { qb } = createQb(User, "u");
    const result = qb.pipe((q) => q.where("status", "active"));

    expect(result).toBe(qb);
  });

  it("should support composing multiple transforms", () => {
    const { qb } = createQb(User, "u");
    qb.pipe((q) => q.where("status", "active"))
      .pipe((q) => q.where("role", "admin"));

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(text).toContain("role");
    expect(values).toContain("active");
    expect(values).toContain("admin");
  });

  it("should pass the correct query builder instance", () => {
    const { qb } = createQb(User, "u");
    let receivedQb: any = null;

    qb.pipe((q) => {
      receivedQb = q;
      return q;
    });

    expect(receivedQb).toBe(qb);
  });

  it("should work with standalone functions", () => {
    function withActive<T>(q: SelectQueryBuilder<T>): SelectQueryBuilder<T> {
      return q.where("status" as any, "active");
    }

    function withAdmin<T>(q: SelectQueryBuilder<T>): SelectQueryBuilder<T> {
      return q.where("role" as any, "admin");
    }

    const { qb } = createQb(User, "u");
    qb.pipe(withActive as any).pipe(withAdmin as any);

    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(text).toContain("status");
    expect(text).toContain("role");
    expect(values).toContain("active");
    expect(values).toContain("admin");
  });
});

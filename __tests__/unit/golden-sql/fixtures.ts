import "reflect-metadata";
import {
  Entity,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  Column,
  ManyToOne,
  OneToMany,
  DeletedAt,
} from "../../../src/decorators";
import { SelectQueryBuilder } from "../../../src/core/SelectQueryBuilder";
import type { InsertQueryBuilder } from "../../../src/core/InsertQueryBuilder";
import { EntityManager } from "../../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../../src/dialects/DialectExpression";
import type { DialectName } from "./harness";

/**
 * Shared entity fixtures + query-builder factory for golden SQL tests.
 *
 * The query builder only needs a thin slice of `EntityManager` —
 * identifier wrapping, a `RelationMetadataResolver`, and the dialect
 * context flags — so the golden suite uses a hand-rolled mock rather than
 * a real connection. Keeps the tests pure-rendering and DB-free.
 */

@Entity()
export class Department {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @OneToMany(() => User, { mappedBy: "department" })
  users!: User[];
}

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  departmentId!: number;

  @ManyToOne(
    () => Department,
    (d: Department) => d.users,
  )
  department!: Department;

  // Non-nullable annotation keeps `design:type` as `Date`; the column is
  // still soft-delete-nullable at the DB level.
  @DeletedAt()
  deletedAt!: Date;
}

/** Map a golden `DialectName` to the mock context's dialect string. */
function ctxDialect(dialect: DialectName): "mysql" | "postgresql" | "sqlite" {
  return dialect === "postgres" ? "postgresql" : dialect;
}

/** Build the minimal `EntityManager` surface a `SelectQueryBuilder` consumes. */
function createMockEm(dialect: DialectName): EntityManager {
  const resolver = new RelationMetadataResolver();
  const quote = dialect === "mysql" ? "`" : '"';
  const wrap = (identifier: string): string =>
    `${quote}${identifier.split(quote).join(quote + quote)}${quote}`;
  return {
    wrap,
    wrapTable: (table: string) => wrap(table),
    resolver,
    _ctx: {
      isMySqlFamily: () => dialect === "mysql",
      isPostgres: () => dialect === "postgres",
      isSqlite: () => dialect === "sqlite",
      getDialect: () => ctxDialect(dialect),
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;
}

/**
 * Construct a dialect-bound `SelectQueryBuilder` for one of the fixture
 * entities, with the property->column map and `DialectExpression` wired up
 * the same way `EntityManager.createQueryBuilder()` does at runtime.
 */
export function createQbFor<T>(
  entity: new () => T,
  alias: string,
  dialect: DialectName,
): SelectQueryBuilder<T> {
  const em = createMockEm(dialect);
  const qb = new SelectQueryBuilder<T>(entity, alias, em);
  const resolver = (em as unknown as { resolver: RelationMetadataResolver })
    .resolver;
  const meta = resolver.resolveEntityMetadata(entity);
  if (meta) {
    const map = new Map<string, string>();
    for (const column of meta.columns) {
      const prop =
        (column as { propertyKey?: string }).propertyKey ?? column.name!;
      map.set(prop, column.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(createDialectExpression(dialect));
  return qb;
}

/**
 * Composite-PK counter used by the INSERT ... ON CONFLICT goldens.
 *
 * Every column is an `int` or `varchar` on purpose: the bulk-insert
 * defaults auto-fill `datetime` / `timestamp` / `date` columns with
 * `new Date()`, which would make the bound values non-deterministic and
 * the golden expectations unpinnable.
 */
@Entity()
export class Counter {
  @PrimaryColumn({ type: "varchar", length: 32 })
  mac!: string;

  @PrimaryColumn({ type: "int" })
  bucketStart!: number;

  @Column({ type: "int" })
  records!: number;

  @Column({ type: "int" })
  lastTs!: number;
}

/**
 * Construct a dialect-bound `InsertQueryBuilder` the way
 * `EntityManager.createInsertBuilder()` does at runtime.
 *
 * Unlike {@link createQbFor}, the write path reads enough of
 * `EntityManager` (write executor, relation resolver, DML builder) that a
 * hand-rolled mock is not viable — so this uses a real instance with the
 * driver and dialect predicates stubbed, matching the write-path unit
 * tests.
 */
export function createInsertBuilderFor<T>(
  entity: new () => T,
  dialect: DialectName,
): InsertQueryBuilder<T> {
  const em = new EntityManager();
  const quote = dialect === "mysql" ? "`" : '"';
  (em as unknown as { driver: unknown }).driver = {
    wrap: (identifier: string) =>
      `${quote}${identifier.split(quote).join(quote + quote)}${quote}`,
  };
  // Note this is the golden `DialectName` verbatim, not `ctxDialect()`:
  // `EntityManager._ctx.getDialect()` returns a `SchemaDialect`
  // ("postgres", never "postgresql"), and the insert path feeds it
  // straight to `createDialectExpression()`. The select-path mock above
  // can use either because `createQbFor` overrides the expression object
  // explicitly.
  (em as unknown as { _ctx: { getDialect: () => string } })._ctx.getDialect =
    () => dialect;
  // The dialect predicates and the tenant-scope assertion are private
  // prototype methods; own properties on the instance shadow them, which
  // is all the write path needs and keeps the factory free of spy state.
  Object.assign(em as unknown as Record<string, unknown>, {
    isMySqlFamily: () => dialect === "mysql",
    isPostgres: () => dialect === "postgres",
    isSqlite: () => dialect === "sqlite",
    assertEntityInScope: () => undefined,
  });
  return em.createInsertBuilder(entity);
}

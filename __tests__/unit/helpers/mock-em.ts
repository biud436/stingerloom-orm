/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager } from "../../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../../src/core/RelationMetadataResolver";
import { SelectQueryBuilder } from "../../../src/core/SelectQueryBuilder";
import { MySqlDriver } from "../../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../../src/dialects/sqlite/SqliteDriver";

/** The dialect a mock EntityManager speaks, named as `_ctx.getDialect()` names it. */
export type MockEmDialect = "mysql" | "postgres" | "sqlite";

/**
 * Accepted dialect spellings. `"postgresql"` is the `dbType` spelling the
 * builders use internally; it means the same as `"postgres"`.
 */
export type MockEmDialectInput = MockEmDialect | "postgresql";

/**
 * Members that replace or extend the mock's. `_ctx` is merged into the
 * mock's own `_ctx` instead of replacing it.
 */
export interface MockEmOverrides {
  _ctx?: Record<string, unknown>;
  [member: string]: unknown;
}

const drivers: Record<MockEmDialect, () => { wrap(name: string): string }> = {
  mysql: () => new MySqlDriver({} as any, "mysql"),
  postgres: () => new PostgresDriver({} as any, "postgres"),
  sqlite: () => new SqliteDriver({} as any),
};

export function normalizeMockDialect(dialect: MockEmDialectInput): MockEmDialect {
  return dialect === "postgresql" ? "postgres" : dialect;
}

/**
 * An EntityManager stand-in for unit tests of the query builders and
 * expressions: the members they read, with nothing connected.
 *
 * Identifiers are quoted by the dialect's real driver, so a test sees the
 * same quoting the ORM emits rather than a copy of the rule. `query()`
 * resolves with no rows unless overridden. `createQueryBuilder()` builds a
 * `SelectQueryBuilder` over this mock with the entity's property → column map.
 *
 * @param dialect - defaults to `"mysql"`
 * @param overrides - members to replace or add; `_ctx` entries are merged
 */
export function createMockEm<O extends MockEmOverrides = MockEmOverrides>(
  dialect: MockEmDialectInput = "mysql",
  overrides?: O,
): EntityManager & Omit<O, "_ctx"> {
  const name = normalizeMockDialect(dialect);
  const driver = drivers[name]();
  const resolver = new RelationMetadataResolver();
  const wrap = (identifier: string): string => driver.wrap(identifier);
  const { _ctx: ctxOverrides, ...members } = overrides ?? ({} as MockEmOverrides);

  const em: any = {
    wrap,
    wrapTable: (table: string) => wrap(table),
    resolver,
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
    createQueryBuilder(entity: any, alias: string) {
      const qb = new SelectQueryBuilder(entity, alias, em);
      const meta = resolver.resolveEntityMetadata(entity);
      if (meta) {
        const map = new Map<string, string>();
        for (const col of meta.columns) {
          map.set((col as any).propertyKey ?? col.name!, col.name!);
        }
        qb.setPropertyToColumnMap(map);
      }
      return qb;
    },
    ...members,
    _ctx: {
      isMySqlFamily: () => name === "mysql",
      isPostgres: () => name === "postgres",
      isSqlite: () => name === "sqlite",
      getDialect: () => name,
      ...ctxOverrides,
    },
  };
  return em;
}

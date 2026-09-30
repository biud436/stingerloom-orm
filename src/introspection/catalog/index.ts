import type { IntrospectionDialect } from "../TypeMapper";
import { CatalogQueryFn, CatalogReader, DialectTypes } from "./DialectCatalog";
import { MySqlCatalogReader, mysqlTypes } from "./mysql";
import { PostgresCatalogReader, postgresTypes } from "./postgres";
import { SqliteCatalogReader, sqliteTypes } from "./sqlite";

export * from "./DialectCatalog";

/** The pure type system of a dialect. */
export function dialectTypes(dialect: IntrospectionDialect): DialectTypes {
  switch (dialect) {
    case "postgres":
      return postgresTypes;
    case "mysql":
      return mysqlTypes;
    case "sqlite":
      return sqliteTypes;
  }
}

/** The catalog reader of a dialect, bound to a query function. */
export function createCatalogReader(
  dialect: IntrospectionDialect,
  query: CatalogQueryFn,
  options: { schema?: string } = {},
): CatalogReader {
  switch (dialect) {
    case "postgres":
      return new PostgresCatalogReader(query, options.schema ?? "public");
    case "mysql":
      return new MySqlCatalogReader(query);
    case "sqlite":
      return new SqliteCatalogReader(query);
  }
}

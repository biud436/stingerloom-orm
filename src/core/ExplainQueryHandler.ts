/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { FindOption } from "../dialects/FindOption";
import sql, { Sql, raw } from "sql-template-tag";
import { Conditions } from "./Conditions";
import { resolveWhereClause } from "./WhereResolver";
import { createDialectExpression } from "../dialects/DialectExpression";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { ExplainResult } from "./ExplainResult";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";

/**
 * Handler for EXPLAIN queries and dialect-specific result parsing.
 * Invoked by EntityManager via delegation.
 */
export class ExplainQueryHandler {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  async explain<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<ExplainResult> {
    const driver = this.ctx.getDriver();
    if (!driver || !driver.supportsExplain()) {
      throw new InvalidQueryError(
        "EXPLAIN is not supported by the current database driver.",
        "Use MySQL or PostgreSQL driver which support EXPLAIN queries.",
      );
    }

    const { select, orderBy, where, take, skip } = findOption;
    const { limit } = findOption;

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const qb = RawQueryBuilderFactory.create();
    const selectMap: string[] = [];
    const whereMap: Sql[] = [];
    const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> = [];

    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);
    const eagerRelations = manyToOneRelations.filter((rel) => {
      const isEager = rel.option?.eager === true;
      const isInRelations = findOption.relations?.includes(
        rel.columnName,
      );
      return isEager || isInRelations;
    });

    const oneToOneRelations = this.resolver.resolveOneToOneMetadata(entity);
    const eagerOneToOneRelations = oneToOneRelations.filter((rel) => {
      if (!rel.joinColumn) return false;
      const isEager = rel.option?.eager === true;
      const isInRelations = findOption.relations?.includes(
        rel.propertyKey,
      );
      return isEager || isInRelations;
    });

    const hasEagerJoins =
      eagerRelations.length > 0 || eagerOneToOneRelations.length > 0;
    const tableName = metadata.name!;

    if (select) {
      const selectedColumns = this.ctx.resolveSelectColumns<T>(select);
      if (hasEagerJoins) {
        selectMap.push(
          ...selectedColumns.map(
            (col) => `${this.ctx.wrap(tableName)}.${this.ctx.wrap(col)}`,
          ),
        );
      } else {
        selectMap.push(...selectedColumns.map((col) => this.ctx.wrap(col)));
      }
    } else {
      if (hasEagerJoins) {
        selectMap.push(
          ...metadata.columns.map(
            (column) => `${this.ctx.wrap(tableName)}.${this.ctx.wrap(column.name!)}`,
          ),
        );
      } else {
        selectMap.push(
          ...metadata.columns.map((column) => this.ctx.wrap(column.name!)),
        );
      }
    }

    // Map property names to DB columns (incl. FK shadow props) like
    // findInternal, so a NamingStrategy WHERE resolves correctly.
    const propToCol = this.ctx.buildPropertyToColumnMap(metadata);

    whereMap.push(
      ...resolveWhereClause(where, {
        wrapColumn: (n) => this.ctx.wrap(n),
        qualified: hasEagerJoins,
        tableName: hasEagerJoins ? tableName : undefined,
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: propToCol,
      }),
    );

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (deletedAtColumn && !(findOption as any).withDeleted) {
      if (hasEagerJoins) {
        whereMap.push(
          Conditions.isNull(
            `${this.ctx.wrap(tableName)}.${this.ctx.wrap(deletedAtColumn)}`,
          ),
        );
      } else {
        whereMap.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
      }
    }

    for (const key in orderBy) {
      const value = orderBy[key];
      if (value) {
        orderByMap.push({ column: this.ctx.wrap(key), direction: value });
      }
    }

    qb.select(selectMap).from(this.ctx.wrapTable(tableName));
    qb.where(whereMap).orderBy(orderByMap);

    // #145: Set database type for all dialects, not just MySQL
    if (this.ctx.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (this.ctx.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    if (Array.isArray(limit)) {
      let [offset, count] = limit;
      if (offset < 0) offset = 0;
      if (count < 0) count = 0;
      // An explicit count of 0 means LIMIT 0; only a positive `take` overrides it.
      if (take && take > 0) count = take;
      qb.limit([offset, count]);
    } else if (skip !== undefined || (take !== undefined && !limit)) {
      const offset = Math.max(skip ?? 0, 0);
      const count = Math.max(take ?? 0, 0) || undefined;
      if (count) {
        qb.limit([offset, count]);
      } else if (offset > 0) {
        qb.limit([offset, 2147483647]);
      }
    } else if (limit) {
      qb.limit(limit as number);
    }

    const selectQuery = qb.build();
    const explainPrefix = driver.buildExplainSql("");
    const explainQuery = sql`${raw(explainPrefix)}${selectQuery}`;

    // Replication: EXPLAIN is read-only, so route to a replica
    const readNode = this.ctx.getReadNode(findOption.useMaster);

    return this.ctx.executeReadOnly(async (session) => {
      const result = await session.query(explainQuery);
      const rawRows: Record<string, unknown>[] = (result as any)?.results ?? [];
      return this.parseExplainResult(rawRows);
    }, { readNodeOverride: readNode });
  }

  parseExplainResult(
    rawRows: Record<string, unknown>[],
  ): ExplainResult {
    if (!rawRows || rawRows.length === 0) {
      return {
        raw: [],
        rows: null,
        type: null,
        possibleKeys: null,
        key: null,
        cost: null,
      };
    }
    const firstRow = rawRows[0];
    if (firstRow && "QUERY PLAN" in firstRow) {
      return this.parsePostgresExplain(firstRow["QUERY PLAN"]);
    }
    if ("type" in firstRow || "select_type" in firstRow) {
      return this.parseMysqlExplain(rawRows);
    }
    if ("detail" in firstRow || "notused" in firstRow) {
      return this.parseSqliteExplain(rawRows);
    }
    return {
      raw: rawRows,
      rows: null,
      type: null,
      possibleKeys: null,
      key: null,
      cost: null,
    };
  }

  private parseMysqlExplain(rawRows: Record<string, unknown>[]): ExplainResult {
    const first = rawRows[0];
    const rows = first.rows != null ? Number(first.rows) : null;
    const type = first.type != null ? String(first.type) : null;
    const possibleKeysRaw = first.possible_keys;
    const possibleKeys =
      possibleKeysRaw != null
        ? String(possibleKeysRaw)
            .split(",")
            .map((k) => k.trim())
        : null;
    const key = first.key != null ? String(first.key) : null;
    const cost = first.filtered != null ? Number(first.filtered) : null;
    return { raw: rawRows, rows, type, possibleKeys, key, cost };
  }

  private parsePostgresExplain(queryPlan: unknown): ExplainResult {
    const rawArray = Array.isArray(queryPlan) ? queryPlan : [queryPlan];
    const plan = rawArray[0]?.Plan ?? rawArray[0]?.["Plan"] ?? null;
    if (!plan) {
      return {
        raw: rawArray,
        rows: null,
        type: null,
        possibleKeys: null,
        key: null,
        cost: null,
      };
    }
    const rows = plan["Plan Rows"] != null ? Number(plan["Plan Rows"]) : null;
    const type = plan["Node Type"] != null ? String(plan["Node Type"]) : null;
    const key = plan["Index Name"] != null ? String(plan["Index Name"]) : null;
    const cost = plan["Total Cost"] != null ? Number(plan["Total Cost"]) : null;
    return { raw: rawArray, rows, type, possibleKeys: null, key, cost };
  }

  private parseSqliteExplain(
    rawRows: Record<string, unknown>[],
  ): ExplainResult {
    const details = rawRows.map((r) => String(r.detail ?? ""));
    const firstDetail = details[0] ?? "";
    let type: string | null = null;
    let key: string | null = null;
    if (firstDetail.startsWith("SCAN")) type = "SCAN";
    else if (firstDetail.startsWith("SEARCH")) type = "SEARCH";
    const indexMatch = firstDetail.match(/USING (?:COVERING )?INDEX (\S+)/);
    if (indexMatch) key = indexMatch[1];
    return {
      raw: rawRows,
      rows: null,
      type,
      possibleKeys: null,
      key,
      cost: null,
    };
  }
}

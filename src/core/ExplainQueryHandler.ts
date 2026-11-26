/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { FindOption } from "../dialects/FindOption";
import sql, { raw } from "../utils/sqlTag";
import { ExplainResult } from "./ExplainResult";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { validateReadOptionShape } from "./QueryOptionShape";
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
    validateReadOptionShape(findOption, "explain", entity.name);
    const driver = this.ctx.getDriver();
    if (!driver || !driver.supportsExplain()) {
      throw new InvalidQueryError(
        "EXPLAIN is not supported by the current database driver.",
        "Use the MySQL, PostgreSQL or SQLite driver, which support EXPLAIN queries.",
      );
    }

    if (!this.resolver.resolveEntityMetadata(entity)) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // The statement is find()'s own, so the plan is the plan of the read:
    // inheritance sources and joins, eager and requested to-one joins, the
    // tenant, discriminator and soft-delete predicates. Nested levels, to-many
    // relations and the `withCount` counts are follow-up reads and stay out.
    const selectQuery = this.ctx.buildFindStatement(entity, findOption);
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

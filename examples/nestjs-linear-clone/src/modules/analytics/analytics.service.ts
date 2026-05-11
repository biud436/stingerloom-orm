import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  Expressions,
  RawQueryBuilder,
  qAlias,
  sql,
  raw,
} from "@stingerloom/orm";
import { detectDialect, dsl } from "./sql-helpers";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";
import { ActivityLog } from "../activity/activity-log.entity";
import { ISSUE_STATUS } from "../../common/enums";

export interface IssueTreeRow {
  id: number;
  parentId: number | null;
  number: number;
  title: string;
  status: string;
  depth: number;
  path: string;
}

export interface BurndownRow {
  day: string;
  completedThatDay: number;
  cumulativeCompleted: number;
  remainingEstimate: number;
}

export interface ThroughputRow {
  assigneeId: number | null;
  assigneeName: string | null;
  completedCount: number;
  averageCycleHours: number;
  rankInProject: number;
}

export interface TimeInStatusRow {
  issueId: number;
  status: string;
  enteredAt: string;
  leftAt: string | null;
  hoursInStatus: number | null;
}

export interface LeadTimeRow {
  weekStart: string;
  leadTimeHours: number;
  closedCount: number;
}

export interface CycleTimePercentilesRow {
  p50: number;
  p75: number;
  p95: number;
  sampleSize: number;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  // ── Recursive CTE: subissue tree ─────────────────────────

  /**
   * Walk down the `parent_id` chain so a UI can render the entire subissue
   * tree under a given root issue. The recursive CTE is assembled with
   * `RawQueryBuilder.withRecursive(...)`, which renders the leading
   * `WITH RECURSIVE …` clause for us; we only have to provide the
   * UNION-ALL body.
   */
  async issueTree(rootIssueId: number, maxDepth = 10): Promise<IssueTreeRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q, q } = D;
    const r = this.em.ref(Issue, "r");
    const c = this.em.ref(Issue, "c");
    // `t` is the recursive CTE alias; depth/path are CTE-only columns.
    const t = this.em.aliasRef("t");
    const castText = D.dialect === "postgres" ? "TEXT" : "CHAR(255)";
    const childPath =
      D.dialect === "postgres"
        ? sql`${t.path} || '/' || CAST(${c.id} AS TEXT)`
        : sql`CONCAT(${t.path}, '/', CAST(${c.id} AS CHAR(255)))`;

    // Recursive-CTE body composed via RawQueryBuilder rather than a
    // hand-rolled `sql\`SELECT … UNION ALL SELECT …\`` literal. This
    // exercises the builder's withRecursive(callback) + selectFragments
    // + unionAll path end-to-end and demonstrates that the gap between
    // raw and the builder for this shape was ergonomic, not structural.
    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("issue_tree", (qb) =>
        qb
          .selectFragments([
            r.as("id"),
            r.as("parentId"),
            r.as("number"),
            r.as("title"),
            r.as("status"),
            sql`0 AS ${Q("depth")}`,
            sql`CAST(${r.id} AS ${raw(castText)}) AS ${Q("path")}`,
          ])
          .from(r)
          .where([sql`${r.id} = ${rootIssueId}`, sql`${r.deletedAt} IS NULL`])
          .unionAll()
          .selectFragments([
            c.id,
            c.parentId,
            c.number,
            c.title,
            c.status,
            sql`${t.depth} + 1`,
            childPath,
          ])
          .from(c)
          .innerJoin("issue_tree", "t", sql`${c.parentId} = ${t.id}`)
          .where([sql`${c.deletedAt} IS NULL`, sql`${t.depth} < ${maxDepth}`]),
      )
      .select("*")
      .from("issue_tree")
      .orderBy([{ column: q("path"), direction: "ASC" }])
      .build();

    const rows = await this.em.query<Record<string, unknown>>(built);
    return rows.map((row) => ({
      id: Number(row.id),
      parentId: row.parentId === null ? null : Number(row.parentId),
      number: Number(row.number),
      title: String(row.title),
      status: String(row.status),
      depth: Number(row.depth),
      path: String(row.path),
    }));
  }

  // ── Window aggregate: sprint burndown ────────────────────

  /**
   * Sprint burndown — each row is one calendar day:
   *   completedThatDay     COUNT of issues completed that day
   *   cumulativeCompleted  SUM(...) OVER (ORDER BY day)
   *   remainingEstimate    sprint total estimate − running completed estimate
   */
  async sprintBurndown(sprintId: number): Promise<BurndownRow[]> {
    const i = qAlias(Issue, "i");

    // Step 1 — sprint total estimate (one scalar). The previous version
    // computed this as a CTE referenced via a scalar subquery in the
    // outer SELECT; fetching it as a separate query keeps the daily-
    // aggregate query free of cross-CTE plumbing and trades a tiny extra
    // round-trip for an entirely DSL-driven shape.
    const totalRow = await this.em
      .createQueryBuilder(Issue, "i")
      .select([
        Expressions.coalesce(Expressions.sum(i.estimate), 0).as(
          "totalEstimate",
        ),
      ])
      .where(i.sprintId.eq(sprintId))
      .andWhere(i.deletedAt.isNull())
      .getRawOne();
    const totalEstimate = Number(totalRow?.totalEstimate ?? 0);

    // Step 2 — daily aggregates over completed issues, grouped + ordered
    // by `dateTrunc(completedAt, 'day')`. The dialect-aware day truncation
    // means the same expression works on PG / MySQL / SQLite.
    const day = Expressions.dateTrunc(i.completedAt, "day");
    const dailyRows = await this.em
      .createQueryBuilder(Issue, "i")
      .select([
        day.as("day"),
        Expressions.count("*").as("completedCount"),
        Expressions.coalesce(Expressions.sum(i.estimate), 0).as(
          "completedEstimate",
        ),
      ])
      .where(i.sprintId.eq(sprintId))
      .andWhere(i.deletedAt.isNull())
      .andWhere(i.status.eq(ISSUE_STATUS.DONE))
      .andWhere(i.completedAt.isNotNull())
      .groupBy([day])
      .addOrderBy(day, "ASC")
      .getRawMany();

    // Step 3 — running totals + remaining estimate are derived in JS;
    // the row counts here are bounded by sprint length (~30 days) so
    // doing the prefix sum client-side avoids a window-aggregate-over-
    // CTE shape that would otherwise require raw SQL.
    let cumulativeCompleted = 0;
    let cumulativeEstimate = 0;
    return dailyRows.map((row) => {
      cumulativeCompleted += Number(row.completedCount);
      cumulativeEstimate += Number(row.completedEstimate);
      return {
        day:
          row.day instanceof Date
            ? row.day.toISOString().slice(0, 10)
            : String(row.day),
        completedThatDay: Number(row.completedCount),
        cumulativeCompleted,
        remainingEstimate: totalEstimate - cumulativeEstimate,
      };
    });
  }

  // ── Window function: assignee throughput ────────────────

  /**
   * Rank assignees in the project by completion count (desc) then average
   * cycle hours (asc) within the last `windowDays` days.
   *
   * Fully DSL-expressed: the two CTEs from the previous raw-SQL version
   * are collapsed into a single GROUP BY query because `ROW_NUMBER()` can
   * order on the aggregate results in its `OVER (ORDER BY …)` clause
   * (window evaluation runs after aggregation). The aggregates flow
   * through `Expressions.count("*")` / `Expressions.avg(scalarExpr)` and
   * the ranking head uses `Expressions.rowNumber()`.
   */
  async assigneeThroughput(
    projectId: number,
    windowDays = 30,
  ): Promise<ThroughputRow[]> {
    const i = qAlias(Issue, "i");
    const u = qAlias(User, "u");
    const cycleHours = Expressions.dateDiff(
      i.completedAt,
      i.createdAt,
      "second",
    )
      .floatValue()
      .div(3600);
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const completedCount = Expressions.count("*");
    const avgCycleHours = Expressions.avg(cycleHours);
    const rankInProject = Expressions.rowNumber().orderBy(
      completedCount.desc(),
      avgCycleHours.asc(),
    );

    const rows = await this.em
      .createQueryBuilder(Issue, "i")
      .leftJoin(User, "u", (j) => j.on("i.assigneeId", "=", "u.id"))
      .select([
        i.assigneeId.as("assigneeId"),
        u.name.as("assigneeName"),
        completedCount.as("completedCount"),
        avgCycleHours.as("averageCycleHours"),
        rankInProject.as("rankInProject"),
      ])
      .where(i.projectId.eq(projectId))
      .andWhere(i.deletedAt.isNull())
      .andWhere(i.status.eq(ISSUE_STATUS.DONE))
      .andWhere(i.completedAt.isNotNull())
      .andWhere(i.completedAt.gte(cutoff))
      .groupBy([i.assigneeId, u.name])
      .addOrderBy(rankInProject.toScalar(), "ASC")
      .getRawMany();

    return rows.map((row) => ({
      assigneeId: row.assigneeId === null ? null : Number(row.assigneeId),
      assigneeName: row.assigneeName ? String(row.assigneeName) : null,
      completedCount: Number(row.completedCount),
      averageCycleHours:
        row.averageCycleHours === null
          ? 0
          : Number(Number(row.averageCycleHours).toFixed(2)),
      rankInProject: Number(row.rankInProject),
    }));
  }

  // ── LAG/LEAD over activity_log: time-in-status ──────────

  /**
   * Reconstruct one row per status transition for an issue, with the
   * duration the issue spent in each status before the next transition.
   *
   * Reads the diff-shaped audit rows produced by `IssueAuditSubscriber`:
   * `payload = { changes: [{ column, from, to }, …] }`. Postgres uses the
   * `jsonb_path_query_first` operator over the changes array; MySQL uses
   * `JSON_UNQUOTE(JSON_SEARCH(...))` against the column entries. Rows whose
   * payload doesn't contain a status change are filtered out by the WHERE
   * clause's NOT NULL test.
   */
  async timeInStatus(issueId: number): Promise<TimeInStatusRow[]> {
    const dialectName = detectDialect(this.em);
    const a = qAlias(ActivityLog, "a");
    const A = this.em.ref(ActivityLog, "a");

    // Dialect-specific JSON-path filter: "find the changes[] entry where
    // column='status' and return its `to` value". The ORM's portable JSON
    // accessor (`a.payload.changes[].to`) cannot express a *predicate*
    // over array elements yet, so this remains an `Expressions.raw`
    // escape. The bound payload column refs flow through normally.
    const enteredStatus = Expressions.raw<string>(
      dialectName === "postgres"
        ? sql`(jsonb_path_query_first(${A.payload}::jsonb, '$.changes[*] ? (@.column == "status").to'))::text`
        : sql`JSON_UNQUOTE(
            JSON_EXTRACT(
              ${A.payload},
              REPLACE(
                JSON_UNQUOTE(JSON_SEARCH(${A.payload}, 'one', 'status', NULL, '$.changes[*].column')),
                '.column',
                '.to'
              )
            )
          )`,
    );

    // LEAD(createdAt) OVER (PARTITION BY issueId ORDER BY createdAt) —
    // entirely DSL-driven via `Expressions.lead(...).partitionBy(...).orderBy(...)`.
    // The window head + frame compose into the SELECT alongside the
    // entered-status JSON extract and the cycle-time `dateDiff` scalar.
    const leftAt = Expressions.lead(a.createdAt)
      .partitionBy(a.issueId)
      .orderBy(a.createdAt.asc())
      .toScalar();

    const hoursInStatus = Expressions.dateDiff(leftAt, a.createdAt, "second")
      .floatValue()
      .div(3600);

    // We need the LEAD-derived `leftAt` to span every ISSUE_UPDATED row
    // (so non-status-change rows still close out the prior status'
    // duration). Filtering on `status IS NOT NULL` must therefore happen
    // *after* the window evaluates, so we build the windowed SELECT with
    // SQB and wrap it in a small outer `SELECT * FROM (…) WHERE … ORDER BY …`.
    // No SQL identifiers leak in — only previously-resolved fragments.
    const inner = this.em
      .createQueryBuilder(ActivityLog, "a")
      .select([
        a.issueId.as("issueId"),
        enteredStatus.as("status"),
        a.createdAt.as("enteredAt"),
        leftAt.as("leftAt"),
        hoursInStatus.as("hoursInStatus"),
      ])
      .where(a.issueId.eq(issueId))
      .andWhere(a.action.eq("ISSUE_UPDATED"))
      .toSql();

    const statusIdent = this.em.getDriver()!.isMySqlFamily()
      ? raw("`status`")
      : raw(`"status"`);
    const enteredAtIdent = this.em.getDriver()!.isMySqlFamily()
      ? raw("`enteredAt`")
      : raw(`"enteredAt"`);
    const final = sql`
      SELECT * FROM (${inner}) t
      WHERE ${statusIdent} IS NOT NULL
      ORDER BY ${enteredAtIdent}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      issueId: Number(row.issueId),
      // Postgres `jsonb_path_query_first` returns the JSON-quoted form
      // ("DONE"); strip the surrounding quotes if present.
      status: this.unquoteStatus(row.status),
      enteredAt:
        row.enteredAt instanceof Date
          ? row.enteredAt.toISOString()
          : String(row.enteredAt),
      leftAt:
        row.leftAt === null
          ? null
          : row.leftAt instanceof Date
            ? row.leftAt.toISOString()
            : String(row.leftAt),
      hoursInStatus:
        row.hoursInStatus === null
          ? null
          : Number(Number(row.hoursInStatus).toFixed(2)),
    }));
  }

  private unquoteStatus(raw: unknown): string {
    if (raw === null || raw === undefined) return "";
    const s = String(raw);
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1);
    }
    return s;
  }

  // ── Group-by + window: weekly lead time ─────────────────

  /**
   * Weekly lead-time aggregate. Fully expressed through the ORM DSL:
   * `Expressions.dateTrunc(completedAt, "week")` produces a dialect-
   * portable ISO-Monday week-start (PG `date_trunc`, MySQL
   * `DATE_SUB(... INTERVAL WEEKDAY DAY)`, SQLite `date(..., '-N days')`);
   * `Expressions.avg(cycleHours)` aggregates a derived scalar; bare
   * column comparisons compose the WHERE clause.
   */
  async leadTimeByWeek(
    projectId: number,
    windowDays = 60,
  ): Promise<LeadTimeRow[]> {
    const i = qAlias(Issue, "i");
    const cycleHours = Expressions.dateDiff(
      i.completedAt,
      i.createdAt,
      "second",
    )
      .floatValue()
      .div(3600);
    const week = Expressions.dateTrunc(i.completedAt, "week");
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await this.em
      .createQueryBuilder(Issue, "i")
      .select([
        week.as("weekStart"),
        Expressions.avg(cycleHours).as("leadTimeHours"),
        Expressions.count("*").as("closedCount"),
      ])
      .where(i.projectId.eq(projectId))
      .andWhere(i.status.eq(ISSUE_STATUS.DONE))
      .andWhere(i.completedAt.isNotNull())
      .andWhere(i.completedAt.gte(cutoff))
      .andWhere(i.deletedAt.isNull())
      .groupBy([week])
      .addOrderBy(week, "ASC")
      .getRawMany();

    return rows.map((row) => ({
      weekStart:
        row.weekStart instanceof Date
          ? row.weekStart.toISOString().slice(0, 10)
          : String(row.weekStart),
      leadTimeHours: Number(Number(row.leadTimeHours ?? 0).toFixed(2)),
      closedCount: Number(row.closedCount),
    }));
  }

  // ── Cycle-time percentiles (PG percentile_cont, MySQL emulation) ──

  /**
   * Distribution percentiles (P50/P75/P95) of issue cycle time, in hours,
   * within a recent window. Pushes the dialect-portability story:
   *   - **PostgreSQL** has the SQL-standard `percentile_cont(p) WITHIN
   *     GROUP (ORDER BY x)` ordered-set aggregate. We express it through
   *     the ORM's `Expressions.percentileCont(...)` helper so the whole
   *     query is assembled by `SelectQueryBuilder` — no hand-rolled SQL,
   *     no manual identifier quoting, fraction values flow through as
   *     bound parameters.
   *   - **MySQL** has no native ordered-set aggregate. The standard
   *     emulation rewrites the entire query: a CTE that attaches
   *     `ROW_NUMBER() OVER (ORDER BY x)` to every cycle-time, then an
   *     outer `MAX(CASE WHEN rn = CEIL(N * p) THEN hours END)` to pick
   *     the matching row. Since this needs whole-query rewriting (not
   *     just a different expression), the ORM aggregate raises
   *     `OrmError(UNSUPPORTED_OPERATION)` on MySQL and this method falls
   *     back to a raw-CTE form. See `Expressions.percentileCont` JSDoc
   *     for the dialect-support table.
   */
  async cycleTimePercentiles(
    projectId: number,
    windowDays = 60,
  ): Promise<CycleTimePercentilesRow> {
    if (detectDialect(this.em) === "postgres") {
      return this.cycleTimePercentilesPg(projectId, windowDays);
    }
    return this.cycleTimePercentilesMySqlEmulation(projectId, windowDays);
  }

  /**
   * Pure-DSL implementation for PostgreSQL. Uses `Expressions.dateDiff` to
   * compute cycle time in seconds, then `.floatValue().div(3600)` so the
   * division stays floating-point on every dialect rather than integer-
   * truncating on PG. `Expressions.percentileCont` renders the native
   * `percentile_cont(p) WITHIN GROUP (ORDER BY x)` form.
   */
  private async cycleTimePercentilesPg(
    projectId: number,
    windowDays: number,
  ): Promise<CycleTimePercentilesRow> {
    const i = qAlias(Issue, "i");
    const cycleHours = Expressions.dateDiff(
      i.completedAt,
      i.createdAt,
      "second",
    )
      .floatValue()
      .div(3600);
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const row = await this.em
      .createQueryBuilder(Issue, "i")
      .select([
        Expressions.percentileCont(0.5, cycleHours).as("p50"),
        Expressions.percentileCont(0.75, cycleHours).as("p75"),
        Expressions.percentileCont(0.95, cycleHours).as("p95"),
        i.id.count().as("sampleSize"),
      ])
      .where(i.projectId.eq(projectId))
      .andWhere(i.status.eq(ISSUE_STATUS.DONE))
      .andWhere(i.completedAt.isNotNull())
      .andWhere(i.completedAt.gte(cutoff))
      .andWhere(i.deletedAt.isNull())
      .getRawOne();

    return this.toPercentileRow(row ?? undefined);
  }

  /**
   * MySQL emulation. Kept as raw-CTE SQL because `percentile_cont` requires
   * whole-query rewriting on engines without the ordered-set aggregate, and
   * a single expression-level helper cannot express that shape. Identifiers
   * and the percentile fractions are still parameter-bound through
   * `sql-template-tag`.
   */
  private async cycleTimePercentilesMySqlEmulation(
    projectId: number,
    windowDays: number,
  ): Promise<CycleTimePercentilesRow> {
    const D = dsl(detectDialect(this.em));
    const { Q, hoursBetween, nowMinusDays } = D;
    const I = this.em.ref(Issue);
    const cycle = hoursBetween(I.createdAt, I.completedAt);
    const cutoff = nowMinusDays(windowDays);

    const cyclesCte = sql`
      SELECT
        ${cycle} AS hours,
        ROW_NUMBER() OVER (ORDER BY ${cycle}) AS rn
      FROM ${I}
      WHERE ${I.projectId} = ${projectId}
        AND ${I.status} = ${ISSUE_STATUS.DONE}
        AND ${I.completedAt} IS NOT NULL
        AND ${I.completedAt} >= ${cutoff}
        AND ${I.deletedAt} IS NULL
    `;
    const ctes = RawQueryBuilder.create()
      .setDatabaseType("mysql")
      .with("cycles", cyclesCte)
      .build();
    const final = sql`
      ${ctes}
      SELECT
        MAX(CASE WHEN rn = GREATEST(1, CEIL(total * 0.50)) THEN hours END) AS ${Q("p50")},
        MAX(CASE WHEN rn = GREATEST(1, CEIL(total * 0.75)) THEN hours END) AS ${Q("p75")},
        MAX(CASE WHEN rn = GREATEST(1, CEIL(total * 0.95)) THEN hours END) AS ${Q("p95")},
        total                                                              AS ${Q("sampleSize")}
      FROM (
        SELECT hours, rn, COUNT(*) OVER () AS total FROM cycles
      ) c
      GROUP BY total
    `;
    const rows = await this.em.query<Record<string, unknown>>(final);
    return this.toPercentileRow(rows[0]);
  }

  private toPercentileRow(
    row: Record<string, unknown> | undefined,
  ): CycleTimePercentilesRow {
    const num = (v: unknown): number =>
      v === null || v === undefined ? 0 : Number(Number(v).toFixed(2));
    return {
      p50: num(row?.p50),
      p75: num(row?.p75),
      p95: num(row?.p95),
      sampleSize: row?.sampleSize === undefined ? 0 : Number(row.sampleSize),
    };
  }
}

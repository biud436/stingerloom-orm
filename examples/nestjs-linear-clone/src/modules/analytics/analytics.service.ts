import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  RawQueryBuilder,
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
    const D = dsl(detectDialect(this.em));
    const { Q, dayOf } = D;
    const I = this.em.ref(Issue);
    const Ia = this.em.ref(Issue, "i");
    const truncDay = dayOf(Ia.completedAt);

    const sprintTotalCte = sql`
      SELECT COALESCE(SUM(${I.estimate}), 0) AS total_estimate
      FROM ${I}
      WHERE ${I.sprintId} = ${sprintId}
        AND ${I.deletedAt} IS NULL
    `;

    const dailyCte = sql`
      SELECT
        ${truncDay}                          AS day,
        COUNT(*)                             AS completed_count,
        COALESCE(SUM(${Ia.estimate}), 0)     AS completed_estimate
      FROM ${Ia}
      WHERE ${Ia.sprintId} = ${sprintId}
        AND ${Ia.deletedAt} IS NULL
        AND ${Ia.status} = ${ISSUE_STATUS.DONE}
        AND ${Ia.completedAt} IS NOT NULL
      GROUP BY ${truncDay}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .with("sprint_total", sprintTotalCte)
      .with("daily", dailyCte)
      .build();

    const final = sql`
      ${built}
      SELECT
        day                                                                              AS day,
        completed_count                                                                  AS ${Q("completedThatDay")},
        SUM(completed_count) OVER (ORDER BY day)                                         AS ${Q("cumulativeCompleted")},
        (SELECT total_estimate FROM sprint_total)
          - SUM(completed_estimate) OVER (ORDER BY day)                                  AS ${Q("remainingEstimate")}
      FROM daily
      ORDER BY day
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      day:
        row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day),
      completedThatDay: Number(row.completedThatDay),
      cumulativeCompleted: Number(row.cumulativeCompleted),
      remainingEstimate: Number(row.remainingEstimate ?? 0),
    }));
  }

  // ── Window function: assignee throughput ────────────────

  /**
   * Rank assignees in the project by completion count (desc) then average
   * cycle hours (asc) within the last `windowDays` days.
   */
  async assigneeThroughput(
    projectId: number,
    windowDays = 30,
  ): Promise<ThroughputRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q, hoursBetween, nowMinusDays } = D;
    const I = this.em.ref(Issue, "i");
    const U = this.em.ref(User, "u");
    const cycle = hoursBetween(I.createdAt, I.completedAt);
    const cutoff = nowMinusDays(windowDays);

    const closedCte = sql`
      SELECT
        ${I.assigneeId} AS assignee_id,
        ${cycle}        AS cycle_hours
      FROM ${I}
      WHERE ${I.projectId} = ${projectId}
        AND ${I.deletedAt} IS NULL
        AND ${I.status} = ${ISSUE_STATUS.DONE}
        AND ${I.completedAt} IS NOT NULL
        AND ${I.completedAt} >= ${cutoff}
    `;

    const c = this.em.aliasRef("c");
    const s = this.em.aliasRef("s");
    const statsCte = sql`
      SELECT
        ${c.assigneeId},
        COUNT(*)                AS completed_count,
        AVG(${c.cycleHours})    AS avg_cycle_hours
      FROM closed ${c}
      GROUP BY ${c.assigneeId}
    `;

    const ctes = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .with("closed", closedCte)
      .with("stats", statsCte)
      .build();

    const final = sql`
      ${ctes}
      SELECT
        ${s.assigneeId}                                                          AS ${Q("assigneeId")},
        ${U.name}                                                                AS ${Q("assigneeName")},
        ${s.completedCount}                                                      AS ${Q("completedCount")},
        ${s.avgCycleHours}                                                       AS ${Q("averageCycleHours")},
        ROW_NUMBER() OVER (ORDER BY ${s.completedCount} DESC, ${s.avgCycleHours} ASC)
                                                                                 AS ${Q("rankInProject")}
      FROM stats ${s}
      LEFT JOIN ${U} ON ${U.id} = ${s.assigneeId}
      ORDER BY ${Q("rankInProject")}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
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
    const D = dsl(detectDialect(this.em));
    const { Q } = D;
    const A = this.em.ref(ActivityLog);

    // Extract the `to` value of the change record where column='status'.
    const enteredStatus =
      D.dialect === "postgres"
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
          )`;

    const hoursDiff =
      D.dialect === "postgres"
        ? sql`EXTRACT(EPOCH FROM (LEAD(${A.createdAt}) OVER w - ${A.createdAt})) / 3600.0`
        : sql`TIMESTAMPDIFF(SECOND, ${A.createdAt}, LEAD(${A.createdAt}) OVER w) / 3600.0`;

    const final = sql`
      SELECT * FROM (
        SELECT
          ${A.issueId}                                  AS ${Q("issueId")},
          ${enteredStatus}                              AS ${Q("status")},
          ${A.createdAt}                                AS ${Q("enteredAt")},
          LEAD(${A.createdAt}) OVER w                   AS ${Q("leftAt")},
          ${hoursDiff}                                  AS ${Q("hoursInStatus")}
        FROM ${A}
        WHERE ${A.issueId} = ${issueId}
          AND ${A.action} = ${"ISSUE_UPDATED"}
        WINDOW w AS (PARTITION BY ${A.issueId} ORDER BY ${A.createdAt})
      ) t
      WHERE ${Q("status")} IS NOT NULL
      ORDER BY ${Q("enteredAt")}
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

  async leadTimeByWeek(
    projectId: number,
    windowDays = 60,
  ): Promise<LeadTimeRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q, weekOf, hoursBetween, nowMinusDays } = D;
    const I = this.em.ref(Issue);
    const week = weekOf(I.completedAt);
    const cutoff = nowMinusDays(windowDays);
    const cycle = hoursBetween(I.createdAt, I.completedAt);

    const final = sql`
      SELECT
        ${week}                       AS ${Q("weekStart")},
        AVG(${cycle})                 AS ${Q("leadTimeHours")},
        COUNT(*)                      AS ${Q("closedCount")}
      FROM ${I}
      WHERE ${I.projectId} = ${projectId}
        AND ${I.status} = ${ISSUE_STATUS.DONE}
        AND ${I.completedAt} IS NOT NULL
        AND ${I.completedAt} >= ${cutoff}
        AND ${I.deletedAt} IS NULL
      GROUP BY ${week}
      ORDER BY ${week}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
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
   *   - PostgreSQL has the SQL-standard `percentile_cont(p) WITHIN GROUP
   *     (ORDER BY x)` ordered-set aggregate.
   *   - MySQL has no native percentile_cont, so we emulate it with a
   *     window function over the sorted cycle-time series and pick the
   *     row whose row-number matches `CEIL(N * p)`.
   */
  async cycleTimePercentiles(
    projectId: number,
    windowDays = 60,
  ): Promise<CycleTimePercentilesRow> {
    const D = dsl(detectDialect(this.em));
    const { Q, hoursBetween, nowMinusDays } = D;
    const I = this.em.ref(Issue);
    const cycle = hoursBetween(I.createdAt, I.completedAt);
    const cutoff = nowMinusDays(windowDays);

    if (D.dialect === "postgres") {
      const final = sql`
        SELECT
          percentile_cont(0.50) WITHIN GROUP (ORDER BY ${cycle}) AS ${Q("p50")},
          percentile_cont(0.75) WITHIN GROUP (ORDER BY ${cycle}) AS ${Q("p75")},
          percentile_cont(0.95) WITHIN GROUP (ORDER BY ${cycle}) AS ${Q("p95")},
          COUNT(*)                                               AS ${Q("sampleSize")}
        FROM ${I}
        WHERE ${I.projectId} = ${projectId}
          AND ${I.status} = ${ISSUE_STATUS.DONE}
          AND ${I.completedAt} IS NOT NULL
          AND ${I.completedAt} >= ${cutoff}
          AND ${I.deletedAt} IS NULL
      `;
      const rows = await this.em.query<Record<string, unknown>>(final);
      return this.toPercentileRow(rows[0]);
    }

    // MySQL emulation: rank the closed cycle-times then pick the row whose
    // ordinal matches CEIL(N * p). NTILE() doesn't quite fit because we'd
    // still need a positional pick within each tile; ROW_NUMBER + a CASE
    // is more direct and reads cleaner.
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

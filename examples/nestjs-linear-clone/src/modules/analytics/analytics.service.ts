import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  RawQueryBuilder,
  sql,
  raw,
} from "@stingerloom/orm";
import { detectDialect, dsl } from "./sql-helpers";
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
    const { Q, q, tbl } = D;
    const r = tbl("r");
    const c = tbl("c");
    const t = tbl("t");
    const castText = D.dialect === "postgres" ? "TEXT" : "CHAR(255)";
    const childPath =
      D.dialect === "postgres"
        ? sql`${t.path} || '/' || CAST(${c.id} AS TEXT)`
        : sql`CONCAT(${t.path}, '/', CAST(${c.id} AS CHAR(255)))`;

    const treeBody = sql`
      SELECT
        ${r.as("id")},
        ${r.as("parent_id", "parentId")},
        ${r.as("number")},
        ${r.as("title")},
        ${r.as("status")},
        0 AS ${Q("depth")},
        CAST(${r.id} AS ${raw(castText)}) AS ${Q("path")}
      FROM ${Q("issue")} r
      WHERE ${r.id} = ${rootIssueId}
        AND ${r.deletedAt} IS NULL
      UNION ALL
      SELECT
        ${c.id},
        ${c.parent_id},
        ${c.number},
        ${c.title},
        ${c.status},
        ${t.depth} + 1,
        ${childPath}
      FROM ${Q("issue")} c
      INNER JOIN issue_tree t ON ${c.parent_id} = ${t.id}
      WHERE ${c.deletedAt} IS NULL
        AND ${t.depth} < ${maxDepth}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("issue_tree", treeBody)
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
    const { Q, tbl, dayOf } = D;
    const i = tbl("i");
    const truncDay = dayOf(i.completedAt);

    const sprintTotalCte = sql`
      SELECT COALESCE(SUM(${Q("estimate")}), 0) AS total_estimate
      FROM ${Q("issue")}
      WHERE ${Q("sprint_id")} = ${sprintId}
        AND ${Q("deletedAt")} IS NULL
    `;

    const dailyCte = sql`
      SELECT
        ${truncDay}                          AS day,
        COUNT(*)                             AS completed_count,
        COALESCE(SUM(${i.estimate}), 0)      AS completed_estimate
      FROM ${Q("issue")} i
      WHERE ${i.sprint_id} = ${sprintId}
        AND ${i.deletedAt} IS NULL
        AND ${i.status} = ${ISSUE_STATUS.DONE}
        AND ${i.completedAt} IS NOT NULL
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
    const { Q, tbl, hoursBetween, nowMinusDays } = D;
    const i = tbl("i");
    const u = tbl("u");
    const cycle = hoursBetween(i.createdAt, i.completedAt);
    const cutoff = nowMinusDays(windowDays);

    const closedCte = sql`
      SELECT
        ${i.assignee_id} AS assignee_id,
        ${cycle}         AS cycle_hours
      FROM ${Q("issue")} i
      WHERE ${i.project_id} = ${projectId}
        AND ${i.deletedAt} IS NULL
        AND ${i.status} = ${ISSUE_STATUS.DONE}
        AND ${i.completedAt} IS NOT NULL
        AND ${i.completedAt} >= ${cutoff}
    `;

    const statsCte = sql`
      SELECT
        c.assignee_id,
        COUNT(*)              AS completed_count,
        AVG(c.cycle_hours)    AS avg_cycle_hours
      FROM closed c
      GROUP BY c.assignee_id
    `;

    const ctes = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .with("closed", closedCte)
      .with("stats", statsCte)
      .build();

    const final = sql`
      ${ctes}
      SELECT
        s.assignee_id                                                            AS ${Q("assigneeId")},
        ${u.name}                                                                AS ${Q("assigneeName")},
        s.completed_count                                                        AS ${Q("completedCount")},
        s.avg_cycle_hours                                                        AS ${Q("averageCycleHours")},
        ROW_NUMBER() OVER (ORDER BY s.completed_count DESC, s.avg_cycle_hours ASC)
                                                                                 AS ${Q("rankInProject")}
      FROM stats s
      LEFT JOIN ${Q("user")} u ON ${u.id} = s.assignee_id
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
   * The query reads the JSON `payload` column to extract the entered
   * status using dialect-specific JSON path operators.
   */
  async timeInStatus(issueId: number): Promise<TimeInStatusRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q } = D;

    const enteredStatus =
      D.dialect === "postgres"
        ? sql`${Q("payload")}->>'to'`
        : sql`JSON_UNQUOTE(JSON_EXTRACT(${Q("payload")}, '$.to'))`;

    const hoursDiff =
      D.dialect === "postgres"
        ? sql`EXTRACT(EPOCH FROM (LEAD(${Q("createdAt")}) OVER w - ${Q("createdAt")})) / 3600.0`
        : sql`TIMESTAMPDIFF(SECOND, ${Q("createdAt")}, LEAD(${Q("createdAt")}) OVER w) / 3600.0`;

    const final = sql`
      SELECT
        ${Q("issueId")}                               AS ${Q("issueId")},
        ${enteredStatus}                              AS ${Q("status")},
        ${Q("createdAt")}                             AS ${Q("enteredAt")},
        LEAD(${Q("createdAt")}) OVER w                AS ${Q("leftAt")},
        ${hoursDiff}                                  AS ${Q("hoursInStatus")}
      FROM ${Q("activity_log")}
      WHERE ${Q("issueId")} = ${issueId}
        AND ${Q("action")} = ${"STATUS_CHANGED"}
      WINDOW w AS (PARTITION BY ${Q("issueId")} ORDER BY ${Q("createdAt")})
      ORDER BY ${Q("createdAt")}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      issueId: Number(row.issueId),
      status: String(row.status),
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

  // ── Group-by + window: weekly lead time ─────────────────

  async leadTimeByWeek(
    projectId: number,
    windowDays = 60,
  ): Promise<LeadTimeRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q, weekOf, hoursBetween, nowMinusDays } = D;
    const week = weekOf(Q("completedAt"));
    const cutoff = nowMinusDays(windowDays);
    const cycle = hoursBetween(Q("createdAt"), Q("completedAt"));

    const final = sql`
      SELECT
        ${week}                       AS ${Q("weekStart")},
        AVG(${cycle})                 AS ${Q("leadTimeHours")},
        COUNT(*)                      AS ${Q("closedCount")}
      FROM ${Q("issue")}
      WHERE ${Q("project_id")} = ${projectId}
        AND ${Q("status")} = ${ISSUE_STATUS.DONE}
        AND ${Q("completedAt")} IS NOT NULL
        AND ${Q("completedAt")} >= ${cutoff}
        AND ${Q("deletedAt")} IS NULL
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
}

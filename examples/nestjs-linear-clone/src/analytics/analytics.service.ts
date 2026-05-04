import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  RawQueryBuilder,
  sql,
  raw,
} from "@stingerloom/orm";
import {
  detectDialect,
  q,
  dayOf,
  hoursBetween,
  nowMinusDays,
  weekOf,
} from "./sql-helpers";
import { ISSUE_STATUS } from "../common/enums";

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
    const dialect = detectDialect(this.em);
    const issue = q("issue", dialect);
    const id = q("id", dialect);
    const parentId = q("parent_id", dialect);
    const deletedAt = q("deletedAt", dialect);
    const path = q("path", dialect);
    const depth = q("depth", dialect);

    const castText = dialect === "postgres" ? "TEXT" : "CHAR(255)";
    const childPath =
      dialect === "postgres"
        ? `t.${path} || '/' || CAST(c.${id} AS TEXT)`
        : `CONCAT(t.${path}, '/', CAST(c.${id} AS CHAR(255)))`;

    const treeBody = sql`
      SELECT
        r.${raw(id)}        AS ${raw(id)},
        r.${raw(parentId)}  AS ${raw(q("parentId", dialect))},
        r.${raw(q("number", dialect))} AS ${raw(q("number", dialect))},
        r.${raw(q("title", dialect))}  AS ${raw(q("title", dialect))},
        r.${raw(q("status", dialect))} AS ${raw(q("status", dialect))},
        0                                                AS ${raw(depth)},
        CAST(r.${raw(id)} AS ${raw(castText)})           AS ${raw(path)}
      FROM ${raw(issue)} r
      WHERE r.${raw(id)} = ${rootIssueId}
        AND r.${raw(deletedAt)} IS NULL
      UNION ALL
      SELECT
        c.${raw(id)},
        c.${raw(parentId)},
        c.${raw(q("number", dialect))},
        c.${raw(q("title", dialect))},
        c.${raw(q("status", dialect))},
        t.${raw(depth)} + 1,
        ${raw(childPath)}
      FROM ${raw(issue)} c
      INNER JOIN issue_tree t ON c.${raw(parentId)} = t.${raw(id)}
      WHERE c.${raw(deletedAt)} IS NULL
        AND t.${raw(depth)} < ${maxDepth}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("issue_tree", treeBody)
      .select("*")
      .from("issue_tree")
      .orderBy([{ column: path, direction: "ASC" }])
      .build();

    const rows = await this.em.query<Record<string, unknown>>(built);
    return rows.map((r) => ({
      id: Number(r.id),
      parentId: r.parentId === null ? null : Number(r.parentId),
      number: Number(r.number),
      title: String(r.title),
      status: String(r.status),
      depth: Number(r.depth),
      path: String(r.path),
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
    const dialect = detectDialect(this.em);
    const issue = q("issue", dialect);
    const sprintCol = q("sprint_id", dialect);
    const completedAt = q("completedAt", dialect);
    const estimate = q("estimate", dialect);
    const status = q("status", dialect);
    const deletedAt = q("deletedAt", dialect);
    const truncDay = dayOf(`i.${completedAt}`, dialect);

    const sprintTotalCte = sql`
      SELECT COALESCE(SUM(${raw(estimate)}), 0) AS total_estimate
      FROM ${raw(issue)}
      WHERE ${raw(sprintCol)} = ${sprintId}
        AND ${raw(deletedAt)} IS NULL
    `;

    const dailyCte = sql`
      SELECT
        ${raw(truncDay)}                          AS day,
        COUNT(*)                                  AS completed_count,
        COALESCE(SUM(i.${raw(estimate)}), 0)      AS completed_estimate
      FROM ${raw(issue)} i
      WHERE i.${raw(sprintCol)} = ${sprintId}
        AND i.${raw(deletedAt)} IS NULL
        AND i.${raw(status)} = ${ISSUE_STATUS.DONE}
        AND i.${raw(completedAt)} IS NOT NULL
      GROUP BY ${raw(truncDay)}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(dialect === "postgres" ? "postgresql" : "mysql")
      .with("sprint_total", sprintTotalCte)
      .with("daily", dailyCte)
      .build();

    const final = sql`
      ${built}
      SELECT
        day                                                                              AS day,
        completed_count                                                                  AS ${raw(q("completedThatDay", dialect))},
        SUM(completed_count) OVER (ORDER BY day)                                         AS ${raw(q("cumulativeCompleted", dialect))},
        (SELECT total_estimate FROM sprint_total)
          - SUM(completed_estimate) OVER (ORDER BY day)                                  AS ${raw(q("remainingEstimate", dialect))}
      FROM daily
      ORDER BY day
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((r) => ({
      day:
        r.day instanceof Date
          ? r.day.toISOString().slice(0, 10)
          : String(r.day),
      completedThatDay: Number(r.completedThatDay),
      cumulativeCompleted: Number(r.cumulativeCompleted),
      remainingEstimate: Number(r.remainingEstimate ?? 0),
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
    const dialect = detectDialect(this.em);
    const issue = q("issue", dialect);
    const userTbl = q("user", dialect);
    const projectCol = q("project_id", dialect);
    const assigneeCol = q("assignee_id", dialect);
    const completedAt = q("completedAt", dialect);
    const createdAt = q("createdAt", dialect);
    const status = q("status", dialect);
    const deletedAt = q("deletedAt", dialect);
    const id = q("id", dialect);
    const name = q("name", dialect);
    const cycle = hoursBetween(`i.${createdAt}`, `i.${completedAt}`, dialect);
    const cutoff = nowMinusDays(windowDays, dialect);

    const closedCte = sql`
      SELECT
        i.${raw(assigneeCol)} AS assignee_id,
        ${raw(cycle)}         AS cycle_hours
      FROM ${raw(issue)} i
      WHERE i.${raw(projectCol)} = ${projectId}
        AND i.${raw(deletedAt)} IS NULL
        AND i.${raw(status)} = ${ISSUE_STATUS.DONE}
        AND i.${raw(completedAt)} IS NOT NULL
        AND i.${raw(completedAt)} >= ${raw(cutoff)}
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
      .setDatabaseType(dialect === "postgres" ? "postgresql" : "mysql")
      .with("closed", closedCte)
      .with("stats", statsCte)
      .build();

    const final = sql`
      ${ctes}
      SELECT
        s.assignee_id                                                            AS ${raw(q("assigneeId", dialect))},
        u.${raw(name)}                                                           AS ${raw(q("assigneeName", dialect))},
        s.completed_count                                                        AS ${raw(q("completedCount", dialect))},
        s.avg_cycle_hours                                                        AS ${raw(q("averageCycleHours", dialect))},
        ROW_NUMBER() OVER (ORDER BY s.completed_count DESC, s.avg_cycle_hours ASC)
                                                                                 AS ${raw(q("rankInProject", dialect))}
      FROM stats s
      LEFT JOIN ${raw(userTbl)} u ON u.${raw(id)} = s.assignee_id
      ORDER BY ${raw(q("rankInProject", dialect))}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((r) => ({
      assigneeId: r.assigneeId === null ? null : Number(r.assigneeId),
      assigneeName: r.assigneeName ? String(r.assigneeName) : null,
      completedCount: Number(r.completedCount),
      averageCycleHours:
        r.averageCycleHours === null
          ? 0
          : Number(Number(r.averageCycleHours).toFixed(2)),
      rankInProject: Number(r.rankInProject),
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
    const dialect = detectDialect(this.em);
    const log = q("activity_log", dialect);
    const issueIdCol = q("issueId", dialect);
    const action = q("action", dialect);
    const payload = q("payload", dialect);
    const createdAt = q("createdAt", dialect);

    const enteredStatus =
      dialect === "postgres"
        ? sql`${raw(payload)}->>'to'`
        : sql`JSON_UNQUOTE(JSON_EXTRACT(${raw(payload)}, '$.to'))`;

    const hoursDiff =
      dialect === "postgres"
        ? sql`EXTRACT(EPOCH FROM (LEAD(${raw(createdAt)}) OVER w - ${raw(createdAt)})) / 3600.0`
        : sql`TIMESTAMPDIFF(SECOND, ${raw(createdAt)}, LEAD(${raw(createdAt)}) OVER w) / 3600.0`;

    const final = sql`
      SELECT
        ${raw(issueIdCol)}                            AS ${raw(q("issueId", dialect))},
        ${enteredStatus}                              AS ${raw(q("status", dialect))},
        ${raw(createdAt)}                             AS ${raw(q("enteredAt", dialect))},
        LEAD(${raw(createdAt)}) OVER w                AS ${raw(q("leftAt", dialect))},
        ${hoursDiff}                                  AS ${raw(q("hoursInStatus", dialect))}
      FROM ${raw(log)}
      WHERE ${raw(issueIdCol)} = ${issueId}
        AND ${raw(action)} = ${"STATUS_CHANGED"}
      WINDOW w AS (PARTITION BY ${raw(issueIdCol)} ORDER BY ${raw(createdAt)})
      ORDER BY ${raw(createdAt)}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((r) => ({
      issueId: Number(r.issueId),
      status: String(r.status),
      enteredAt:
        r.enteredAt instanceof Date
          ? r.enteredAt.toISOString()
          : String(r.enteredAt),
      leftAt:
        r.leftAt === null
          ? null
          : r.leftAt instanceof Date
            ? r.leftAt.toISOString()
            : String(r.leftAt),
      hoursInStatus:
        r.hoursInStatus === null
          ? null
          : Number(Number(r.hoursInStatus).toFixed(2)),
    }));
  }

  // ── Group-by + window: weekly lead time ─────────────────

  async leadTimeByWeek(
    projectId: number,
    windowDays = 60,
  ): Promise<LeadTimeRow[]> {
    const dialect = detectDialect(this.em);
    const issue = q("issue", dialect);
    const projectCol = q("project_id", dialect);
    const completedAt = q("completedAt", dialect);
    const createdAt = q("createdAt", dialect);
    const status = q("status", dialect);
    const deletedAt = q("deletedAt", dialect);
    const week = weekOf(completedAt, dialect);
    const cutoff = nowMinusDays(windowDays, dialect);
    const cycle = hoursBetween(createdAt, completedAt, dialect);

    const final = sql`
      SELECT
        ${raw(week)}                       AS ${raw(q("weekStart", dialect))},
        AVG(${raw(cycle)})                 AS ${raw(q("leadTimeHours", dialect))},
        COUNT(*)                           AS ${raw(q("closedCount", dialect))}
      FROM ${raw(issue)}
      WHERE ${raw(projectCol)} = ${projectId}
        AND ${raw(status)} = ${ISSUE_STATUS.DONE}
        AND ${raw(completedAt)} IS NOT NULL
        AND ${raw(completedAt)} >= ${raw(cutoff)}
        AND ${raw(deletedAt)} IS NULL
      GROUP BY ${raw(week)}
      ORDER BY ${raw(week)}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((r) => ({
      weekStart:
        r.weekStart instanceof Date
          ? r.weekStart.toISOString().slice(0, 10)
          : String(r.weekStart),
      leadTimeHours: Number(Number(r.leadTimeHours ?? 0).toFixed(2)),
      closedCount: Number(r.closedCount),
    }));
  }
}

import {
  Injectable,
  Inject,
  NotImplementedException,
} from "@nestjs/common";
import {
  EntityManager,
  Expressions,
  RawQueryBuilder,
  Sql,
  SqliteDriver,
  qAlias,
  raw,
  sql,
} from "@stingerloom/orm";
import { detectDialect } from "./sql-helpers";
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
    const dialect = detectDialect(this.em);
    const isMySql = dialect === "mysql";
    // Recursive-CTE column type for the synthesized `path`: MySQL fixes the
    // recursive column type from the anchor, so we need an explicit width
    // big enough for `maxDepth` zero-padded segments (10 chars + '/'). PG
    // picks TEXT from the anchor and grows freely. `CONCAT` is portable
    // between PG (≥9.1) and MySQL with identical semantics.
    //
    // `path` segments are zero-padded with LPAD so ORDER BY path produces a
    // depth-first preorder by id rather than the lexicographic order that
    // would put id=10 ahead of id=2.
    const castText = isMySql ? "VARCHAR(4000)" : "TEXT";

    const r = this.em.ref(Issue, "r");
    const c = this.em.ref(Issue, "c");
    // `t` is the recursive CTE alias; depth/path are CTE-only columns.
    const t = this.em.aliasRef("t");
    const Q = (name: string) => raw(this.em.wrap(name));
    const padded = (idSql: Sql) =>
      sql`LPAD(CAST(${idSql} AS ${raw(castText)}), 10, '0')`;

    const built = RawQueryBuilder.create()
      .setDatabaseType(isMySql ? "mysql" : "postgresql")
      .withRecursive("issue_tree", (qb) =>
        qb
          .selectFragments([
            r.as("id"),
            r.as("parentId"),
            r.as("number"),
            r.as("title"),
            r.as("status"),
            sql`0 AS ${Q("depth")}`,
            sql`CAST(${padded(r.id)} AS ${raw(castText)}) AS ${Q("path")}`,
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
            sql`CONCAT(${t.path}, '/', ${padded(c.id)})`,
          ])
          .from(c)
          .innerJoin("issue_tree", "t", sql`${c.parentId} = ${t.id}`)
          .where([sql`${c.deletedAt} IS NULL`, sql`${t.depth} < ${maxDepth}`]),
      )
      .select("*")
      .from("issue_tree")
      .orderBy([{ column: this.em.wrap("path"), direction: "ASC" }])
      .build();

    const rows = await this.em.query<Record<string, unknown>>(built);
    // Strip LPAD zeros so consumers see a human-readable `1/2/3` path.
    // Sort ordering was already locked in by the DB on the padded form.
    const unpadPath = (raw: string) =>
      raw
        .split("/")
        .map((segment) => String(Number(segment)))
        .join("/");
    return rows.map((row) => ({
      id: Number(row.id),
      parentId: row.parentId === null ? null : Number(row.parentId),
      number: Number(row.number),
      title: String(row.title),
      status: String(row.status),
      depth: Number(row.depth),
      path: unpadPath(String(row.path)),
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
      // Group by `u.id` (PK) so two users with the same `name` stay
      // separate groups; including `u.name` in the key keeps PG's
      // strict GROUP BY happy when the column is projected.
      .groupBy([i.assigneeId, u.id, u.name])
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
   * Status timeline for an issue: one row per status transition, with the
   * hours the issue spent in each status before the next change.
   *
   * Pure DSL — no JSON path, no dialect branching, no raw SQL. Works the
   * same on PostgreSQL, MySQL, and SQLite because the source data is the
   * typed `statusTo` / `statusFrom` columns on `activity_log` (populated
   * by `IssueAuditSubscriber` when a status change is diffed). The
   * underlying JSON `payload` still records the full change set for the
   * human-readable feed; this query just reads the denormalized columns.
   */
  async timeInStatus(issueId: number): Promise<TimeInStatusRow[]> {
    const a = qAlias(ActivityLog, "a");

    const leftAt = Expressions.lead(a.createdAt)
      .partitionBy(a.issueId)
      .orderBy(a.createdAt.asc())
      .toScalar();

    const hoursInStatus = Expressions.dateDiff(leftAt, a.createdAt, "second")
      .floatValue()
      .div(3600);

    const rows = await this.em
      .createQueryBuilder(ActivityLog, "a")
      .select([
        a.issueId.as("issueId"),
        a.statusTo.as("status"),
        a.createdAt.as("enteredAt"),
        leftAt.as("leftAt"),
        hoursInStatus.as("hoursInStatus"),
      ])
      .where(a.issueId.eq(issueId))
      .andWhere(a.statusTo.isNotNull())
      .addOrderBy(a.createdAt, "ASC")
      .getRawMany();

    return rows.map((row) => ({
      issueId: Number(row.issueId),
      status:
        row.status === null || row.status === undefined
          ? ""
          : String(row.status),
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
    // `detectDialect` is a 2-way mysql/postgres switch — SQLite would
    // silently fall into the PG branch and then explode at runtime on
    // `percentile_cont`. Fail loudly with a 501 instead.
    if (this.em.getDriver() instanceof SqliteDriver) {
      throw new NotImplementedException(
        "cycleTimePercentiles is only available on PostgreSQL and MySQL.",
      );
    }
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
   * MySQL emulation of `percentile_cont`. MySQL has no ordered-set
   * aggregate, so the standard stand-in is: rank every cycle-time with
   * `ROW_NUMBER() OVER (ORDER BY cycle)`, then pick the row at
   * `rn = CEIL(total * p)` for each percentile `p`.
   *
   * The CTE is fully typed — the projection, the `ROW_NUMBER` ordering,
   * and `COUNT(*) OVER ()` for the sample size all come from the query
   * builder. Carrying `total` inside the CTE lets the outer query read
   * `cycles` directly, with no interposed FROM-subquery. Only the
   * percentile-row picker stays raw: `cycles` is a CTE alias with no
   * entity behind it, and there is no DSL helper for the
   * `MAX(CASE WHEN rn = CEIL(total * p) …)` shape.
   */
  private async cycleTimePercentilesMySqlEmulation(
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

    // CTE — one row per completed issue: its cycle time, its 1-based
    // rank by ascending cycle time, and the total sample size. All three
    // columns come from the typed builder; `COUNT(*) OVER ()` copies the
    // sample size onto every row so the outer query never needs a
    // derived table to recompute it.
    const cyclesCte = this.em
      .createQueryBuilder(Issue, "i")
      .select([
        cycleHours.as("hours"),
        Expressions.rowNumber().orderBy(cycleHours.asc()).as("rn"),
        Expressions.count("*").over().as("total"),
      ])
      .where(i.projectId.eq(projectId))
      .andWhere(i.status.eq(ISSUE_STATUS.DONE))
      .andWhere(i.completedAt.isNotNull())
      .andWhere(i.completedAt.gte(cutoff))
      .andWhere(i.deletedAt.isNull())
      .toSql();

    // Outer query — for each percentile `p`, pick the cycle-time of the
    // row at `rn = CEIL(total * p)`. `cycles` is grouped by `total` only
    // returns rows when the CTE is non-empty, so `total >= 1` and
    // `CEIL(total * p) >= 1` for every `p` here — no floor needed.
    const c = this.em.aliasRef("cycles");
    const Q = (name: string) => raw(this.em.wrap(name));
    const pick = (p: number) =>
      sql`MAX(CASE WHEN ${c.rn} = CEIL(${c.total} * ${p}) THEN ${c.hours} END)`;

    const built = RawQueryBuilder.create()
      .setDatabaseType("mysql")
      .with("cycles", cyclesCte)
      .selectFragments([
        sql`${pick(0.5)} AS ${Q("p50")}`,
        sql`${pick(0.75)} AS ${Q("p75")}`,
        sql`${pick(0.95)} AS ${Q("p95")}`,
        sql`${c.total} AS ${Q("sampleSize")}`,
      ])
      .from("cycles")
      .groupBy([c.total])
      .build();

    const rows = await this.em.query<Record<string, unknown>>(built);
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

import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  qAlias,
  raw,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { WorkLog } from "./work-log.entity";
import { Issue } from "../issues/issue.entity";
import { CreateWorkLogDto, UpdateWorkLogDto } from "./dto/work-log.dto";
import { applyPatch, pickDefined } from "../../common/dto-helpers";
import { detectDialect, dsl } from "../analytics/sql-helpers";

const WORK_LOG_PATCH_KEYS = ["hours", "description"] as const;

export interface DailyHoursRow {
  day: string;
  hours: number;
}

/**
 * Sprint velocity row: one entry per sprint, with the rolling 3-sprint
 * average. Computed via window function `AVG(...) OVER (ROWS BETWEEN N
 * PRECEDING AND CURRENT ROW)` — the canonical "rolling N" pattern that
 * Issue #304 calls out as the time-tracking ORM stress test.
 */
export interface SprintVelocityRow {
  sprintId: number;
  sprintName: string;
  startDate: string | null;
  completedHours: number;
  rollingAverageHours: number;
}

@Injectable()
export class WorkLogsService {
  constructor(
    @InjectRepository(WorkLog)
    private readonly repo: BaseRepository<WorkLog>,
    @InjectRepository(Issue)
    private readonly issueRepo: BaseRepository<Issue>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(
    issueId: number,
    userId: number,
    dto: CreateWorkLogDto,
  ): Promise<WorkLog> {
    const issue = await this.issueRepo.findOne({ where: { id: issueId } });
    if (!issue) throw new NotFoundException(`Issue ${issueId} not found`);

    const log = new WorkLog();
    log.issueId = issueId;
    log.userId = userId;
    log.hours = dto.hours;
    log.description = dto.description ?? null;
    log.loggedAt = dto.loggedAt ? new Date(dto.loggedAt) : new Date();
    return this.repo.save(log);
  }

  async findByIssue(issueId: number): Promise<WorkLog[]> {
    const w = qAlias(WorkLog, "w");
    return this.em
      .createQueryBuilder(w)
      .where(w.issueId.eq(issueId))
      .orderBy(w.loggedAt.desc())
      .getMany();
  }

  async findOne(id: number): Promise<WorkLog> {
    const log = await this.repo.findOne({ where: { id } });
    if (!log) throw new NotFoundException(`WorkLog ${id} not found`);
    return log;
  }

  @Transactional()
  async update(id: number, dto: UpdateWorkLogDto): Promise<WorkLog> {
    const log = await this.findOne(id);
    applyPatch(log, pickDefined(dto, WORK_LOG_PATCH_KEYS) as unknown as Partial<WorkLog>);
    if (dto.loggedAt !== undefined) log.loggedAt = new Date(dto.loggedAt);
    return this.repo.save(log);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.delete({ id });
  }

  /**
   * Per-day totals for the assignee's logged hours within a window. Useful
   * for time-tracking dashboards. Uses dialect-portable `dayOf` truncation.
   */
  async dailyHoursByUser(
    userId: number,
    sinceDays = 30,
  ): Promise<DailyHoursRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q, dayOf, nowMinusDays } = D;
    const day = dayOf(Q("logged_at"));
    const cutoff = nowMinusDays(sinceDays);
    const final = sql`
      SELECT
        ${day}                  AS ${Q("day")},
        SUM(${Q("hours")})      AS ${Q("hours")}
      FROM ${Q("work_log")}
      WHERE ${Q("user_id")} = ${userId}
        AND ${Q("logged_at")} >= ${cutoff}
      GROUP BY ${day}
      ORDER BY ${day}
    `;
    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      day:
        row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day),
      hours: Number(Number(row.hours ?? 0).toFixed(2)),
    }));
  }

  /**
   * Sprint velocity with rolling-N-sprint moving average.
   *
   * For each sprint of `projectId`, sum the WorkLog hours of every issue
   * assigned to that sprint, then apply
   *   AVG(...) OVER (ORDER BY start_date ROWS BETWEEN N PRECEDING AND CURRENT ROW)
   * to compute the rolling average. This is the textbook moving-window
   * use-case Issue #304 calls out as the velocity ORM stress test.
   *
   * Sprints with no `startDate` are pushed to the end of the ordering so
   * they don't poison the rolling window for properly-dated sprints.
   */
  async sprintVelocity(
    projectId: number,
    rollingWindow = 3,
  ): Promise<SprintVelocityRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q } = D;

    // ROWS BETWEEN N PRECEDING — N is a literal, not a parameter, because
    // window-frame bounds must be compile-time constants on both engines.
    const window = Math.max(0, Math.floor(rollingWindow) - 1);

    const final = sql`
      SELECT
        s.${Q("id")}                                                          AS ${Q("sprintId")},
        s.${Q("name")}                                                        AS ${Q("sprintName")},
        s.${Q("start_date")}                                                  AS ${Q("startDate")},
        COALESCE(SUM(w.${Q("hours")}), 0)                                     AS ${Q("completedHours")},
        AVG(COALESCE(SUM(w.${Q("hours")}), 0)) OVER (
          ORDER BY (s.${Q("start_date")} IS NULL), s.${Q("start_date")}, s.${Q("id")}
          ROWS BETWEEN ${raw(String(window))} PRECEDING AND CURRENT ROW
        )                                                                     AS ${Q("rollingAverageHours")}
      FROM ${Q("sprint")} s
      LEFT JOIN ${Q("issue")} i ON i.${Q("sprint_id")} = s.${Q("id")} AND i.${Q("deleted_at")} IS NULL
      LEFT JOIN ${Q("work_log")} w ON w.${Q("issue_id")} = i.${Q("id")}
      WHERE s.${Q("project_id")} = ${projectId}
      GROUP BY s.${Q("id")}, s.${Q("name")}, s.${Q("start_date")}
      ORDER BY (s.${Q("start_date")} IS NULL), s.${Q("start_date")}, s.${Q("id")}
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      sprintId: Number(row.sprintId),
      sprintName: String(row.sprintName),
      startDate:
        row.startDate === null || row.startDate === undefined
          ? null
          : row.startDate instanceof Date
            ? row.startDate.toISOString().slice(0, 10)
            : String(row.startDate),
      completedHours: Number(Number(row.completedHours ?? 0).toFixed(2)),
      rollingAverageHours: Number(
        Number(row.rollingAverageHours ?? 0).toFixed(2),
      ),
    }));
  }
}

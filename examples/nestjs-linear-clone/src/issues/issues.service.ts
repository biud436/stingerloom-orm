import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  CursorPaginationResult,
  OptimisticLockError,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Issue } from "./issue.entity";
import {
  CreateIssueDto,
  UpdateIssueDto,
  AssignLabelDto,
  AssignAssigneeDto,
} from "./dto/issue.dto";
import { ProjectsService } from "../projects/projects.service";
import { ActivityService } from "../activity/activity.service";
import { applyPatch, pickDefined } from "../common/dto-helpers";
import {
  ACTIVITY_ACTION,
  ISSUE_STATUS,
  IssueStatus,
  TERMINAL_STATUSES,
} from "../common/enums";

const PATCHABLE_KEYS = [
  "title",
  "description",
  "status",
  "priority",
  "estimate",
  "sprintId",
  "assigneeId",
  "customFields",
] as const;

@Injectable()
export class IssuesService {
  constructor(
    @InjectRepository(Issue)
    private readonly repo: BaseRepository<Issue>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly projects: ProjectsService,
    private readonly activity: ActivityService,
  ) {}

  @Transactional()
  async create(dto: CreateIssueDto): Promise<Issue> {
    const number = await this.projects.nextIssueNumber(dto.projectId);

    const issue = new Issue();
    issue.projectId = dto.projectId;
    issue.number = number;
    issue.title = dto.title;
    issue.status = dto.status ?? ISSUE_STATUS.BACKLOG;
    issue.priority = dto.priority ?? 0;

    applyPatch(
      issue,
      pickDefined(dto, [
        "description",
        "estimate",
        "sprintId",
        "assigneeId",
        "reporterId",
        "parentId",
      ] as const) as Partial<Issue>,
    );

    if (dto.customFields !== undefined) {
      issue.customFields = JSON.stringify(dto.customFields) as any;
    }

    const saved = await this.repo.save(issue);

    await this.activity.log({
      issueId: saved.id,
      actorUserId: dto.reporterId ?? null,
      action: ACTIVITY_ACTION.ISSUE_CREATED,
      payload: {
        title: saved.title,
        status: saved.status,
        priority: saved.priority,
      },
    });

    return saved;
  }

  /**
   * SelectQueryBuilder is the right tool here: the property→column map
   * established by `createQueryBuilder(Issue, "i")` already knows that
   * `Issue.projectId` lives in the `project_id` FK column, so we don't
   * need ad-hoc snake_case casts.
   */
  findAll(projectId?: number): Promise<Issue[]> {
    const qb = this.em.createQueryBuilder(Issue, "i");
    if (projectId !== undefined) qb.where("i.project_id", projectId);
    return qb.getMany();
  }

  async findOne(id: number): Promise<Issue> {
    // We load `labels` (M2M) via relations but skip assignee/reporter/sprint
    // because joining the `user` table twice in one SELECT trips MariaDB's
    // "Not unique table/alias" error.
    const issue = await this.repo.findOne({
      where: { id },
      relations: ["labels"],
    });
    if (!issue) throw new NotFoundException(`Issue ${id} not found`);
    return issue;
  }

  /** Cursor pagination over issues. Used by the activity feed. */
  findWithCursor(
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<Issue>> {
    return this.repo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "DESC",
    });
  }

  /**
   * Optimistic update — if the caller's expectedVersion doesn't match the
   * current row, @Version raises OptimisticLockError which we surface as a 409.
   * Status / priority / assignee transitions also fan out to ActivityLog.
   */
  @Transactional()
  async update(
    id: number,
    dto: UpdateIssueDto,
    actorUserId?: number,
  ): Promise<Issue> {
    const before = await this.findOne(id);

    if (before.version !== dto.expectedVersion) {
      throw new ConflictException(
        `Stale version: expected ${dto.expectedVersion}, current is ${before.version}`,
      );
    }

    const beforeSnap = {
      status: before.status,
      priority: before.priority,
      assigneeId: before.assigneeId ?? null,
    };

    // pickDefined drops undefined entries; applyPatch lets us route the
    // `customFields` JSON through `JSON.stringify` without an extra branch.
    applyPatch(
      before,
      pickDefined(dto, PATCHABLE_KEYS) as Partial<Issue>,
      { customFields: (v) => JSON.stringify(v) },
    );

    if (
      dto.status &&
      TERMINAL_STATUSES.includes(dto.status) &&
      !TERMINAL_STATUSES.includes(beforeSnap.status as IssueStatus)
    ) {
      before.completedAt = new Date();
    }

    let saved: Issue;
    try {
      saved = await this.repo.save(before);
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        throw new ConflictException(
          "Issue was modified by another writer; refetch and retry",
        );
      }
      throw err;
    }

    await this.logTransitions(id, beforeSnap, dto, actorUserId);
    return saved;
  }

  /**
   * Audit-log fan-out. Pulled out of update() so the transition rules sit
   * in one obvious place.
   */
  private async logTransitions(
    issueId: number,
    before: { status: string; priority: number; assigneeId: number | null },
    dto: UpdateIssueDto,
    actorUserId?: number,
  ): Promise<void> {
    const transitions: Array<Promise<unknown>> = [];

    if (dto.status && dto.status !== before.status) {
      transitions.push(
        this.activity.log({
          issueId,
          actorUserId: actorUserId ?? null,
          action: ACTIVITY_ACTION.STATUS_CHANGED,
          payload: { from: before.status, to: dto.status },
        }),
      );
    }
    if (dto.priority !== undefined && dto.priority !== before.priority) {
      transitions.push(
        this.activity.log({
          issueId,
          actorUserId: actorUserId ?? null,
          action: ACTIVITY_ACTION.PRIORITY_CHANGED,
          payload: { from: before.priority, to: dto.priority },
        }),
      );
    }
    if (
      dto.assigneeId !== undefined &&
      dto.assigneeId !== before.assigneeId
    ) {
      transitions.push(
        this.activity.log({
          issueId,
          actorUserId: actorUserId ?? null,
          action:
            dto.assigneeId === null
              ? ACTIVITY_ACTION.UNASSIGNED
              : ACTIVITY_ACTION.ASSIGNED,
          payload: { from: before.assigneeId, to: dto.assigneeId },
        }),
      );
    }

    await Promise.all(transitions);
  }

  /** Set or clear the assignee — convenience wrapper that bumps version. */
  @Transactional()
  async assign(
    id: number,
    dto: AssignAssigneeDto,
    actorUserId?: number,
  ): Promise<Issue> {
    const issue = await this.findOne(id);
    return this.update(
      id,
      { expectedVersion: issue.version, assigneeId: dto.assigneeId },
      actorUserId,
    );
  }

  async softRemove(id: number): Promise<void> {
    await this.findOne(id);
    await this.repo.softDelete({ id });
  }

  async restore(id: number): Promise<void> {
    await this.repo.restore({ id });
  }

  /**
   * M2M join-table I/O. The ORM has no first-class "attach a join row" API,
   * so we issue dialect-flavored idempotent INSERTs via the parameterized
   * `sql` template. Logged in the activity trail.
   */
  async addLabel(
    issueId: number,
    dto: AssignLabelDto,
    actorUserId?: number,
  ): Promise<{ message: string }> {
    await this.findOne(issueId);
    await this.em.query(this.attachLabelSql(issueId, dto.labelId));
    await this.activity.log({
      issueId,
      actorUserId: actorUserId ?? null,
      action: ACTIVITY_ACTION.LABEL_ADDED,
      payload: { labelId: dto.labelId },
    });
    return { message: `Label ${dto.labelId} added to issue ${issueId}` };
  }

  async removeLabel(
    issueId: number,
    labelId: number,
    actorUserId?: number,
  ): Promise<{ message: string }> {
    await this.findOne(issueId);
    await this.em.query(this.detachLabelSql(issueId, labelId));
    await this.activity.log({
      issueId,
      actorUserId: actorUserId ?? null,
      action: ACTIVITY_ACTION.LABEL_REMOVED,
      payload: { labelId },
    });
    return { message: `Label ${labelId} removed from issue ${issueId}` };
  }

  private attachLabelSql(issueId: number, labelId: number) {
    const isPg = this.em
      .getDriver()
      .constructor.name.toLowerCase()
      .includes("postgres");
    return isPg
      ? sql`INSERT INTO "issue_labels" ("issue_id", "label_id") VALUES (${issueId}, ${labelId}) ON CONFLICT DO NOTHING`
      : sql`INSERT IGNORE INTO \`issue_labels\` (\`issue_id\`, \`label_id\`) VALUES (${issueId}, ${labelId})`;
  }

  private detachLabelSql(issueId: number, labelId: number) {
    const isPg = this.em
      .getDriver()
      .constructor.name.toLowerCase()
      .includes("postgres");
    return isPg
      ? sql`DELETE FROM "issue_labels" WHERE "issue_id" = ${issueId} AND "label_id" = ${labelId}`
      : sql`DELETE FROM \`issue_labels\` WHERE \`issue_id\` = ${issueId} AND \`label_id\` = ${labelId}`;
  }

  /**
   * Direct children of `issueId`. The recursive subissue tree (depth N)
   * lives in the Analytics module's `WITH RECURSIVE` query.
   */
  childrenOf(issueId: number): Promise<Issue[]> {
    return this.em
      .createQueryBuilder(Issue, "i")
      .where("i.parent_id", issueId)
      .getMany();
  }
}

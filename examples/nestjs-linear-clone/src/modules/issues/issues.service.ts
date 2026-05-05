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
  qAlias,
  raw,
  sql,
  join,
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
import { applyPatch, pickDefined } from "../../common/dto-helpers";
import {
  ACTIVITY_ACTION,
  ISSUE_STATUS,
  IssueStatus,
  TERMINAL_STATUSES,
} from "../../common/enums";

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
  async create(dto: CreateIssueDto, actorUserId: number): Promise<Issue> {
    const number = await this.projects.nextIssueNumber(dto.projectId);

    const issue = new Issue();
    issue.projectId = dto.projectId;
    issue.number = number;
    issue.title = dto.title;
    issue.status = dto.status ?? ISSUE_STATUS.BACKLOG;
    issue.priority = dto.priority ?? 0;
    // The reporter is always the authenticated caller — never trust a body field.
    issue.reporterId = actorUserId;

    applyPatch(
      issue,
      pickDefined(dto, [
        "description",
        "estimate",
        "sprintId",
        "assigneeId",
        "parentId",
        "customFields",
      ] as const) as Partial<Issue>,
    );

    const saved = await this.repo.save(issue);

    await this.activity.log({
      issueId: saved.id,
      workspaceId: await this.workspaceIdForProject(saved.projectId!),
      actorUserId,
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
   * SelectQueryBuilder + qAlias: `i.projectId` resolves to the `project_id`
   * FK column through entity metadata, so the filter stays type-safe and
   * dialect-portable without ad-hoc snake_case casts.
   */
  findAll(projectId?: number): Promise<Issue[]> {
    const i = qAlias(Issue, "i");
    return this.em
      .createQueryBuilder(i)
      .when(projectId !== undefined, (qb) =>
        qb.where(i.projectId.eq(projectId!)),
      )
      .getMany();
  }

  /**
   * Loads an issue with its labels (M2M) plus the relations callers need
   * for any UI render: assignee, reporter, sprint, parent.
   *
   * Historical note: the previous implementation listed only `["labels"]`
   * because joining the `user` table twice (assignee + reporter) tripped
   * MariaDB's "Not unique table/alias". That is a Stingerloom RelationLoader
   * bug we now exercise on purpose — see the regression test in
   * `test/issues-relations.e2e-spec.ts`. If the bug returns, this method
   * fails loudly, which is the point of this example.
   */
  async findOne(id: number): Promise<Issue> {
    const issue = await this.repo.findOne({
      where: { id },
      relations: ["labels", "assignee", "reporter", "sprint", "parent"],
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
   * Optimistic update. The caller's `expectedVersion` is set on the loaded
   * row before `save()`, so the ORM's `@Version` clause drives conflict
   * detection (`UPDATE … WHERE version = ?`). A stale expected version
   * surfaces as `OptimisticLockError`, mapped to 409 by the global filter.
   *
   * Column-level transition logging is no longer hand-rolled here: the
   * `IssueAuditSubscriber` reads `event.databaseEntity` inside `beforeUpdate`
   * and writes a single `ISSUE_UPDATED` ActivityLog row whose payload is the
   * full diff. This service is left with one job: apply the patch.
   */
  @Transactional()
  async update(
    id: number,
    dto: UpdateIssueDto,
    actorUserId: number,
  ): Promise<Issue> {
    void actorUserId; // actor is read by IssueAuditSubscriber from RequestContext

    const before = await this.findOne(id);

    // Drive `@Version` from the caller's expected version. If a concurrent
    // writer has bumped the row, repo.save() will throw OptimisticLockError.
    // The controller guarantees expectedVersion is set (from body or
    // If-Match), so the `?? before.version` fallback only runs in legacy
    // direct-service callers.
    before.version = dto.expectedVersion ?? before.version;

    const previousStatus = before.status as IssueStatus;
    applyPatch(before, pickDefined(dto, PATCHABLE_KEYS) as Partial<Issue>);

    if (
      dto.status &&
      TERMINAL_STATUSES.includes(dto.status) &&
      !TERMINAL_STATUSES.includes(previousStatus)
    ) {
      before.completedAt = new Date();
    }

    return this.repo.save(before);
  }

  /** Set or clear the assignee — convenience wrapper that bumps version. */
  @Transactional()
  async assign(
    id: number,
    dto: AssignAssigneeDto,
    actorUserId: number,
  ): Promise<Issue> {
    const issue = await this.findOne(id);
    return this.update(
      id,
      { expectedVersion: issue.version, assigneeId: dto.assigneeId },
      actorUserId,
    );
  }

  /**
   * Soft-delete is a single UPDATE — using the `affected` count for the 404
   * signal closes the TOCTOU window that the previous read-then-delete
   * pattern had.
   */
  @Transactional()
  async softRemove(id: number): Promise<void> {
    const result = await this.repo.softDelete({ id });
    if (result.affected === 0) {
      throw new NotFoundException(`Issue ${id} not found`);
    }
  }

  @Transactional()
  async restore(id: number): Promise<void> {
    const result = await this.repo.restore({ id });
    if (result.affected === 0) {
      throw new NotFoundException(`Issue ${id} not found or not deleted`);
    }
  }

  /**
   * "Trash" view — soft-deleted issues for a project, newest-deletion
   * first. Bypasses the auto `deletedAt IS NULL` filter via the query
   * builder's `.withDeleted()` and adds a `deletedAt IS NOT NULL` predicate
   * so live rows do not bleed into the trash.
   */
  findTrash(projectId: number, limit = 50): Promise<Issue[]> {
    const i = qAlias(Issue, "i");
    return this.em
      .createQueryBuilder(i)
      .withDeleted()
      .where(i.projectId.eq(projectId))
      .andWhere(i.deletedAt.isNotNull())
      .orderBy(i.deletedAt.desc())
      .take(Math.min(limit, 200))
      .getMany();
  }

  /**
   * Restore an issue and (when `cascade=true`) re-attach its soft-deleted
   * descendant subtree atomically. The descendant set is computed inline
   * via a recursive CTE so a deeply nested trash subtree resurrects in one
   * round-trip.
   *
   * Idempotent — if the issue (and, with cascade, every descendant) is
   * already active, the UPDATE simply touches zero rows.
   */
  @Transactional()
  async restoreWithCascade(
    id: number,
    cascade: boolean,
  ): Promise<{ restored: number; ids: number[] }> {
    if (!cascade) {
      // Single-row restore — short-circuit (idempotent: zero affected when
      // the row was never deleted, so we don't 404 in that case).
      const before = await this.em.findOne(Issue, {
        where: { id },
        withDeleted: true,
      });
      if (!before) {
        throw new NotFoundException(`Issue ${id} not found`);
      }
      const result = await this.repo.restore({ id });
      return { restored: result.affected ?? 0, ids: result.affected ? [id] : [] };
    }

    // 1. confirm the issue exists (active or trashed). 404 only when truly missing.
    const root = await this.em.findOne(Issue, {
      where: { id },
      withDeleted: true,
    });
    if (!root) {
      throw new NotFoundException(`Issue ${id} not found`);
    }

    // 2. walk the soft-deleted descendant tree starting at `id`. Includes
    //    the root only if it is itself soft-deleted; descendants are added
    //    only when their parent is also in the deleted set, matching the
    //    semantic "restore everything that was trashed together".
    const wrap = (col: string) => this.em.wrap(col);
    const issueTbl = wrap("issue");
    const idCol = wrap("id");
    const parentCol = wrap("parent_id");
    const deletedCol = wrap("deleted_at");

    const descendants = await this.em.query<{ id: number }>(sql`
      WITH RECURSIVE deleted_tree(${raw(idCol)}) AS (
        SELECT ${raw(idCol)} FROM ${raw(issueTbl)}
          WHERE ${raw(idCol)} = ${id} AND ${raw(deletedCol)} IS NOT NULL
        UNION ALL
        SELECT c.${raw(idCol)} FROM ${raw(issueTbl)} c
          INNER JOIN deleted_tree p ON c.${raw(parentCol)} = p.${raw(idCol)}
          WHERE c.${raw(deletedCol)} IS NOT NULL
      )
      SELECT ${raw(idCol)} FROM deleted_tree
    `);

    const idsToRestore = descendants.map((r) => Number(r.id));
    if (idsToRestore.length === 0) {
      // Already-active root, no soft-deleted descendants — idempotent no-op.
      return { restored: 0, ids: [] };
    }

    // 3. clear deletedAt on the whole set in one UPDATE. `join()` from
    //    sql-template-tag expands the id array into N parameter
    //    placeholders so the driver picks `?` (mysql2) vs `$n` (pg).
    const idList = join(
      idsToRestore.map((v) => sql`${v}`),
      ", ",
    );
    await this.em.query(sql`
      UPDATE ${raw(issueTbl)}
         SET ${raw(deletedCol)} = NULL
       WHERE ${raw(idCol)} IN (${idList})
    `);
    return { restored: idsToRestore.length, ids: idsToRestore };
  }

  /**
   * M2M join-table I/O. The ORM treats join tables as pure relational
   * bridges (see docs/relations.md → "Managing Join Table Data"), so we
   * issue idempotent INSERT / DELETE via `em.query()`. The dialect
   * branch picks `ON CONFLICT DO NOTHING` (PostgreSQL) vs `INSERT IGNORE`
   * (MySQL) — the only piece that genuinely has no portable spelling.
   */
  @Transactional()
  async addLabel(
    issueId: number,
    dto: AssignLabelDto,
    actorUserId: number,
  ): Promise<{ message: string }> {
    await this.findOne(issueId);
    await this.em.query(this.attachLabelSql(issueId, dto.labelId));
    await this.activity.log({
      issueId,
      actorUserId,
      action: ACTIVITY_ACTION.LABEL_ADDED,
      payload: { labelId: dto.labelId },
    });
    return { message: `Label ${dto.labelId} added to issue ${issueId}` };
  }

  @Transactional()
  async removeLabel(
    issueId: number,
    labelId: number,
    actorUserId: number,
  ): Promise<{ message: string }> {
    await this.findOne(issueId);
    await this.em.query(this.detachLabelSql(issueId, labelId));
    await this.activity.log({
      issueId,
      actorUserId,
      action: ACTIVITY_ACTION.LABEL_REMOVED,
      payload: { labelId },
    });
    return { message: `Label ${labelId} removed from issue ${issueId}` };
  }

  private attachLabelSql(issueId: number, labelId: number) {
    return this.em.getDriver().isMySqlFamily()
      ? sql`INSERT IGNORE INTO \`issue_labels\` (\`issue_id\`, \`label_id\`) VALUES (${issueId}, ${labelId})`
      : sql`INSERT INTO "issue_labels" ("issue_id", "label_id") VALUES (${issueId}, ${labelId}) ON CONFLICT DO NOTHING`;
  }

  private detachLabelSql(issueId: number, labelId: number) {
    return this.em.getDriver().isMySqlFamily()
      ? sql`DELETE FROM \`issue_labels\` WHERE \`issue_id\` = ${issueId} AND \`label_id\` = ${labelId}`
      : sql`DELETE FROM "issue_labels" WHERE "issue_id" = ${issueId} AND "label_id" = ${labelId}`;
  }

  childrenOf(issueId: number): Promise<Issue[]> {
    const i = qAlias(Issue, "i");
    return this.em
      .createQueryBuilder(i)
      .where(i.parentId.eq(issueId))
      .getMany();
  }

  private async workspaceIdForProject(projectId: number): Promise<number | null> {
    const project = await this.projects.findOne(projectId);
    return project.workspaceId ?? null;
  }
}

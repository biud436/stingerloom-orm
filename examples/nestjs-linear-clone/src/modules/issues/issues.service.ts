import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  CursorPaginationResult,
  qAlias,
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
import { WorkflowsService } from "../workflows/workflows.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import { Membership } from "../memberships/membership.entity";
import { applyPatch, pickDefined } from "../../common/dto-helpers";
import {
  ACTIVITY_ACTION,
  ISSUE_STATUS,
  IssueStatus,
  MembershipRole,
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
    @Inject(forwardRef(() => WorkflowsService))
    private readonly workflows: WorkflowsService,
    @Inject(forwardRef(() => WebhooksService))
    private readonly webhooks: WebhooksService,
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
    const workspaceId = await this.workspaceIdForProject(saved.projectId!);

    await this.activity.log({
      issueId: saved.id,
      workspaceId,
      actorUserId,
      action: ACTIVITY_ACTION.ISSUE_CREATED,
      payload: {
        title: saved.title,
        status: saved.status,
        priority: saved.priority,
      },
    });

    if (workspaceId != null) {
      await this.webhooks.emit(workspaceId, "issue.created", {
        id: saved.id,
        projectId: saved.projectId,
        number: saved.number,
        title: saved.title,
        status: saved.status,
        priority: saved.priority,
        reporterId: saved.reporterId ?? null,
        assigneeId: saved.assigneeId ?? null,
      });
    }

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
    // actorUserId drives the workflow role lookup below; IssueAuditSubscriber separately reads it from RequestContext.
    const before = await this.findOne(id);

    // Drive `@Version` from the caller's expected version. If a concurrent
    // writer has bumped the row, repo.save() will throw OptimisticLockError.
    // The controller guarantees expectedVersion is set (from body or
    // If-Match), so the `?? before.version` fallback only runs in legacy
    // direct-service callers.
    before.version = dto.expectedVersion ?? before.version;

    const previousStatus = before.status as IssueStatus;
    applyPatch(before, pickDefined(dto, PATCHABLE_KEYS) as Partial<Issue>);

    // Workflow gate. The patched `before` is passed so requiredFields reads the would-be state.
    if (dto.status && dto.status !== previousStatus && before.projectId != null) {
      const role = await this.lookupActorRole(before.projectId, actorUserId);
      await this.workflows.assertTransition(
        before.projectId,
        previousStatus,
        dto.status,
        role,
        before as unknown as Record<string, unknown>,
      );
    }

    if (
      dto.status &&
      TERMINAL_STATUSES.includes(dto.status) &&
      !TERMINAL_STATUSES.includes(previousStatus)
    ) {
      before.completedAt = new Date();
    }

    const saved = await this.repo.save(before);

    // Webhook fan-out happens INSIDE this @Transactional frame so the
    // outbox row commits atomically with the issue update — if the UPDATE
    // rolls back (optimistic-lock conflict, etc.) no event is ever emitted.
    if (saved.projectId != null) {
      const workspaceId = await this.workspaceIdForProject(saved.projectId);
      if (workspaceId != null) {
        await this.webhooks.emit(workspaceId, "issue.updated", {
          id: saved.id,
          projectId: saved.projectId,
          number: saved.number,
          title: saved.title,
          status: saved.status,
          priority: saved.priority,
          assigneeId: saved.assigneeId ?? null,
          version: saved.version,
        });
      }
    }

    return saved;
  }

  // Look up the actor's role on the project's workspace; null when no membership (any role-gated transition fails).
  private async lookupActorRole(
    projectId: number,
    actorUserId: number,
  ): Promise<MembershipRole | null> {
    const project = await this.projects.findOne(projectId);
    if (project.workspaceId == null) return null;
    const m = qAlias(Membership, "m");
    const row = await this.em
      .createQueryBuilder(m)
      .where(m.workspaceId.eq(project.workspaceId))
      .andWhere(m.userId.eq(actorUserId))
      .limit(1)
      .getOne();
    return (row?.role as MembershipRole | undefined) ?? null;
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
    const I = this.em.ref(Issue);

    const descendants = await this.em.query<{ id: number }>(sql`
      WITH RECURSIVE deleted_tree(${I.id}) AS (
        SELECT ${I.id} FROM ${I}
          WHERE ${I.id} = ${id} AND ${I.deletedAt} IS NOT NULL
        UNION ALL
        SELECT c.${I.id} FROM ${I} c
          INNER JOIN deleted_tree p ON c.${I.parentId} = p.${I.id}
          WHERE c.${I.deletedAt} IS NOT NULL
      )
      SELECT ${I.id} FROM deleted_tree
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
      UPDATE ${I}
         SET ${I.deletedAt} = NULL
       WHERE ${I.id} IN (${idList})
    `);
    return { restored: idsToRestore.length, ids: idsToRestore };
  }

  /**
   * M2M join-table I/O. Uses the dialect-portable `repo.relation()` helper
   * so the call site stays the same on MySQL/MariaDB and PostgreSQL —
   * the ORM picks `INSERT IGNORE` vs `ON CONFLICT DO NOTHING` internally.
   */
  @Transactional()
  async addLabel(
    issueId: number,
    dto: AssignLabelDto,
    actorUserId: number,
  ): Promise<{ message: string }> {
    await this.findOne(issueId);
    await this.repo.relation(issueId, "labels").add(dto.labelId);
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
    await this.repo.relation(issueId, "labels").remove(labelId);
    await this.activity.log({
      issueId,
      actorUserId,
      action: ACTIVITY_ACTION.LABEL_REMOVED,
      payload: { labelId },
    });
    return { message: `Label ${labelId} removed from issue ${issueId}` };
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

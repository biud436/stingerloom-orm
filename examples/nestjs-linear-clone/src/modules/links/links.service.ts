import {
  Injectable,
  Inject,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  RawQueryBuilder,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { IssueLink, IssueLinkType } from "./link.entity";
import { Issue } from "../issues/issue.entity";
import { Project } from "../projects/project.entity";
import { CreateLinkDto, IssueLinkRow } from "./dto/link.dto";
import { detectDialect, dsl } from "../analytics/sql-helpers";

/**
 * Canonicalize a (sourceId, targetId, type) triplet so that `blockedBy`
 * is stored as the inverse `blocks` edge. Keeps the dependency DAG in a
 * single direction so the cycle-detection walk is unambiguous.
 */
function canonicalize(
  sourceId: number,
  targetId: number,
  type: IssueLinkType,
): { source: number; target: number; type: IssueLinkType } {
  if (type === "blockedBy") {
    return { source: targetId, target: sourceId, type: "blocks" };
  }
  return { source: sourceId, target: targetId, type };
}

@Injectable()
export class LinksService {
  constructor(
    @InjectRepository(IssueLink)
    private readonly repo: BaseRepository<IssueLink>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Transactional()
  async create(
    sourceIssueId: number,
    dto: CreateLinkDto,
    actorUserId: number,
  ): Promise<IssueLink> {
    const { targetId, type } = dto;

    if (sourceIssueId === targetId) {
      throw new HttpException(
        { code: "CYCLE_DETECTED", message: "Self-loop is not allowed" },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Cross-tenant guard. The controller's `@WorkspaceScoped({ from: "issue" })`
    // resolves the workspace from the SOURCE issue (`:id`) only and never
    // inspects the body's `targetId` (validated as a bare positive int). Without
    // this check a member of workspace A could link their own issue to an
    // arbitrary issue id in workspace B, then read that foreign issue's
    // number/title/status back through the (workspace-unscoped) dependents /
    // blockers closure walk — a cross-tenant read primitive. Require both
    // endpoints to live in the SAME workspace; since the actor is already a
    // proven member of the source's workspace, equality transitively grants
    // membership of the target's. A foreign — or missing — target is reported
    // as 404 so we never disclose its existence (mirrors the bulk route's
    // "treat cross-tenant as not_found" stance, #355).
    const sourceWorkspaceId = await this.workspaceIdForIssue(sourceIssueId);
    const targetWorkspaceId = await this.workspaceIdForIssue(targetId);
    if (
      sourceWorkspaceId == null ||
      targetWorkspaceId == null ||
      sourceWorkspaceId !== targetWorkspaceId
    ) {
      throw new NotFoundException(`Issue ${targetId} not found`);
    }

    const canon = canonicalize(sourceIssueId, targetId, type);

    if (canon.type === "blocks") {
      const wouldCycle = await this.wouldCreateCycle(canon.source, canon.target);
      if (wouldCycle) {
        throw new HttpException(
          {
            code: "CYCLE_DETECTED",
            message: `Adding ${canon.source} blocks ${canon.target} would close a cycle`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    const link = new IssueLink();
    link.sourceIssueId = canon.source;
    link.targetIssueId = canon.target;
    link.type = canon.type;
    link.createdBy = actorUserId;
    return this.repo.save(link);
  }

  /**
   * Resolve the workspace owning an issue via its project. Returns null when
   * the issue or its project no longer exists, which callers treat as
   * "not found / cross-tenant". `withDeleted` mirrors the membership guard's
   * `workspaceOfIssue` so a soft-deleted (but same-tenant) issue still resolves
   * to its workspace rather than silently flipping to a 404.
   */
  private async workspaceIdForIssue(issueId: number): Promise<number | null> {
    const issue = await this.em.findOne(Issue, {
      where: { id: issueId },
      withDeleted: true,
    });
    if (issue?.projectId == null) return null;
    const project = await this.em.findOne(Project, {
      where: { id: issue.projectId },
    });
    return project?.workspaceId ?? null;
  }

  /**
   * From `targetId`, walk forward across `blocks` edges. If the walk reaches
   * `sourceId`, inserting (sourceId blocks targetId) would close a cycle.
   */
  private async wouldCreateCycle(
    sourceId: number,
    targetId: number,
  ): Promise<boolean> {
    const D = dsl(detectDialect(this.em));
    const L = this.em.ref(IssueLink);
    const Lj = this.em.ref(IssueLink, "l");
    const r = this.em.aliasRef("r");

    const reachBody = sql`
      SELECT ${L.targetIssueId} AS id
      FROM ${L}
      WHERE ${L.sourceIssueId} = ${targetId}
        AND ${L.type} = ${"blocks"}
      UNION ALL
      SELECT ${Lj.targetIssueId}
      FROM ${Lj}
      INNER JOIN reach ${r} ON ${Lj.sourceIssueId} = ${r.id}
      WHERE ${Lj.type} = ${"blocks"}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("reach", reachBody)
      .build();

    const final = sql`
      ${built}
      SELECT id FROM reach WHERE id = ${sourceId} LIMIT 1
    `;

    const rows = await this.em.query<{ id: number }>(final);
    return rows.length > 0;
  }

  @Transactional()
  async remove(sourceIssueId: number, linkId: number): Promise<void> {
    const link = await this.repo.findOne({ where: { id: linkId } });
    if (!link) {
      throw new NotFoundException(`Link ${linkId} not found`);
    }
    // Match either canonical orientation (the stored row's source may be
    // the requester's `targetId` if the user originally posted `blockedBy`).
    if (
      link.sourceIssueId !== sourceIssueId &&
      link.targetIssueId !== sourceIssueId
    ) {
      throw new NotFoundException(
        `Link ${linkId} does not belong to issue ${sourceIssueId}`,
      );
    }
    await this.repo.delete({ id: linkId });
  }

  /**
   * Transitive closure of issues this issue blocks (forward walk on
   * `blocks` edges). Each row carries the BFS depth so callers can render
   * a tree or a flat depth-ordered list.
   */
  async dependents(sourceIssueId: number): Promise<IssueLinkRow[]> {
    return this.walk(sourceIssueId, "forward");
  }

  /**
   * Transitive closure of issues that block this issue (reverse walk on
   * `blocks` edges).
   */
  async blockers(targetIssueId: number): Promise<IssueLinkRow[]> {
    return this.walk(targetIssueId, "reverse");
  }

  // The closure walk joins the `issue` table with no workspace predicate, which
  // is safe ONLY because `create()` enforces that every `blocks` edge connects
  // two issues in the same workspace. The connected component reachable from
  // `startId` (an issue the caller is a proven member of, via the controller
  // guard) therefore stays entirely within that one workspace.
  private async walk(
    startId: number,
    direction: "forward" | "reverse",
  ): Promise<IssueLinkRow[]> {
    const D = dsl(detectDialect(this.em));
    const L = this.em.ref(IssueLink);
    const Lj = this.em.ref(IssueLink, "l");
    const I = this.em.ref(Issue, "i");
    const w = this.em.aliasRef("w");

    // Forward: source = current.id  → walk_to = target_issue_id
    // Reverse: target = current.id  → walk_to = source_issue_id
    const seedFromKey = direction === "forward" ? "sourceIssueId" : "targetIssueId";
    const seedToKey = direction === "forward" ? "targetIssueId" : "sourceIssueId";
    const stepJoinKey = direction === "forward" ? "sourceIssueId" : "targetIssueId";
    const stepProjectKey = direction === "forward" ? "targetIssueId" : "sourceIssueId";

    const walkBody = sql`
      SELECT ${L[seedToKey]} AS id, 1 AS depth
      FROM ${L}
      WHERE ${L[seedFromKey]} = ${startId}
        AND ${L.type} = ${"blocks"}
      UNION ALL
      SELECT ${Lj[stepProjectKey]}, ${w.depth} + 1
      FROM ${Lj}
      INNER JOIN walk ${w} ON ${Lj[stepJoinKey]} = ${w.id}
      WHERE ${Lj.type} = ${"blocks"}
        AND ${w.depth} < 64
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("walk", walkBody)
      .build();

    // Collapse duplicate paths (a node reachable via multiple chains) by
    // keeping the shortest depth, then join the issue table for display data.
    const m = this.em.aliasRef("m");
    const final = sql`
      ${built}
      SELECT
        ${I.id}           AS id,
        ${I.number}       AS ${D.Q("number")},
        ${I.title}        AS title,
        ${I.status}       AS status,
        ${m.minDepth}     AS depth
      FROM (
        SELECT id, MIN(depth) AS min_depth
        FROM walk
        GROUP BY id
      ) ${m}
      INNER JOIN ${I} ON ${I.id} = ${m.id}
      WHERE ${I.deletedAt} IS NULL
      ORDER BY ${m.minDepth} ASC, ${I.id} ASC
    `;

    const rows = await this.em.query<Record<string, unknown>>(final);
    return rows.map((row) => ({
      id: Number(row.id),
      number: Number(row.number),
      title: String(row.title),
      status: String(row.status),
      depth: Number(row.depth),
    }));
  }
}

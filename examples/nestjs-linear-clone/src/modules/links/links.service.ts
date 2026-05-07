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
   * From `targetId`, walk forward across `blocks` edges. If the walk reaches
   * `sourceId`, inserting (sourceId blocks targetId) would close a cycle.
   */
  private async wouldCreateCycle(
    sourceId: number,
    targetId: number,
  ): Promise<boolean> {
    const D = dsl(detectDialect(this.em));
    const { Q } = D;

    const reachBody = sql`
      SELECT ${Q("target_issue_id")} AS id
      FROM ${Q("issue_link")}
      WHERE ${Q("source_issue_id")} = ${targetId}
        AND ${Q("type")} = ${"blocks"}
      UNION ALL
      SELECT l.${Q("target_issue_id")}
      FROM ${Q("issue_link")} l
      INNER JOIN reach r ON l.${Q("source_issue_id")} = r.id
      WHERE l.${Q("type")} = ${"blocks"}
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

  private async walk(
    startId: number,
    direction: "forward" | "reverse",
  ): Promise<IssueLinkRow[]> {
    const D = dsl(detectDialect(this.em));
    const { Q } = D;

    // Forward: source = current.id  → walk_to = target_issue_id
    // Reverse: target = current.id  → walk_to = source_issue_id
    const seedFromCol = direction === "forward" ? "source_issue_id" : "target_issue_id";
    const seedToCol = direction === "forward" ? "target_issue_id" : "source_issue_id";
    const stepJoinCol = direction === "forward" ? "source_issue_id" : "target_issue_id";
    const stepProjectCol = direction === "forward" ? "target_issue_id" : "source_issue_id";

    const walkBody = sql`
      SELECT ${Q(seedToCol)} AS id, 1 AS depth
      FROM ${Q("issue_link")}
      WHERE ${Q(seedFromCol)} = ${startId}
        AND ${Q("type")} = ${"blocks"}
      UNION ALL
      SELECT l.${Q(stepProjectCol)}, w.depth + 1
      FROM ${Q("issue_link")} l
      INNER JOIN walk w ON l.${Q(stepJoinCol)} = w.id
      WHERE l.${Q("type")} = ${"blocks"}
        AND w.depth < 64
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("walk", walkBody)
      .build();

    // Collapse duplicate paths (a node reachable via multiple chains) by
    // keeping the shortest depth, then join the issue table for display data.
    const final = sql`
      ${built}
      SELECT
        i.${Q("id")}      AS id,
        i.${Q("number")}  AS ${Q("number")},
        i.${Q("title")}   AS title,
        i.${Q("status")}  AS status,
        m.min_depth       AS depth
      FROM (
        SELECT id, MIN(depth) AS min_depth
        FROM walk
        GROUP BY id
      ) m
      INNER JOIN ${Q("issue")} i ON i.${Q("id")} = m.id
      WHERE i.${Q("deleted_at")} IS NULL
      ORDER BY m.min_depth ASC, i.${Q("id")} ASC
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

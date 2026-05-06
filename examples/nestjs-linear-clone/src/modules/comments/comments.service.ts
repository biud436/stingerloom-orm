import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  RawQueryBuilder,
  Transactional,
  qAlias,
  raw,
  sql,
  CursorPaginationResult,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Comment } from "./comment.entity";
import { Reaction } from "./reaction.entity";
import { CommentRevision } from "./comment-revision.entity";
import {
  CreateCommentDto,
  UpdateCommentDto,
  AddReactionDto,
} from "./dto/comment.dto";
import { ActivityService } from "../activity/activity.service";
import { ACTIVITY_ACTION } from "../../common/enums";
import { detectDialect, dsl } from "../analytics/sql-helpers";

export interface CommentThreadNode {
  id: number;
  parentCommentId: number | null;
  body: string;
  authorId: number | null;
  createdAt: string;
  depth: number;
  path: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  userIds: number[];
}

@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(Comment)
    private readonly repo: BaseRepository<Comment>,
    @InjectRepository(CommentRevision)
    private readonly revisionRepo: BaseRepository<CommentRevision>,
    @InjectRepository(Reaction)
    private readonly reactionRepo: BaseRepository<Reaction>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly activity: ActivityService,
  ) {}

  @Transactional()
  async create(dto: CreateCommentDto, actorUserId: number): Promise<Comment> {
    if (dto.parentCommentId !== undefined && dto.parentCommentId !== null) {
      const parent = await this.repo.findOne({
        where: { id: dto.parentCommentId },
      });
      if (!parent) {
        throw new NotFoundException(
          `Parent comment ${dto.parentCommentId} not found`,
        );
      }
      if (parent.issueId !== dto.issueId) {
        throw new NotFoundException(
          `Parent comment ${dto.parentCommentId} belongs to a different issue`,
        );
      }
    }

    const c = new Comment();
    c.issueId = dto.issueId;
    // Author is always the authenticated caller — DTO no longer carries it.
    c.authorId = actorUserId;
    c.body = dto.body;
    c.parentCommentId = dto.parentCommentId ?? null;
    const saved = await this.repo.save(c);

    await this.activity.log({
      issueId: dto.issueId,
      actorUserId,
      action: ACTIVITY_ACTION.COMMENTED,
      payload: {
        commentId: saved.id,
        parentCommentId: saved.parentCommentId ?? null,
      },
    });

    return saved;
  }

  findByIssue(issueId: number, limit = 100): Promise<Comment[]> {
    const c = qAlias(Comment, "c");
    return this.em
      .createQueryBuilder(c)
      .where(c.issueId.eq(issueId))
      .orderBy(c.createdAt.asc())
      .take(Math.min(limit, 200))
      .getMany();
  }

  /**
   * Cursor pagination over an issue's comments. Stable across edits because
   * `id` is monotonically increasing — even if a comment body is updated, its
   * place in the cursor walk does not move.
   */
  findByIssueCursor(
    issueId: number,
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<Comment>> {
    return this.repo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "ASC",
      where: { issueId },
    });
  }

  async findOne(id: number): Promise<Comment> {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) {
      throw new NotFoundException(`Comment ${id} not found`);
    }

    return c;
  }

  /**
   * Recursive CTE walk down `parent_comment_id` from the given root comment.
   * Returns a flat depth-first list ordered by `path` so the UI can render
   * the entire thread without further sorting. Depth is hard-capped to keep
   * pathological recursion bounded.
   */
  async thread(rootId: number, maxDepth = 10): Promise<CommentThreadNode[]> {
    // Surface 404 ahead of the CTE so a missing root never returns an empty
    // thread that callers might mis-read as "no replies".
    await this.findOne(rootId);

    const D = dsl(detectDialect(this.em));
    const { Q, tbl } = D;
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
        ${r.as("parent_comment_id", "parentCommentId")},
        ${r.as("body")},
        ${r.as("author_id", "authorId")},
        ${r.as("createdAt")},
        0 AS ${Q("depth")},
        CAST(${r.id} AS ${raw(castText)}) AS ${Q("path")}
      FROM ${Q("comment")} r
      WHERE ${r.id} = ${rootId}
        AND ${r.deletedAt} IS NULL
      UNION ALL
      SELECT
        ${c.id},
        ${c.parent_comment_id},
        ${c.body},
        ${c.author_id},
        ${c.createdAt},
        ${t.depth} + 1,
        ${childPath}
      FROM ${Q("comment")} c
      INNER JOIN comment_thread t ON ${c.parent_comment_id} = ${t.id}
      WHERE ${c.deletedAt} IS NULL
        AND ${t.depth} < ${maxDepth}
    `;

    const built = RawQueryBuilder.create()
      .setDatabaseType(D.dialect === "postgres" ? "postgresql" : "mysql")
      .withRecursive("comment_thread", treeBody)
      .select("*")
      .from("comment_thread")
      .orderBy([{ column: D.q("path"), direction: "ASC" }])
      .build();

    const rows = await this.em.query<Record<string, unknown>>(built);
    return rows.map((row) => ({
      id: Number(row.id),
      parentCommentId:
        row.parentCommentId === null || row.parentCommentId === undefined
          ? null
          : Number(row.parentCommentId),
      body: String(row.body),
      authorId:
        row.authorId === null || row.authorId === undefined
          ? null
          : Number(row.authorId),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      depth: Number(row.depth),
      path: String(row.path),
    }));
  }

  /**
   * Edit-with-history. The pre-edit body is snapshotted into
   * `comment_revision` *before* the UPDATE so the revisions feed reads as
   * "what was replaced", with the live body always on the comment row.
   * Wrapped in a single transaction so an UPDATE failure rolls the
   * snapshot back too.
   */
  @Transactional()
  async update(
    id: number,
    dto: UpdateCommentDto,
    editorUserId: number,
  ): Promise<Comment> {
    const c = await this.findOne(id);

    const revision = new CommentRevision();
    revision.commentId = c.id;
    revision.body = c.body;
    revision.editorId = editorUserId;
    revision.editedAt = new Date();
    await this.revisionRepo.save(revision);

    c.body = dto.body;
    return this.repo.save(c);
  }

  async revisions(id: number): Promise<CommentRevision[]> {
    await this.findOne(id);
    const r = qAlias(CommentRevision, "r");
    return this.em
      .createQueryBuilder(r)
      .where(r.commentId.eq(id))
      .orderBy(r.editedAt.asc())
      .addOrderBy(r.id.asc())
      .getMany();
  }

  /**
   * Idempotent reaction insert. The composite PK (commentId, userId, emoji)
   * absorbs duplicates — `repo.insertIgnore()` picks `INSERT IGNORE`
   * (MySQL/MariaDB) vs `ON CONFLICT DO NOTHING` (PostgreSQL/SQLite)
   * internally so the call site stays portable.
   */
  @Transactional()
  async addReaction(
    commentId: number,
    dto: AddReactionDto,
    userId: number,
  ): Promise<{ message: string }> {
    await this.findOne(commentId);
    await this.reactionRepo.insertIgnore({
      commentId,
      userId,
      emoji: dto.emoji,
      createdAt: new Date(),
    });
    return {
      message: `Reaction ${dto.emoji} added to comment ${commentId}`,
    };
  }

  @Transactional()
  async removeReaction(
    commentId: number,
    emoji: string,
    userId: number,
  ): Promise<void> {
    await this.findOne(commentId);
    await this.reactionRepo.delete({ commentId, userId, emoji });
  }

  /**
   * Aggregate by emoji with the contributing userIds. Done in one round-trip
   * via `array_agg` (PG) / `JSON_ARRAYAGG` (MySQL) so the controller doesn't
   * have to fan out N queries for N emojis.
   */
  async listReactions(commentId: number): Promise<ReactionSummary[]> {
    await this.findOne(commentId);
    const dialect = detectDialect(this.em);

    const rows =
      dialect === "postgres"
        ? await this.em.query<{
            emoji: string;
            count: number | string;
            user_ids: number[] | string;
          }>(sql`
            SELECT
              "emoji"        AS "emoji",
              COUNT(*)       AS "count",
              array_agg("user_id" ORDER BY "user_id") AS "user_ids"
            FROM "reaction"
            WHERE "comment_id" = ${commentId}
            GROUP BY "emoji"
            ORDER BY COUNT(*) DESC, "emoji" ASC
          `)
        : await this.em.query<{
            emoji: string;
            count: number | string;
            user_ids: string | number[] | null;
          }>(sql`
            SELECT
              \`emoji\`              AS \`emoji\`,
              COUNT(*)               AS \`count\`,
              JSON_ARRAYAGG(\`user_id\`) AS \`user_ids\`
            FROM \`reaction\`
            WHERE \`comment_id\` = ${commentId}
            GROUP BY \`emoji\`
            ORDER BY COUNT(*) DESC, \`emoji\` ASC
          `);

    return rows.map((row) => ({
      emoji: String(row.emoji),
      count: Number(row.count),
      userIds: this.normalizeUserIds(row.user_ids),
    }));
  }

  @Transactional()
  async softRemove(id: number): Promise<void> {
    const result = await this.repo.softDelete({ id });
    if (result.affected === 0) {
      throw new NotFoundException(`Comment ${id} not found`);
    }
  }

  // ── helpers ─────────────────────────────────────────────────

  private normalizeUserIds(value: unknown): number[] {
    if (value === null || value === undefined) return [];
    // PG returns a real array; MySQL JSON_ARRAYAGG returns either a parsed
    // array (mysql2 `dateStrings: false` path) or a JSON-encoded string.
    if (Array.isArray(value)) {
      return value
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown[];
        return parsed
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
      } catch {
        return [];
      }
    }
    return [];
  }
}

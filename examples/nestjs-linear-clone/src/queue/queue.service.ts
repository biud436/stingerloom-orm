import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import {
  EntityManager,
  Transactional,
  sql,
  raw,
} from "@stingerloom/orm";
import { Issue } from "../issues/issue.entity";
import { ActivityService } from "../activity/activity.service";
import { ACTIVITY_ACTION, ISSUE_STATUS } from "../common/enums";

export interface ClaimedIssue {
  id: number;
  number: number;
  title: string;
  priority: number;
  claimedBy: string;
  claimedAt: Date;
}

const LEASE_MINUTES = 5;

/**
 * Worker queue backed by a single `issue` table.
 *
 * The "next claimable" pick is dialect-aware:
 *
 * - PostgreSQL — `SelectQueryBuilder.forUpdateSkipLocked()` followed by an
 *   in-place UPDATE. SKIP LOCKED behaves consistently here.
 * - MariaDB / MySQL — `UPDATE … ORDER BY priority, number LIMIT 1` is
 *   atomic on InnoDB; a per-call sentinel is written into `claimedBy`
 *   first and read back to identify the row. We tried `SELECT FOR UPDATE
 *   SKIP LOCKED LIMIT 1` first and observed empty results under
 *   contention on MariaDB 11.x's filesort path, so the sentinel pattern
 *   is the portable workaround. (See README "Concurrency demo" for the
 *   live test that exercises this.)
 */
@Injectable()
export class QueueService {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
    private readonly activity: ActivityService,
  ) {}

  @Transactional()
  async claimNext(
    workerId: string,
    projectId: number,
  ): Promise<ClaimedIssue | null> {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(workerId)) {
      throw new BadRequestException("workerId must be 1-64 chars [a-zA-Z0-9-]");
    }

    const candidateId = this.isPostgres()
      ? await this.lockNextPostgres(projectId)
      : await this.lockNextMysql(workerId, projectId);
    if (candidateId === null) return null;

    const claimed = await this.markClaimed(candidateId, workerId);
    if (!claimed) return null;

    await this.activity.log({
      issueId: candidateId,
      action: ACTIVITY_ACTION.CLAIMED,
      payload: { workerId },
    });
    return claimed;
  }

  @Transactional()
  async release(workerId: string, issueId: number): Promise<boolean> {
    const result = await this.em.updateMany(
      Issue,
      { claimedBy: null, claimedAt: null } as any,
      { where: { id: issueId, claimedBy: workerId } as any },
    );
    if (result.affected > 0) {
      await this.activity.log({
        issueId,
        action: ACTIVITY_ACTION.RELEASED,
        payload: { workerId },
      });
    }
    return result.affected > 0;
  }

  /**
   * Operational stat counters per project. Conditional aggregates require
   * dialect-specific date math AND multiple parameter bindings in a single
   * SELECT list; SelectQueryBuilder's addSelect path does not currently
   * thread bindings cleanly across multiple `${...}` fragments, so we use
   * `em.query(sql\`…\`)` directly for this one read-only summary.
   */
  async stats(projectId: number): Promise<{
    backlog: number;
    todo: number;
    activelyClaimed: number;
    expiredClaim: number;
  }> {
    const cutoff = this.leaseCutoffSql();
    const isPg = this.isPostgres();
    const wrap = isPg
      ? (n: string) => `"${n}"`
      : (n: string) => `\`${n}\``;
    const issue = wrap("issue");
    const status = wrap("status");
    const claimedAt = wrap("claimedAt");
    const projectCol = wrap("project_id");
    const assigneeCol = wrap("assignee_id");
    const deletedAt = wrap("deletedAt");

    const rows = await this.em.query<Record<string, unknown>>(sql`
      SELECT
        SUM(CASE WHEN ${raw(status)} = ${ISSUE_STATUS.BACKLOG} THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN ${raw(status)} = ${ISSUE_STATUS.TODO}    THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN ${raw(claimedAt)} IS NOT NULL AND ${raw(claimedAt)} >= ${cutoff} THEN 1 ELSE 0 END) AS active_claim,
        SUM(CASE WHEN ${raw(claimedAt)} IS NOT NULL AND ${raw(claimedAt)} <  ${cutoff} THEN 1 ELSE 0 END) AS expired_claim
      FROM ${raw(issue)}
      WHERE ${raw(projectCol)} = ${projectId}
        AND ${raw(assigneeCol)} IS NULL
        AND ${raw(deletedAt)} IS NULL
    `);

    const r = (rows[0] ?? {}) as Record<string, unknown>;
    return {
      backlog: Number(r.backlog ?? 0),
      todo: Number(r.todo ?? 0),
      activelyClaimed: Number(r.active_claim ?? 0),
      expiredClaim: Number(r.expired_claim ?? 0),
    };
  }

  // ── internals ──────────────────────────────────────────

  private isPostgres(): boolean {
    return this.em
      .getDriver()
      .constructor.name.toLowerCase()
      .includes("postgres");
  }

  /**
   * Quote-aware column reference. Translates `i.status` → `\`i\`.\`status\``
   * (MySQL) or `"i"."status"` (PostgreSQL).
   */
  private col(ref: string): string {
    const isPg = this.isPostgres();
    const quote = (s: string) => (isPg ? `"${s}"` : `\`${s}\``);
    return ref
      .split(".")
      .map((p) => quote(p))
      .join(".");
  }

  private leaseCutoffSql() {
    return this.isPostgres()
      ? sql`(NOW() - INTERVAL '${raw(String(LEASE_MINUTES))} minutes')`
      : sql`DATE_SUB(NOW(), INTERVAL ${LEASE_MINUTES} MINUTE)`;
  }

  /** PostgreSQL claim — SelectQueryBuilder + FOR UPDATE SKIP LOCKED. */
  private async lockNextPostgres(projectId: number): Promise<number | null> {
    const cutoff = this.leaseCutoffSql();

    const candidate = await this.em
      .createQueryBuilder(Issue, "i")
      .where("i.project_id", projectId)
      .andWhere(
        sql`${raw(this.col("i.status"))} IN (${ISSUE_STATUS.BACKLOG}, ${ISSUE_STATUS.TODO})`,
      )
      .andWhere("i.assignee_id", null)
      .andWhere(
        sql`(${raw(this.col("i.claimedAt"))} IS NULL OR ${raw(this.col("i.claimedAt"))} < ${cutoff})`,
      )
      .andWhere("i.deletedAt", null)
      .orderBy({ priority: "ASC" } as any)
      .addOrderBy("number", "ASC")
      .limit(1)
      .forUpdateSkipLocked()
      .getOne();

    return candidate?.id ?? null;
  }

  /**
   * MariaDB/MySQL claim — atomic UPDATE with sentinel tag, then SELECT to
   * recover the row id. The sentinel survives only for the duration of
   * `claimNext` (we immediately overwrite it with the real workerId in
   * `markClaimed`).
   */
  private async lockNextMysql(
    workerId: string,
    projectId: number,
  ): Promise<number | null> {
    const sentinel = `__pending:${workerId}:${Date.now()}-${Math.floor(
      Math.random() * 1e9,
    )}`;
    const cutoff = this.leaseCutoffSql();

    const result = await this.em.query(
      sql`UPDATE \`issue\`
             SET \`claimedBy\` = ${sentinel}, \`claimedAt\` = NOW()
           WHERE \`project_id\` = ${projectId}
             AND \`status\` IN (${ISSUE_STATUS.BACKLOG}, ${ISSUE_STATUS.TODO})
             AND \`assignee_id\` IS NULL
             AND (\`claimedBy\` IS NULL OR \`claimedAt\` < ${cutoff})
             AND \`deletedAt\` IS NULL
        ORDER BY \`priority\` ASC, \`number\` ASC
           LIMIT 1`,
    );
    const affected =
      (result as unknown as { affectedRows?: number }).affectedRows ?? 0;
    if (affected === 0) return null;

    const tagged = await this.em
      .createQueryBuilder(Issue, "i")
      .where("i.claimedBy", sentinel)
      .limit(1)
      .getOne();
    return tagged?.id ?? null;
  }

  /**
   * Stamp the row with the real workerId, refresh `claimedAt` to NOW, and
   * read back the projection used by ClaimedIssue. Combines an UPDATE and
   * a SELECT in the same transaction.
   */
  private async markClaimed(
    issueId: number,
    workerId: string,
  ): Promise<ClaimedIssue | null> {
    const updated = await this.em.updateMany(
      Issue,
      { claimedBy: workerId, claimedAt: new Date() } as any,
      { where: { id: issueId } as any },
    );
    if (updated.affected === 0) return null;

    const row = await this.em
      .createQueryBuilder(Issue, "i")
      .where("i.id", issueId)
      .getOne();
    if (!row) return null;

    return {
      id: row.id,
      number: row.number,
      title: row.title,
      priority: row.priority,
      claimedBy: row.claimedBy as string,
      claimedAt: row.claimedAt as Date,
    };
  }
}

import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Expressions as exp,
  Transactional,
  qAlias,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Issue } from "../issues/issue.entity";
import { ActivityService } from "../activity/activity.service";
import { ACTIVITY_ACTION, ISSUE_STATUS } from "../../common/enums";

export interface ClaimedIssue {
  id: number;
  number: number;
  title: string;
  priority: number;
  claimedBy: string;
  claimedAt: Date;
}

const LEASE_MINUTES = 5;
/** A sentinel rolls forward fast — it only exists during the few ms between
 *  `lockNextMysql` and `markClaimed`. If a worker crashes mid-flight, this
 *  is how long the row stays parked before another worker can pick it up. */
const SENTINEL_TIMEOUT_SECONDS = 30;
const SENTINEL_PREFIX = "__pending:";

/**
 * Worker queue backed by a single `issue` table.
 *
 * The "next claimable" pick is dialect-aware:
 *
 * - PostgreSQL — `SelectQueryBuilder.forUpdateSkipLocked()` followed by an
 *   in-place UPDATE. SKIP LOCKED behaves consistently here.
 * - MariaDB / MySQL — `UPDATE … ORDER BY priority, number LIMIT 1` via
 *   `createUpdateBuilder()`. A per-call sentinel is written into `claimedBy`
 *   first, then read back to identify the chosen row. `SELECT FOR UPDATE
 *   SKIP LOCKED LIMIT 1` was tried first and returned empty under
 *   contention on MariaDB 11.x's filesort path, so the sentinel pattern
 *   is the portable workaround. (See README "Concurrency demo" for the
 *   live test that exercises this.)
 *
 * Entity-scoped queries flow through the repository (`this.repo`); the
 * `EntityManager` is kept on the side only for the global dialect probe
 * (`em.getDriver().isMySqlFamily()`) used to branch claim strategy.
 */
@Injectable()
export class QueueService {
  constructor(
    @InjectRepository(Issue)
    private readonly repo: BaseRepository<Issue>,
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

    const candidateId = this.em.getDriver().isMySqlFamily()
      ? await this.lockNextMysql(workerId, projectId)
      : await this.lockNextPostgres(projectId);
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
    const result = await this.repo.updateMany(
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
   * Operational stat counters per project. Each number is its own typed
   * `getCount()` over the same `qAlias(Issue)` predicate set — four small
   * queries running in parallel are cheaper to read than one `SUM(CASE
   * WHEN …)` and stay portable across dialects without dipping into raw
   * SQL.
   */
  async stats(projectId: number): Promise<{
    backlog: number;
    todo: number;
    activelyClaimed: number;
    expiredClaim: number;
  }> {
    const i = qAlias(Issue, "i");
    const cutoff = exp.currentTimestamp().addMinutes(-LEASE_MINUTES);

    const baseFilter = () =>
      this.repo
        .createQueryBuilder(i)
        .where(i.projectId.eq(projectId))
        .andWhere(i.assigneeId.isNull());

    const [backlog, todo, activelyClaimed, expiredClaim] = await Promise.all([
      baseFilter().andWhere(i.status.eq(ISSUE_STATUS.BACKLOG)).getCount(),
      baseFilter().andWhere(i.status.eq(ISSUE_STATUS.TODO)).getCount(),
      baseFilter()
        .andWhere(i.claimedAt.isNotNull())
        .andWhere(i.claimedAt.gte(cutoff))
        .getCount(),
      baseFilter()
        .andWhere(i.claimedAt.isNotNull())
        .andWhere(i.claimedAt.lt(cutoff))
        .getCount(),
    ]);

    return { backlog, todo, activelyClaimed, expiredClaim };
  }

  // ── internals ──────────────────────────────────────────

  /** PostgreSQL claim — SelectQueryBuilder + FOR UPDATE SKIP LOCKED. */
  private async lockNextPostgres(projectId: number): Promise<number | null> {
    const i = qAlias(Issue, "i");
    const cutoff = exp.currentTimestamp().addMinutes(-LEASE_MINUTES);

    const candidate = await this.repo
      .createQueryBuilder(i)
      .where(i.projectId.eq(projectId))
      .andWhere(i.status.in([ISSUE_STATUS.BACKLOG, ISSUE_STATUS.TODO]))
      .andWhere(i.assigneeId.isNull())
      .andWhere(exp.or(i.claimedAt.isNull(), i.claimedAt.lt(cutoff)))
      .andWhere(i.deletedAt.isNull())
      .orderBy(i.priority.asc())
      .addOrderBy(i.number.asc())
      .limit(1)
      .forUpdateSkipLocked()
      .getOne();

    return candidate?.id ?? null;
  }

  /**
   * MariaDB/MySQL claim — atomic UPDATE with sentinel tag, then a typed
   * read-back to recover the row id. Uses the dialect-aware
   * `createUpdateBuilder()` which emits native `UPDATE … ORDER BY … LIMIT n`
   * on MySQL/MariaDB.
   *
   * Crash-recovery clause: `claimedBy LIKE '__pending:%' AND claimedAt < cutoff`
   * also reclaims sentinel rows whose worker crashed between
   * `lockNextMysql` and `markClaimed`. Without it, a crashed worker would
   * permanently park a row under its sentinel tag because the lease cutoff
   * only matches *real* claims.
   */
  private async lockNextMysql(
    workerId: string,
    projectId: number,
  ): Promise<number | null> {
    const sentinel = `${SENTINEL_PREFIX}${workerId}:${Date.now()}-${Math.floor(
      Math.random() * 1e9,
    )}`;
    const leaseCutoff = exp.currentTimestamp().addMinutes(-LEASE_MINUTES);
    const sentinelCutoff = exp
      .currentTimestamp()
      .addSeconds(-SENTINEL_TIMEOUT_SECONDS);
    const i = qAlias(Issue, "i");

    // Eligible rows: never claimed, OR a real claim whose lease expired,
    // OR a sentinel from a worker that crashed before promoting it (these
    // get a much shorter timeout — see SENTINEL_TIMEOUT_SECONDS).
    const { affected } = await this.repo
      .createUpdateBuilder(i)
      .set({ claimedBy: sentinel })
      .setRaw("claimedAt", sql`NOW()`)
      .where(i.projectId.eq(projectId))
      .andWhere(i.status.in([ISSUE_STATUS.BACKLOG, ISSUE_STATUS.TODO]))
      .andWhere(i.assigneeId.isNull())
      .andWhere(
        exp.or(
          i.claimedBy.isNull(),
          exp.and(
            i.claimedBy.like(`${SENTINEL_PREFIX}%`),
            i.claimedAt.lt(sentinelCutoff),
          ),
          exp.and(
            i.claimedBy.notLike(`${SENTINEL_PREFIX}%`),
            i.claimedAt.lt(leaseCutoff),
          ),
        ),
      )
      .andWhere(i.deletedAt.isNull())
      .orderBy(i.priority.asc())
      .addOrderBy(i.number.asc())
      .limit(1)
      .execute();
    if (affected === 0) return null;

    const tagged = await this.repo
      .createQueryBuilder(i)
      .where(i.claimedBy.eq(sentinel))
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
    const updated = await this.repo.updateMany(
      { claimedBy: workerId, claimedAt: new Date() } as any,
      { where: { id: issueId } as any },
    );
    if (updated.affected === 0) return null;

    const i = qAlias(Issue, "i");
    const row = await this.repo
      .createQueryBuilder(i)
      .where(i.id.eq(issueId))
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

import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import {
  BaseRepository,
  EntityManager,
  Transactional,
  CursorPaginationResult,
  qAlias,
  sql,
} from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Notification, NotificationKind } from "./notification.entity";
import { IssueWatcher } from "./issue-watcher.entity";

export interface EmitInput {
  userId: number;
  sourceIssueId: number;
  kind: NotificationKind;
  payload?: Record<string, unknown> | null;
}

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifRepo: BaseRepository<Notification>,
    @InjectRepository(IssueWatcher)
    private readonly watcherRepo: BaseRepository<IssueWatcher>,
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  // ── Watchers ────────────────────────────────────────────────

  @Transactional()
  async watch(issueId: number, userId: number): Promise<IssueWatcher> {
    const existing = await this.watcherRepo.findOne({
      where: { issueId, userId },
    });
    if (existing) return existing;
    const w = new IssueWatcher();
    w.issueId = issueId;
    w.userId = userId;
    return this.watcherRepo.save(w);
  }

  @Transactional()
  async unwatch(issueId: number, userId: number): Promise<void> {
    const w = qAlias(IssueWatcher, "w");
    const row = await this.em
      .createQueryBuilder(w)
      .where(w.issueId.eq(issueId))
      .andWhere(w.userId.eq(userId))
      .limit(1)
      .getOne();
    if (!row) return;
    await this.em.delete(IssueWatcher, { id: row.id });
  }

  watchersFor(issueId: number): Promise<IssueWatcher[]> {
    const w = qAlias(IssueWatcher, "w");
    return this.em
      .createQueryBuilder(w)
      .where(w.issueId.eq(issueId))
      .orderBy(w.id.asc())
      .getMany();
  }

  // ── Inbox / read state ──────────────────────────────────────

  inbox(
    userId: number,
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<Notification>> {
    return this.notifRepo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "DESC",
      where: { userId },
    });
  }

  unreadCount(userId: number): Promise<number> {
    const n = qAlias(Notification, "n");
    return this.em
      .createQueryBuilder(n)
      .where(n.userId.eq(userId))
      .andWhere(n.readAt.isNull())
      .getCount();
  }

  @Transactional()
  async markRead(id: number, userId: number): Promise<Notification> {
    const row = await this.notifRepo.findOne({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    if (row.readAt) return row;
    row.readAt = new Date();
    return this.notifRepo.save(row);
  }

  @Transactional()
  async markAllRead(userId: number): Promise<{ marked: number }> {
    // Bypass repo.updateMany() because @RelationColumn-derived FK shadow
    // accessors (`userId`) aren't visible in its property-to-column resolver
    // — the where clause throws "Unknown column userId". Use a raw UPDATE
    // until the ORM treats RelationColumn FKs as queryable columns.
    const N = this.em.ref(Notification);
    const result = await this.em.query<unknown>(sql`
      UPDATE ${N}
         SET ${N.readAt} = NOW()
       WHERE ${N.userId} = ${userId}
         AND ${N.readAt} IS NULL
    `);
    const marked =
      (result as { affectedRows?: number; rowCount?: number; affected?: number } | null)
        ?.affectedRows ??
      (result as { rowCount?: number } | null)?.rowCount ??
      0;
    return { marked };
  }

  // ── Emission (called by the EntitySubscriber) ───────────────

  /**
   * Insert N notification rows in one round-trip. Each input is silently
   * dropped when `userId === skipUserId` so callers don't have to filter
   * the actor out themselves.
   */
  async emitMany(
    inputs: EmitInput[],
    skipUserId?: number | null,
  ): Promise<void> {
    const toEmit = skipUserId == null
      ? inputs
      : inputs.filter((i) => i.userId !== skipUserId);
    if (toEmit.length === 0) return;
    for (const input of toEmit) {
      const n = new Notification();
      n.userId = input.userId;
      n.sourceIssueId = input.sourceIssueId;
      n.kind = input.kind;
      n.payload = input.payload ?? null;
      await this.notifRepo.save(n);
    }
  }
}

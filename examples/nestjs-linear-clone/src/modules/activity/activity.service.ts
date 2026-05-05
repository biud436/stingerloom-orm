import { Injectable } from "@nestjs/common";
import { BaseRepository, CursorPaginationResult } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { ActivityLog } from "./activity-log.entity";
import { ActivityAction } from "../../common/enums";

/**
 * Append-only audit log writer. The JSON `payload` column is handled by the
 * column transformer on the entity, so callers (and readers) deal in plain
 * objects — no manual `JSON.stringify` / `JSON.parse` here.
 */
@Injectable()
export class ActivityService {
  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: BaseRepository<ActivityLog>,
  ) {}

  async log(input: {
    issueId: number;
    workspaceId?: number | null;
    actorUserId?: number | null;
    action: ActivityAction;
    payload?: Record<string, unknown> | null;
  }): Promise<ActivityLog> {
    const row = new ActivityLog();
    row.issueId = input.issueId;
    row.workspaceId = input.workspaceId ?? null;
    row.actorUserId = input.actorUserId ?? null;
    row.action = input.action;
    row.payload = input.payload ?? null;
    return this.repo.save(row);
  }

  forIssue(issueId: number, limit = 50): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { issueId },
      orderBy: { createdAt: "DESC" },
      take: limit,
    });
  }

  forWorkspace(workspaceId: number, limit = 100): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { workspaceId },
      orderBy: { createdAt: "DESC" },
      take: limit,
    });
  }

  forActor(actorUserId: number, limit = 100): Promise<ActivityLog[]> {
    return this.repo.find({
      where: { actorUserId },
      orderBy: { createdAt: "DESC" },
      take: limit,
    });
  }

  /**
   * Cursor pagination over the activity feed. Walks newest-first by `id`
   * (monotonically increasing) instead of `createdAt` so the walk stays
   * stable across mid-second clock collisions and is unaffected by edits to
   * row payloads — appended rows always sort to the front, never displace
   * existing pages.
   */
  forIssueCursor(
    issueId: number,
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<ActivityLog>> {
    return this.repo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "DESC",
      where: { issueId },
    });
  }

  forWorkspaceCursor(
    workspaceId: number,
    take = 20,
    cursor?: string,
  ): Promise<CursorPaginationResult<ActivityLog>> {
    return this.repo.findWithCursor({
      take,
      cursor,
      orderBy: "id",
      direction: "DESC",
      where: { workspaceId },
    });
  }
}

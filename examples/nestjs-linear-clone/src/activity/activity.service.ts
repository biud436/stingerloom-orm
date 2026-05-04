import { Injectable } from "@nestjs/common";
import { BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { ActivityLog } from "./activity-log.entity";
import { ActivityAction } from "../common/enums";

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
    row.payload = (input.payload ? JSON.stringify(input.payload) : null) as any;
    return this.repo.save(row);
  }

  /**
   * MariaDB stores JSON columns as text — values come back as JSON strings.
   * Parse the `payload` column once on the way out so consumers see plain objects.
   */
  private hydrate(rows: ActivityLog[]): ActivityLog[] {
    for (const r of rows) {
      if (typeof r.payload === "string") {
        try {
          r.payload = JSON.parse(r.payload as unknown as string);
        } catch {
          // Leave it as the raw string if it isn't valid JSON.
        }
      }
    }
    return rows;
  }

  async forIssue(issueId: number, limit = 50): Promise<ActivityLog[]> {
    const rows = await this.repo.find({
      where: { issueId },
      orderBy: { createdAt: "DESC" },
      take: limit,
    });
    return this.hydrate(rows);
  }

  async forWorkspace(workspaceId: number, limit = 100): Promise<ActivityLog[]> {
    const rows = await this.repo.find({
      where: { workspaceId },
      orderBy: { createdAt: "DESC" },
      take: limit,
    });
    return this.hydrate(rows);
  }
}

import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import { EntityManager, EntitySubscriber, UpdateEvent } from "@stingerloom/orm";
import { Issue } from "./issue.entity";
import { ActivityService } from "../activity/activity.service";
import { ACTIVITY_ACTION } from "../../common/enums";
import { RequestContextStore } from "../../common/context/request-context";

/**
 * Auditable columns. Excludes noise (updatedAt, version, claimedBy/At sentinel
 * churn, FK shadow columns) and identity fields (id, projectId, number).
 *
 * The list is explicit — auditing every column blindly would record bookkeeping
 * fields and make the activity feed unreadable.
 */
const AUDITED: ReadonlyArray<keyof Issue> = [
  "title",
  "description",
  "status",
  "priority",
  "estimate",
  "sprintId",
  "assigneeId",
  "reporterId",
  "parentId",
  "customFields",
  "completedAt",
];

interface ColumnChange {
  column: string;
  from: unknown;
  to: unknown;
}

/**
 * Captures every Issue UPDATE as a single ActivityLog row whose payload is the
 * column-level diff between `event.databaseEntity` (pre-update) and
 * `event.entity` (the patch). Replaces the per-column manual fan-out
 * (STATUS_CHANGED / ASSIGNED / PRIORITY_CHANGED) that IssuesService.update
 * used to emit by hand.
 *
 * Requires the ORM core change exposing `event.databaseEntity` — without it,
 * the subscriber falls back to "no payload" and writes a marker row only.
 */
@Injectable()
export class IssueAuditSubscriber
  implements EntitySubscriber<Issue>, OnModuleInit
{
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly activity: ActivityService,
  ) {}

  onModuleInit(): void {
    this.em.addSubscriber(this);
  }

  listenTo() {
    return Issue;
  }

  async beforeUpdate(event: UpdateEvent<Issue>): Promise<void> {
    const before = event.databaseEntity;
    if (!before) return; // no snapshot available — nothing to diff

    const after = event.entity;
    const changes = this.diff(before, after);
    if (changes.length === 0) return;

    const actor = RequestContextStore.get();

    await this.activity.log({
      issueId: before.id,
      workspaceId: actor?.workspaceId ?? null,
      actorUserId: actor?.userId ?? null,
      action: ACTIVITY_ACTION.ISSUE_UPDATED,
      payload: {
        changes,
        requestId: actor?.requestId ?? null,
      },
    });
  }

  private diff(before: Issue, after: Partial<Issue>): ColumnChange[] {
    const out: ColumnChange[] = [];
    for (const col of AUDITED) {
      // Only fields the caller actually patched are candidates for a diff —
      // partial-update DTOs leave the rest as `undefined`.
      if (after[col] === undefined) continue;
      const prev = before[col];
      const next = after[col];
      if (this.equal(prev, next)) continue;
      out.push({
        column: String(col),
        from: this.serialize(prev),
        to: this.serialize(next),
      });
    }
    return out;
  }

  private equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) {
      return false;
    }
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    if (typeof a === "object" && typeof b === "object") {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }

  /** Make Date objects + nested objects safe to round-trip through JSON. */
  private serialize(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    return value ?? null;
  }
}

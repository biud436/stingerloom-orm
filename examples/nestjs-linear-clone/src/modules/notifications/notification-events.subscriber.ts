import { Injectable, Inject, OnModuleInit } from "@nestjs/common";
import {
  EntityManager,
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  qAlias,
} from "@stingerloom/orm";
import { Comment } from "../comments/comment.entity";
import { Issue } from "../issues/issue.entity";
import { User } from "../users/user.entity";
import { IssueWatcher } from "./issue-watcher.entity";
import { NotificationsService } from "./notifications.service";
import { extractMentions } from "./mention-parser";
import { RequestContextStore } from "../../common/context/request-context";

/**
 * Wires Comment + Issue lifecycle events into the notification stream.
 *
 *   - Comment.afterInsert  → parse `@mentions`, emit `kind: "mention"`
 *   - Issue.afterUpdate    → fan out to watchers on status change,
 *                            ping the new assignee on assignee change
 *
 * The example's User entity has no dedicated `handle` column, so we derive
 * the handle from the email local-part (`alice@acme.test` → `alice`). That
 * mirrors how the test fixtures already register users.
 */

@Injectable()
export class CommentMentionSubscriber
  implements EntitySubscriber<Comment>, OnModuleInit
{
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.em.addSubscriber(this);
  }

  listenTo() {
    return Comment;
  }

  async afterInsert(event: InsertEvent<Comment>): Promise<void> {
    const c = event.entity;
    if (!c.body || !c.issueId) return;

    const handles = extractMentions(c.body);
    if (handles.length === 0) return;

    const u = qAlias(User, "u");
    const users = await this.em
      .createQueryBuilder(u)
      .getMany();
    // Match handle == email local-part (case-insensitive). Done in JS so we
    // don't need a DB-portable LOWER(SPLIT_PART) expression for this example.
    const wanted = new Set(handles.map((h) => h.toLowerCase()));
    const targets = users.filter((row) => {
      const local = (row.email ?? "").split("@")[0]?.toLowerCase();
      return local && wanted.has(local);
    });
    if (targets.length === 0) return;

    const actor = c.authorId ?? null;
    await this.notifications.emitMany(
      targets.map((t) => ({
        userId: t.id,
        sourceIssueId: c.issueId!,
        kind: "mention" as const,
        payload: { commentId: c.id ?? null },
      })),
      actor,
    );
  }
}

@Injectable()
export class IssueChangeSubscriber
  implements EntitySubscriber<Issue>, OnModuleInit
{
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.em.addSubscriber(this);
  }

  listenTo() {
    return Issue;
  }

  async beforeUpdate(event: UpdateEvent<Issue>): Promise<void> {
    const before = event.databaseEntity;
    if (!before) return;
    const after = event.entity;

    const actor = RequestContextStore.get()?.userId ?? null;

    if (after.status !== undefined && after.status !== before.status) {
      await this.fanOutToWatchers(before.id, actor, "status_change", {
        from: before.status,
        to: after.status,
      });
    }

    const newAssignee = after.assigneeId;
    if (
      newAssignee !== undefined &&
      newAssignee !== null &&
      newAssignee !== before.assigneeId
    ) {
      await this.notifications.emitMany(
        [
          {
            userId: newAssignee,
            sourceIssueId: before.id,
            kind: "assigned",
            payload: { from: before.assigneeId ?? null, to: newAssignee },
          },
        ],
        actor,
      );
    }
  }

  private async fanOutToWatchers(
    issueId: number,
    actor: number | null,
    kind: "status_change",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const w = qAlias(IssueWatcher, "w");
    const watchers = await this.em
      .createQueryBuilder(w)
      .where(w.issueId.eq(issueId))
      .getMany();
    if (watchers.length === 0) return;

    await this.notifications.emitMany(
      watchers
        .filter((row): row is IssueWatcher & { userId: number } =>
          typeof row.userId === "number",
        )
        .map((row) => ({
          userId: row.userId,
          sourceIssueId: issueId,
          kind,
          payload,
        })),
      actor,
    );
  }
}

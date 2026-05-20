export const ISSUE_STATUS = {
  BACKLOG: "BACKLOG",
  TODO: "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  IN_REVIEW: "IN_REVIEW",
  DONE: "DONE",
  CANCELED: "CANCELED",
} as const;

export type IssueStatus = (typeof ISSUE_STATUS)[keyof typeof ISSUE_STATUS];

export const ISSUE_STATUSES: IssueStatus[] = Object.values(ISSUE_STATUS);

export const TERMINAL_STATUSES: IssueStatus[] = [
  ISSUE_STATUS.DONE,
  ISSUE_STATUS.CANCELED,
];

export const ISSUE_PRIORITY = {
  NO_PRIORITY: 0,
  URGENT: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
} as const;

export type IssuePriority =
  (typeof ISSUE_PRIORITY)[keyof typeof ISSUE_PRIORITY];

export const MEMBERSHIP_ROLE = {
  OWNER: "OWNER",
  ADMIN: "ADMIN",
  MEMBER: "MEMBER",
  GUEST: "GUEST",
} as const;

export type MembershipRole =
  (typeof MEMBERSHIP_ROLE)[keyof typeof MEMBERSHIP_ROLE];

export const SPRINT_STATUS = {
  PLANNED: "PLANNED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
} as const;

export type SprintStatus = (typeof SPRINT_STATUS)[keyof typeof SPRINT_STATUS];

export const ACTIVITY_ACTION = {
  ISSUE_CREATED: "ISSUE_CREATED",
  /**
   * Single envelope for all column-level Issue updates. Payload shape:
   * `{ changes: [{ column, from, to }, …], requestId }`.
   * Emitted by IssueAuditSubscriber.beforeUpdate via the ORM's
   * `event.databaseEntity` snapshot.
   */
  ISSUE_UPDATED: "ISSUE_UPDATED",
  /**
   * Soft-delete and restore of an Issue. Emitted by IssuesService inside the
   * same `@Transactional` frame as the UPDATE, so the audit row commits or
   * rolls back atomically with the `deletedAt` state change. A cascade
   * restore writes one `ISSUE_RESTORED` row per affected id; those rows
   * carry `payload: { cascade: true, rootId }` tying the subtree to the
   * triggering operation.
   */
  ISSUE_DELETED: "ISSUE_DELETED",
  ISSUE_RESTORED: "ISSUE_RESTORED",
  COMMENTED: "COMMENTED",
  LABEL_ADDED: "LABEL_ADDED",
  LABEL_REMOVED: "LABEL_REMOVED",
  CLAIMED: "CLAIMED",
  RELEASED: "RELEASED",
} as const;

export type ActivityAction =
  (typeof ACTIVITY_ACTION)[keyof typeof ACTIVITY_ACTION];

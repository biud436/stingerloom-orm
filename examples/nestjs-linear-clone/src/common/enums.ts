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
  ISSUE_UPDATED: "ISSUE_UPDATED",
  STATUS_CHANGED: "STATUS_CHANGED",
  ASSIGNED: "ASSIGNED",
  UNASSIGNED: "UNASSIGNED",
  PRIORITY_CHANGED: "PRIORITY_CHANGED",
  COMMENTED: "COMMENTED",
  LABEL_ADDED: "LABEL_ADDED",
  LABEL_REMOVED: "LABEL_REMOVED",
  CLAIMED: "CLAIMED",
  RELEASED: "RELEASED",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
} as const;

export type ActivityAction =
  (typeof ACTIVITY_ACTION)[keyof typeof ACTIVITY_ACTION];

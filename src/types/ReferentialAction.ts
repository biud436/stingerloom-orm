import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * SQL standard referential actions for ON DELETE / ON UPDATE clauses.
 */
export type ReferentialAction =
  | "CASCADE"
  | "SET NULL"
  | "SET DEFAULT"
  | "RESTRICT"
  | "NO ACTION";

export const VALID_REFERENTIAL_ACTIONS: ReferentialAction[] = [
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
  "RESTRICT",
  "NO ACTION",
];

/** The `ON DELETE` / `ON UPDATE` actions of one foreign key constraint. */
export interface ForeignKeyActions {
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

/**
 * ` ON DELETE <action>` / ` ON UPDATE <action>` for a FOREIGN KEY clause, or
 * an empty string when no action is given.
 *
 * The action is spliced into DDL as written, so a value outside
 * {@link VALID_REFERENTIAL_ACTIONS} throws instead of reaching the statement
 * — or, as it used to on SQLite, being dropped so the constraint silently
 * fell back to NO ACTION.
 */
export function referentialActionClause(
  keyword: "ON DELETE" | "ON UPDATE",
  action: ReferentialAction | null | undefined,
): string {
  if (action === undefined || action === null) return "";
  if (!VALID_REFERENTIAL_ACTIONS.includes(action)) {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Invalid ${keyword} action ${JSON.stringify(action)}.`,
      `Use one of: ${VALID_REFERENTIAL_ACTIONS.join(", ")}.`,
    );
  }
  return ` ${keyword} ${action}`;
}

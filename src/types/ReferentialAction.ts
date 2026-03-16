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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";

/**
 * A tracked entity with its snapshot for dirty checking.
 */
export interface TrackedEntry {
  entity: ClazzType<any>;
  instance: any;
  snapshot: Record<string, any>;
  columnNames: string[];
  pkColumns: string[];
}

/**
 * A queued INSERT operation.
 */
export interface InsertEntry {
  entity: ClazzType<any>;
  data: Record<string, any>;
}

/**
 * A queued DELETE operation.
 */
export interface DeleteEntry {
  entity: ClazzType<any>;
  criteria: Record<string, any>;
}

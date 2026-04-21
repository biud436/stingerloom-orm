import { ResultTransformer } from "./ResultTransformer";

/**
 * Default factory class for creating ResultTransformer instances.
 *
 * Used when creating a ResultTransformer for a specific database.
 *
 * For example, this could be overridden to produce a ResultTransformer tailored for SQLite.
 */
export class ResultTransformerFactory {
  static create() {
    return new ResultTransformer();
  }
}

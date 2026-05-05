import { EntityManager, qAlias } from "@stingerloom/orm";
import { Issue } from "../../issues/issue.entity";

export interface IssueSearchHit {
  id: number;
  number: number;
  title: string;
  status: string;
  source: "issue" | "comment";
  snippet: string;
  rank: number;
}

export interface CustomFieldHit {
  id: number;
  number: number;
  title: string;
  status: string;
  customFieldValue: unknown;
}

/**
 * Dialect-agnostic shape; concrete subclasses fill in the FT/GIN
 * specifics. The module provider chooses the impl per `EntityManager`'s
 * driver, so callers (SearchService) stay dialect-free.
 */
export abstract class SearchRepository {
  constructor(protected readonly em: EntityManager) {}

  /**
   * Full-text search over issue title/description and comment body.
   * Implementations issue `MATCH ... AGAINST` (MySQL) or
   * `to_tsvector ... @@ plainto_tsquery` (PostgreSQL).
   */
  abstract fullTextIssues(
    queryText: string,
    projectId?: number,
    limit?: number,
  ): Promise<IssueSearchHit[]>;

  /**
   * Idempotent install of the FULLTEXT (MySQL) / GIN (PostgreSQL)
   * indexes that back `fullTextIssues`. Called from `SearchModule`'s
   * `onModuleInit` because `SchemaRegistrar.synchronize()` does not
   * currently emit DDL for `@FullTextIndex` columns.
   */
  abstract ensureFullTextIndexes(): Promise<void>;

  /**
   * Filter issues by a JSON `customFields` key/value pair. Lives on the
   * abstract base because `qAlias(Issue).customFields.path(key)`
   * compiles per-driver (`#>>` on PostgreSQL, `JSON_UNQUOTE(JSON_EXTRACT(...))`
   * on MySQL) with `key` bound as a parameter, so the same builder
   * works on every dialect with no branching.
   */
  async byCustomField(
    projectId: number,
    key: string,
    value: string,
    limit = 50,
  ): Promise<CustomFieldHit[]> {
    const i = qAlias(Issue, "i");
    const pathExpr = i.customFields.path(key);

    const rows = await this.em
      .createQueryBuilder(i)
      .select(["id", "number", "title", "status"])
      .addSelect(pathExpr.as("customFieldValue"))
      .where(i.projectId.eq(projectId))
      .andWhere(pathExpr.eq(value))
      .andWhere(i.deletedAt.isNull())
      .limit(limit)
      .getRawMany();

    return rows.map((r) => ({
      id: Number(r.id),
      number: Number(r.number),
      title: String(r.title),
      status: String(r.status),
      customFieldValue: r.customFieldValue,
    }));
  }
}

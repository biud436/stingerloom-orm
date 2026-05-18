import { sql, Sql, Conditions } from "@stingerloom/orm";
import { SearchRepository, IssueSearchHit } from "./search.repository.abstract";

export class PostgresSearchRepository extends SearchRepository {
  async fullTextIssues(
    queryText: string,
    projectId?: number,
    limit = 20,
  ): Promise<IssueSearchHit[]> {
    // Predicate: emits `to_tsvector(...) @@ plainto_tsquery(...)` with the
    // multi-column COALESCE concat composed by the helper. Used in WHERE.
    const issueMatch = Conditions.fullTextSearch(
      ["i.title", "i.description"],
      queryText,
      "postgres",
    );
    const commentMatch = Conditions.fullTextSearch("c.body", queryText, "postgres");

    // Rank: PG separates predicate (`@@`) from scoring (`ts_rank`), so the
    // rank expression is hand-written. MySQL reuses MATCH...AGAINST for both.
    const issueRank = sql`ts_rank(
      to_tsvector('english', COALESCE(i.title, '') || ' ' || COALESCE(i.description, '')),
      plainto_tsquery('english', ${queryText})
    )`;
    const commentRank = sql`ts_rank(
      to_tsvector('english', c.body),
      plainto_tsquery('english', ${queryText})
    )`;

    const projectFilter =
      projectId !== undefined ? sql`AND i.project_id = ${projectId}` : sql``;

    const finalSql: Sql = sql`
      SELECT * FROM (
        SELECT
          i.id, i.number, i.title, i.status,
          'issue' AS source,
          COALESCE(LEFT(i.description, 200), '') AS snippet,
          ${issueRank} AS rank
        FROM issue i
        WHERE ${issueMatch}
          AND i."deleted_at" IS NULL
          ${projectFilter}
        UNION ALL
        SELECT
          i.id, i.number, i.title, i.status,
          'comment',
          LEFT(c.body, 200),
          ${commentRank}
        FROM comment c
        JOIN issue i ON i.id = c.issue_id
        WHERE ${commentMatch}
          AND c."deleted_at" IS NULL
          AND i."deleted_at" IS NULL
          ${projectFilter}
      ) hits
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    const rows = await this.em.query<Record<string, unknown>>(finalSql);
    return rows.map((r) => ({
      id: Number(r.id),
      number: Number(r.number),
      title: String(r.title),
      status: String(r.status),
      source: String(r.source) as "issue" | "comment",
      snippet: String(r.snippet ?? ""),
      rank: Number(r.rank ?? 0),
    }));
  }
}

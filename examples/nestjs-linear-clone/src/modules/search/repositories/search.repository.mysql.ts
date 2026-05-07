import { sql, Sql, Conditions } from "@stingerloom/orm";
import { SearchRepository, IssueSearchHit } from "./search.repository.abstract";

export class MySqlSearchRepository extends SearchRepository {
  async fullTextIssues(
    queryText: string,
    projectId?: number,
    limit = 20,
  ): Promise<IssueSearchHit[]> {
    const issueMatch = Conditions.fullTextSearch(
      ["i.title", "i.description"],
      queryText,
      "mysql",
      { mode: "natural" },
    );
    const commentMatch = Conditions.fullTextSearch(
      "c.body",
      queryText,
      "mysql",
      { mode: "natural" },
    );

    const projectFilter =
      projectId !== undefined ? sql`AND i.project_id = ${projectId}` : sql``;

    const finalSql: Sql = sql`
      SELECT * FROM (
        SELECT
          i.id, i.number, i.title, i.status,
          'issue' AS source,
          LEFT(COALESCE(i.description, ''), 200) AS snippet,
          ${issueMatch} AS rank
        FROM issue i
        WHERE ${issueMatch}
          AND i.deleted_at IS NULL
          ${projectFilter}
        UNION ALL
        SELECT
          i.id, i.number, i.title, i.status,
          'comment',
          LEFT(c.body, 200),
          ${commentMatch}
        FROM comment c
        JOIN issue i ON i.id = c.issue_id
        WHERE ${commentMatch}
          AND c.deleted_at IS NULL
          AND i.deleted_at IS NULL
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

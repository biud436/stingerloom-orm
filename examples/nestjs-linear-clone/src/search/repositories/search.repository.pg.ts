import { sql, raw, Sql } from "@stingerloom/orm";
import { SearchRepository, IssueSearchHit } from "./search.repository.abstract";
import { q } from "../../analytics/sql-helpers";

const QUOTE = (name: string) => q(name, "postgres");

export class PostgresSearchRepository extends SearchRepository {
  async fullTextIssues(
    queryText: string,
    projectId?: number,
    limit = 20,
  ): Promise<IssueSearchHit[]> {
    const issue = QUOTE("issue");
    const comment = QUOTE("comment");
    const id = QUOTE("id");
    const number = QUOTE("number");
    const title = QUOTE("title");
    const status = QUOTE("status");
    const description = QUOTE("description");
    const body = QUOTE("body");
    const projectCol = QUOTE("project_id");
    const issueIdCol = QUOTE("issue_id");
    const deletedAt = QUOTE("deletedAt");

    const issueMatch = sql`to_tsvector('english', COALESCE(i.${raw(title)}, '') || ' ' || COALESCE(i.${raw(description)}, '')) @@ plainto_tsquery('english', ${queryText})`;
    const issueRank = sql`ts_rank(to_tsvector('english', COALESCE(i.${raw(title)}, '') || ' ' || COALESCE(i.${raw(description)}, '')), plainto_tsquery('english', ${queryText}))`;
    const commentMatch = sql`to_tsvector('english', c.${raw(body)}) @@ plainto_tsquery('english', ${queryText})`;
    const commentRank = sql`ts_rank(to_tsvector('english', c.${raw(body)}), plainto_tsquery('english', ${queryText}))`;

    const projectFilter =
      projectId !== undefined
        ? sql`AND i.${raw(projectCol)} = ${projectId}`
        : sql``;

    const finalSql: Sql = sql`
      SELECT * FROM (
        SELECT
          i.${raw(id)}            AS ${raw(id)},
          i.${raw(number)}        AS ${raw(number)},
          i.${raw(title)}         AS ${raw(title)},
          i.${raw(status)}        AS ${raw(status)},
          ${"issue"}              AS source,
          COALESCE(LEFT(i.${raw(description)}, 200), '') AS snippet,
          ${issueRank}            AS rank
        FROM ${raw(issue)} i
        WHERE ${issueMatch}
          AND i.${raw(deletedAt)} IS NULL
          ${projectFilter}
        UNION ALL
        SELECT
          i.${raw(id)},
          i.${raw(number)},
          i.${raw(title)},
          i.${raw(status)},
          ${"comment"},
          LEFT(c.${raw(body)}, 200),
          ${commentRank}
        FROM ${raw(comment)} c
        JOIN ${raw(issue)} i ON i.${raw(id)} = c.${raw(issueIdCol)}
        WHERE ${commentMatch}
          AND c.${raw(deletedAt)} IS NULL
          AND i.${raw(deletedAt)} IS NULL
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

  async ensureFullTextIndexes(): Promise<void> {
    const stmts = [
      `CREATE INDEX IF NOT EXISTS ft_issue_title_desc ON ${QUOTE("issue")}
         USING GIN (to_tsvector('english', COALESCE(${QUOTE("title")}, '') || ' ' || COALESCE(${QUOTE("description")}, '')))`,
      `CREATE INDEX IF NOT EXISTS ft_comment_body ON ${QUOTE("comment")}
         USING GIN (to_tsvector('english', ${QUOTE("body")}))`,
    ];
    for (const stmt of stmts) {
      try {
        await this.em.query(stmt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[SearchRepository:pg] Could not create GIN index: ${err}`);
      }
    }
  }
}

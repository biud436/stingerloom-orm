import { Injectable, Inject } from "@nestjs/common";
import { EntityManager, sql, raw, Sql } from "@stingerloom/orm";
import { detectDialect, q } from "../analytics/sql-helpers";

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

@Injectable()
export class SearchService {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  /**
   * Full-text search over issue title/description and comment body.
   *
   * MySQL/MariaDB → `MATCH(...) AGAINST (q IN NATURAL LANGUAGE MODE)`.
   * PostgreSQL    → `to_tsvector(...) @@ plainto_tsquery(q)` against a GIN
   *                  index built in `SearchModule.onModuleInit`.
   *
   * Hits from issues and comments are merged with `UNION ALL` and ranked.
   */
  async fullTextIssues(
    queryText: string,
    projectId?: number,
    limit = 20,
  ): Promise<IssueSearchHit[]> {
    const dialect = detectDialect(this.em);
    const isPg = dialect === "postgres";
    const issue = q("issue", dialect);
    const comment = q("comment", dialect);
    const id = q("id", dialect);
    const number = q("number", dialect);
    const title = q("title", dialect);
    const status = q("status", dialect);
    const description = q("description", dialect);
    const body = q("body", dialect);
    const projectCol = q("project_id", dialect);
    const issueIdCol = q("issue_id", dialect);
    const deletedAt = q("deletedAt", dialect);

    const issueMatch = isPg
      ? sql`to_tsvector('english', COALESCE(i.${raw(title)}, '') || ' ' || COALESCE(i.${raw(description)}, '')) @@ plainto_tsquery('english', ${queryText})`
      : sql`MATCH(i.${raw(title)}, i.${raw(description)}) AGAINST (${queryText} IN NATURAL LANGUAGE MODE)`;

    const issueRank = isPg
      ? sql`ts_rank(to_tsvector('english', COALESCE(i.${raw(title)}, '') || ' ' || COALESCE(i.${raw(description)}, '')), plainto_tsquery('english', ${queryText}))`
      : sql`MATCH(i.${raw(title)}, i.${raw(description)}) AGAINST (${queryText} IN NATURAL LANGUAGE MODE)`;

    const commentMatch = isPg
      ? sql`to_tsvector('english', c.${raw(body)}) @@ plainto_tsquery('english', ${queryText})`
      : sql`MATCH(c.${raw(body)}) AGAINST (${queryText} IN NATURAL LANGUAGE MODE)`;

    const commentRank = isPg
      ? sql`ts_rank(to_tsvector('english', c.${raw(body)}), plainto_tsquery('english', ${queryText}))`
      : sql`MATCH(c.${raw(body)}) AGAINST (${queryText} IN NATURAL LANGUAGE MODE)`;

    const projectFilterIssue =
      projectId !== undefined
        ? sql`AND i.${raw(projectCol)} = ${projectId}`
        : sql``;
    const projectFilterComment =
      projectId !== undefined
        ? sql`AND i.${raw(projectCol)} = ${projectId}`
        : sql``;

    const snippetIssue = isPg
      ? sql`COALESCE(LEFT(i.${raw(description)}, 200), '')`
      : sql`LEFT(COALESCE(i.${raw(description)}, ''), 200)`;
    const snippetComment = sql`LEFT(c.${raw(body)}, 200)`;

    const finalSql: Sql = sql`
      SELECT * FROM (
        SELECT
          i.${raw(id)}                AS ${raw(id)},
          i.${raw(number)}            AS ${raw(number)},
          i.${raw(title)}             AS ${raw(title)},
          i.${raw(status)}            AS ${raw(status)},
          ${"issue"}                  AS source,
          ${snippetIssue}             AS snippet,
          ${issueRank}                AS rank
        FROM ${raw(issue)} i
        WHERE ${issueMatch}
          AND i.${raw(deletedAt)} IS NULL
          ${projectFilterIssue}
        UNION ALL
        SELECT
          i.${raw(id)},
          i.${raw(number)},
          i.${raw(title)},
          i.${raw(status)},
          ${"comment"},
          ${snippetComment},
          ${commentRank}
        FROM ${raw(comment)} c
        JOIN ${raw(issue)} i ON i.${raw(id)} = c.${raw(issueIdCol)}
        WHERE ${commentMatch}
          AND c.${raw(deletedAt)} IS NULL
          AND i.${raw(deletedAt)} IS NULL
          ${projectFilterComment}
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

  /**
   * Filter issues by a JSON `customFields` key/value pair. Identifier
   * pattern check happens in the controller before we get here, so it is
   * safe to splice `key` into a JSON path literal.
   */
  async byCustomField(
    projectId: number,
    key: string,
    value: string,
    limit = 50,
  ): Promise<CustomFieldHit[]> {
    const dialect = detectDialect(this.em);
    const isPg = dialect === "postgres";
    const issue = q("issue", dialect);
    const id = q("id", dialect);
    const number = q("number", dialect);
    const title = q("title", dialect);
    const status = q("status", dialect);
    const projectCol = q("project_id", dialect);
    const customFields = q("customFields", dialect);
    const deletedAt = q("deletedAt", dialect);

    const path = `$.${key}`;
    const extract = isPg
      ? sql`${raw(customFields)}->>${key}`
      : sql`JSON_UNQUOTE(JSON_EXTRACT(${raw(customFields)}, ${path}))`;

    const finalSql: Sql = sql`
      SELECT
        ${raw(id)}        AS ${raw(id)},
        ${raw(number)}    AS ${raw(number)},
        ${raw(title)}     AS ${raw(title)},
        ${raw(status)}    AS ${raw(status)},
        ${extract}        AS ${raw(q("customFieldValue", dialect))}
      FROM ${raw(issue)}
      WHERE ${raw(projectCol)} = ${projectId}
        AND ${extract} = ${value}
        AND ${raw(deletedAt)} IS NULL
      LIMIT ${limit}
    `;

    const rows = await this.em.query<Record<string, unknown>>(finalSql);
    return rows.map((r) => ({
      id: Number(r.id),
      number: Number(r.number),
      title: String(r.title),
      status: String(r.status),
      customFieldValue: r.customFieldValue,
    }));
  }
}

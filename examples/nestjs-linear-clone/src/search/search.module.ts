import { Module, OnModuleInit, Inject } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { detectDialect, q } from "../analytics/sql-helpers";

/**
 * SchemaRegistrar.synchronize() does not currently emit DDL for
 * @FullTextIndex columns, so we install the FULLTEXT (MySQL) /
 * GIN (PostgreSQL) indexes here once the ORM finishes its first sync.
 * Runs idempotently — checks information_schema before issuing CREATE.
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule implements OnModuleInit {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async onModuleInit(): Promise<void> {
    const dialect = detectDialect(this.em);
    if (dialect === "postgres") {
      await this.ensurePostgresFtIndexes();
    } else {
      await this.ensureMysqlFtIndexes();
    }
  }

  private async ensureMysqlFtIndexes(): Promise<void> {
    const checks: Array<{ table: string; index: string; cols: string[] }> = [
      { table: "issue", index: "ft_issue_title_desc", cols: ["title", "description"] },
      { table: "comment", index: "ft_comment_body", cols: ["body"] },
    ];

    for (const { table, index, cols } of checks) {
      const rows = await this.em.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?`,
        [table, index],
      );
      if (Number(rows[0]?.count ?? 0) > 0) continue;

      const colList = cols.map((c) => `\`${c}\``).join(", ");
      try {
        await this.em.query(
          `ALTER TABLE \`${table}\` ADD FULLTEXT INDEX \`${index}\` (${colList})`,
        );
      } catch (err) {
        // The table may not exist yet on a fresh database before synchronize
        // ran; that path is an integration-test edge case so we just log.
        // eslint-disable-next-line no-console
        console.warn(`[SearchModule] Could not create FULLTEXT ${index}: ${err}`);
      }
    }
  }

  private async ensurePostgresFtIndexes(): Promise<void> {
    const stmts = [
      `CREATE INDEX IF NOT EXISTS ft_issue_title_desc ON ${q("issue", "postgres")}
         USING GIN (to_tsvector('english', COALESCE(${q("title", "postgres")}, '') || ' ' || COALESCE(${q("description", "postgres")}, '')))`,
      `CREATE INDEX IF NOT EXISTS ft_comment_body ON ${q("comment", "postgres")}
         USING GIN (to_tsvector('english', ${q("body", "postgres")}))`,
    ];
    for (const stmt of stmts) {
      try {
        await this.em.query(stmt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[SearchModule] Could not create GIN index: ${err}`);
      }
    }
  }
}

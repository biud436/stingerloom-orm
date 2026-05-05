import { Module, OnModuleInit } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { SearchRepository } from "./repositories/search.repository.abstract";
import { MySqlSearchRepository } from "./repositories/search.repository.mysql";
import { PostgresSearchRepository } from "./repositories/search.repository.pg";

/**
 * The dialect choice happens once, here. Downstream code (service,
 * controller) talks to the abstract `SearchRepository` and stays
 * unaware of which engine is underneath.
 */
@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    {
      provide: SearchRepository,
      useFactory: (em: EntityManager): SearchRepository =>
        em.getDriver().isMySqlFamily()
          ? new MySqlSearchRepository(em)
          : new PostgresSearchRepository(em),
      inject: [EntityManager],
    },
  ],
  exports: [SearchService],
})
export class SearchModule implements OnModuleInit {
  constructor(private readonly repo: SearchRepository) {}

  /**
   * SchemaRegistrar.synchronize() does not currently emit DDL for
   * @FullTextIndex columns, so the repository installs the
   * FULLTEXT (MySQL) / GIN (PostgreSQL) indexes here once the ORM
   * finishes its first sync. Idempotent.
   */
  async onModuleInit(): Promise<void> {
    await this.repo.ensureFullTextIndexes();
  }
}

import { Module } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";
import { SearchRepository } from "./repositories/search.repository.abstract";
import { MySqlSearchRepository } from "./repositories/search.repository.mysql";
import { PostgresSearchRepository } from "./repositories/search.repository.pg";

/**
 * The dialect choice happens once, here. Downstream code (service,
 * controller) talks to the abstract `SearchRepository` and stays
 * unaware of which engine is underneath. The FULLTEXT (MySQL) /
 * GIN (PostgreSQL) indexes that back full-text search are declared
 * with `@FullTextIndex` on Issue / Comment and created automatically
 * by `SchemaRegistrar.synchronize()` on startup.
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
export class SearchModule {}

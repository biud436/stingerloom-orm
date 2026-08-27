/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration test — forFeature connectionName typos fail with an actionable
 * OrmError at module init (V4-T2-4).
 *
 * The repository provider used to `inject: [emToken]` directly, so a typo'd
 * connectionName died inside Nest's resolver with the generic "can't resolve
 * dependencies (?)" — the factory never ran and nothing named the missing
 * connection. The EntityManager is now injected as optional and the factory
 * raises an OrmError listing the known connections with a closest-match
 * suggestion.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { StingerloomOrmModule } from "../../../src/integration/nestjs/stingerloom-orm.module";
import { InjectRepository } from "../../../src/integration/nestjs/inject-repository.decorator";
import type { BaseRepository } from "../../../src/core/BaseRepository";

@Entity({ name: "fff_user" })
class UserE {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const opts = () => ({
  type: "sqlite" as const,
  database: ":memory:",
  entities: [UserE],
  synchronize: true as const,
});

async function boot(imports: any[], providers: any[] = []): Promise<TestingModule> {
  @Module({ imports, providers })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

afterEach(async () => {
  MetadataContext.reset();
  await DatabaseClient.getInstance().close();
});

describe("[Integration] forFeature connection fail-fast", () => {
  it("rejects a typo'd connectionName with known connections and a suggestion", async () => {
    await expect(
      boot([
        StingerloomOrmModule.forRoot(opts()),
        StingerloomOrmModule.forFeature([UserE], "defualt"),
      ]),
    ).rejects.toThrow(
      /no forRoot\(\)\/forRootAsync\(\) registered a connection named "defualt"/,
    );

    // Same boot, richer assertions on the message body.
    await expect(
      boot([
        StingerloomOrmModule.forRoot(opts()),
        StingerloomOrmModule.forFeature([UserE], "defualt"),
      ]),
    ).rejects.toThrow(/Known connections: .*"default".*Did you mean "default"\?/);
  });

  it("still resolves a correctly wired repository (optional-inject regression guard)", async () => {
    @Injectable()
    class UserService {
      constructor(
        @InjectRepository(UserE)
        public readonly repo: BaseRepository<UserE>,
      ) {}
    }

    const moduleRef = await boot(
      [
        StingerloomOrmModule.forRoot(opts()),
        StingerloomOrmModule.forFeature([UserE]),
      ],
      [UserService],
    );

    const service = moduleRef.get(UserService);
    await service.repo.save({ name: "Ada" } as UserE);
    const found = await service.repo.find({ where: { name: "Ada" } });
    expect(found).toHaveLength(1);

    await moduleRef.close();
  });
});

/**
 * Entity metadata lives on the public layer, so registering an EntityManager
 * from inside `MetadataContext.run(tenant)` (a lazy bootstrap from a request
 * handler, a tenant provisioning job) must see the same entities as a
 * registration outside any context (SQLite :memory:).
 */

import "reflect-metadata";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import type { Relation } from "../../../src/types/Relation";

@Entity({ name: "ritc_author" })
class RitcAuthor {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @OneToMany(() => RitcBook, { mappedBy: "author" }) books!: RitcBook[];
}

@Entity({ name: "ritc_book" })
class RitcBook {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ name: "author_id", type: "int", nullable: true }) authorId!: number | null;
  @ManyToOne(() => RitcAuthor, (a) => a.books) author!: Relation<RitcAuthor>;
}

async function tableNames(em: EntityManager): Promise<string[]> {
  const rows = await em.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ritc_%' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

describe("[Integration] SQLite: registering inside a tenant context", () => {
  afterEach(async () => {
    MetadataContext.reset();
    await DatabaseClient.getInstance().close();
  });

  it("creates the tables of every entity", async () => {
    const em = new EntityManager();

    await MetadataContext.run("acme", () =>
      em.register(
        {
          type: "sqlite",
          database: ":memory:",
          entities: [RitcAuthor, RitcBook],
          synchronize: true,
          logging: false,
        },
        "ritc_inside",
      ),
    );

    expect(await tableNames(em)).toEqual(["ritc_author", "ritc_book"]);
    await em.propagateShutdown({ closeConnections: true });
  });

  it("writes and loads relations through the EntityManager it registered", async () => {
    const em = new EntityManager();

    await MetadataContext.run("acme", async () => {
      await em.register(
        {
          type: "sqlite",
          database: ":memory:",
          entities: [RitcAuthor, RitcBook],
          synchronize: true,
          logging: false,
        },
        "ritc_relations",
      );
      const author = await em.save(RitcAuthor, { name: "Ann" });
      await em.save(RitcBook, { title: "First", authorId: author.id });
    });

    const loaded = await MetadataContext.run("acme", () =>
      em.findOne(RitcAuthor, { where: { name: "Ann" }, relations: ["books"] }),
    );
    expect(loaded?.books.map((b: RitcBook) => b.title)).toEqual(["First"]);
    await em.propagateShutdown({ closeConnections: true });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `em.pipe()` over inheritance hierarchies.
 *
 * The pipeline reads the rows `find()` reads, as raw rows:
 *
 *   - a SINGLE_TABLE child: its own subtype's rows, not its siblings';
 *   - a JOINED child: its own table joined to the root's, so the inherited
 *     columns come back and can be filtered and ordered by;
 *   - a TABLE_PER_CLASS root: every concrete table, through the same UNION
 *     ALL `find()` reads, keyset pages included although the tables number
 *     their keys independently.
 *
 * SnakeNamingStrategy is on, so property names resolve to column names that
 * differ from them — a subclass's included, on the root.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  SnakeNamingStrategy,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

@Entity({ name: "rpi_animal" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind" })
class RpiAnimal {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}
@Entity({ name: "rpi_animal" })
@DiscriminatorValue("dog")
class RpiDog extends RpiAnimal {
  @Column({ nullable: true }) breed?: string;
}
@Entity({ name: "rpi_animal" })
@DiscriminatorValue("cat")
class RpiCat extends RpiAnimal {
  @Column({ nullable: true }) lives?: string;
}

@Entity({ name: "rpi_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class RpiDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() docTitle!: string;
}
@Entity({ name: "rpi_review" })
@DiscriminatorValue("review")
class RpiReview extends RpiDoc {
  @Column() reviewer!: string;
}

@Entity({ name: "rpi_pay" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "dtype" })
class RpiPay {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}
@Entity({ name: "rpi_card" })
@DiscriminatorValue("card")
class RpiCard extends RpiPay {
  @Column() cardBrand!: string;
}

const ENTITIES = [RpiAnimal, RpiDog, RpiCat, RpiDoc, RpiReview, RpiPay, RpiCard];

async function makeEm(opts: Record<string, any> = {}) {
  const base = new EntityManager();
  await base.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
      ...opts,
    } as any,
    `rpi_${Math.random().toString(36).slice(2, 10)}`,
  );
  return { base, em: base.extend(rawPipelinePlugin()) as any };
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

describe("[Integration] SQLite: em.pipe() over inheritance hierarchies", () => {
  let base: EntityManager;
  let em: any;

  beforeEach(async () => {
    MetadataContext.reset();
    ({ base, em } = await makeEm());
    await em.save(RpiDog, { name: "rex", breed: "lab" });
    await em.save(RpiDog, { name: "ace", breed: "pug" });
    await em.save(RpiCat, { name: "tom", lives: "9" });

    await em.save(RpiReview, { docTitle: "spec", reviewer: "ann" });
    await em.save(RpiReview, { docTitle: "plan", reviewer: "bob" });
    await em.save(RpiDoc, { docTitle: "memo" });

    // Both tables number their keys from 1, so ids repeat across the UNION.
    await em.save(RpiPay, { amount: 1 });
    await em.save(RpiPay, { amount: 2 });
    await em.save(RpiCard, { amount: 5, cardBrand: "visa" });
    await em.save(RpiCard, { amount: 6, cardBrand: "amex" });
  });

  afterEach(async () => {
    await base.propagateShutdown();
  });

  describe("SINGLE_TABLE", () => {
    it("reads and counts only a child's own subtype", async () => {
      const dogs = await em.pipe(RpiDog).collect();
      expect(dogs.map((r: any) => r.name).sort()).toEqual(["ace", "rex"]);
      expect(dogs.every((r: any) => r.kind === "dog")).toBe(true);
      expect(await em.pipe(RpiDog).count()).toBe(2);
      expect(await em.pipe(RpiCat, { where: { name: "rex" } }).count()).toBe(0);
    });

    it("pages a child in keyset and binary batches", async () => {
      const keyset = await drain(
        em.pipe(RpiDog, { orderBy: { id: "ASC" }, keyset: true, batchSize: 1 }).raw(),
      );
      expect(keyset.map((r: any) => r.name)).toEqual(["rex", "ace"]);
      expect(await drain(em.pipe(RpiCat).binary())).toHaveLength(1);
    });

    it("reads every subtype through the root", async () => {
      expect(await em.pipe(RpiAnimal).count()).toBe(3);
    });
  });

  describe("JOINED", () => {
    it("returns a child's inherited columns", async () => {
      const rows = await em.pipe(RpiReview, { orderBy: { id: "ASC" } }).collect();
      expect(rows.map((r: any) => [r.doc_title, r.reviewer])).toEqual([
        ["spec", "ann"],
        ["plan", "bob"],
      ]);
    });

    it("filters, selects and keyset-orders a child by an inherited property", async () => {
      expect(
        await em.pipe(RpiReview, { where: { docTitle: "plan" }, select: ["docTitle", "reviewer"] }).collect(),
      ).toEqual([{ doc_title: "plan", reviewer: "bob" }]);
      const keyset = await drain(
        em.pipe(RpiReview, { orderBy: { docTitle: "DESC" }, keyset: true, batchSize: 1 }).raw(),
      );
      expect(keyset.map((r: any) => r.doc_title)).toEqual(["spec", "plan"]);
      expect(await em.pipe(RpiReview, { where: { docTitle: "spec" } }).count()).toBe(1);
    });

    it("reads every row through the root", async () => {
      expect(await em.pipe(RpiDoc).count()).toBe(3);
    });
  });

  describe("TABLE_PER_CLASS", () => {
    const amounts = (rows: any[]) => rows.map((r) => Number(r.amount)).sort((a, b) => a - b);

    it("reads and counts every concrete table through the root", async () => {
      const rows = await em.pipe(RpiPay).collect();
      expect(amounts(rows)).toEqual([1, 2, 5, 6]);
      expect(rows.filter((r: any) => r.dtype === "card").map((r: any) => r.card_brand).sort()).toEqual([
        "amex",
        "visa",
      ]);
      expect(await em.pipe(RpiPay).count()).toBe(4);
    });

    it("filters the root by a subclass property", async () => {
      expect(amounts(await em.pipe(RpiPay, { where: { cardBrand: "visa" } }).collect())).toEqual([5]);
      expect(await em.pipe(RpiPay, { where: { amount: { gte: 2 } } }).count()).toBe(3);
    });

    it("keyset-pages the root although ids repeat across tables", async () => {
      for (const dir of ["ASC", "DESC"] as const) {
        const rows = await drain(
          em.pipe(RpiPay, { orderBy: { id: dir }, keyset: true, batchSize: 1 }).raw(),
        );
        expect(amounts(rows)).toEqual([1, 2, 5, 6]);
        const binary = await drain(
          em.pipe(RpiPay, { orderBy: { id: dir }, keyset: true, batchSize: 3 }).binary(),
        );
        expect(amounts(binary)).toEqual([1, 2, 5, 6]);
      }
    });

    it("reads a concrete child's own table", async () => {
      expect(amounts(await em.pipe(RpiCard).collect())).toEqual([5, 6]);
    });
  });

  it("scopes a hierarchy read by tenant under tenant_column", async () => {
    const scoped = await makeEm({ tenantStrategy: "tenant_column" });
    try {
      for (const tenant of ["acme", "beta"]) {
        await MetadataContext.run(tenant, async () => {
          await scoped.em.save(RpiDog, { name: `${tenant}-dog` });
          await scoped.em.save(RpiCat, { name: `${tenant}-cat` });
          await scoped.em.save(RpiReview, { docTitle: `${tenant}-doc`, reviewer: "r" });
          await scoped.em.save(RpiCard, { amount: 7, cardBrand: tenant });
          await scoped.em.save(RpiPay, { amount: 8 });
        });
      }
      await MetadataContext.run("acme", async () => {
        expect((await scoped.em.pipe(RpiDog).collect()).map((r: any) => r.name)).toEqual(["acme-dog"]);
        expect((await scoped.em.pipe(RpiReview).collect()).map((r: any) => r.doc_title)).toEqual([
          "acme-doc",
        ]);
        expect(await scoped.em.pipe(RpiPay).count()).toBe(2);
        expect(
          (await scoped.em.pipe(RpiPay, { where: { cardBrand: { isNull: false } } }).collect()).map(
            (r: any) => r.card_brand,
          ),
        ).toEqual(["acme"]);
      });
    } finally {
      await scoped.base.propagateShutdown();
    }
  });
});

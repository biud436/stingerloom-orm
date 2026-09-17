/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `tenantStrategy: "tenant_column"` on inheritance
 * hierarchies (V6-T0-2).
 *
 * The injected tenant column skipped every child entity, though only a
 * SINGLE_TABLE child shares its root's table:
 *
 *   - JOINED child: the root INSERT carried no tenant (NOT NULL failure) and
 *     reads named a tenant column on the child table, which has none.
 *   - TABLE_PER_CLASS child: the concrete table had no tenant column, so rows
 *     were stored unowned and the polymorphic root read returned nothing.
 *
 * The injected column also stayed on the class after the EntityManager shut
 * down and leaked into connections without the strategy.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

@Entity({ name: "tci_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TciDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}
@Entity({ name: "tci_review" })
@DiscriminatorValue("review")
class TciReview extends TciDoc {
  @Column() reviewer!: string;
}

@Entity({ name: "tci_pay" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "dtype" })
class TciPay {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}
@Entity({ name: "tci_card" })
@DiscriminatorValue("card")
class TciCard extends TciPay {
  @Column() card!: string;
}

@Entity({ name: "tci_animal" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind" })
class TciAnimal {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}
@Entity({ name: "tci_animal" })
@DiscriminatorValue("dog")
class TciDog extends TciAnimal {
  @Column({ nullable: true }) breed?: string;
}

@Entity({ name: "tci_shared" })
class TciShared {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const HIERARCHIES = [TciDoc, TciReview, TciPay, TciCard, TciAnimal, TciDog];

async function makeEm(entities: any[], tenant: boolean) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      logging: false,
      ...(tenant ? { tenantStrategy: "tenant_column" } : {}),
    } as any,
    `tci_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rawRows(em: EntityManager, query: string): Promise<any[]> {
  const raw: any = await em.getDriver()!.executeRaw(query);
  return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
}
const columnsOf = async (em: EntityManager, table: string) =>
  (await rawRows(em, `PRAGMA table_info("${table}")`)).map((r) => r.name);

const acme = <R>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
const globex = <R>(fn: () => Promise<R>) => MetadataContext.run("globex", fn);

describe("[Integration] SQLite: tenant_column on inheritance hierarchies", () => {
  let em: EntityManager;

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(HIERARCHIES, true);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("places the tenant column per strategy", async () => {
    expect(await columnsOf(em, "tci_doc")).toContain("tenant_id");
    expect(await columnsOf(em, "tci_review")).toEqual(["id", "reviewer"]);
    expect(await columnsOf(em, "tci_pay")).toContain("tenant_id");
    expect(await columnsOf(em, "tci_card")).toContain("tenant_id");
    expect(
      (await columnsOf(em, "tci_animal")).filter((c) => c === "tenant_id"),
    ).toHaveLength(1);
    const animal = await rawRows(em, `PRAGMA table_info("tci_animal")`);
    expect(animal.find((c) => c.name === "tenant_id").notnull).toBe(1);
  });

  describe("JOINED child", () => {
    let acmeId: number;
    let globexId: number;

    beforeEach(async () => {
      acmeId = (await acme(() =>
        em.save(TciReview, { title: "a", reviewer: "ann" } as any),
      )).id;
      globexId = (await globex(() =>
        em.save(TciReview, { title: "g", reviewer: "gus" } as any),
      )).id;
    });

    it("stamps the root row with the tenant", async () => {
      expect(
        await rawRows(em, `SELECT id, tenant_id FROM tci_doc ORDER BY id`),
      ).toEqual([
        { id: acmeId, tenant_id: "acme" },
        { id: globexId, tenant_id: "globex" },
      ]);
    });

    it("find / findOne / count / exists see the active tenant only", async () => {
      await acme(async () => {
        expect((await em.find(TciReview, {})).map((r) => r.reviewer)).toEqual(["ann"]);
        expect(await em.findOne(TciReview, { where: { id: globexId } as any })).toBeNull();
        expect(await em.count(TciReview)).toBe(1);
        expect(await em.exists(TciReview, { id: globexId } as any)).toBe(false);
        expect((await em.find(TciDoc, {})).map((r) => r.title)).toEqual(["a"]);
      });
    });

    it("the query builder is scoped", async () => {
      await acme(async () => {
        const rows = await em.createQueryBuilder(TciReview, "r").getMany();
        expect(rows.map((r) => r.reviewer)).toEqual(["ann"]);
        expect(await em.createQueryBuilder(TciReview, "r").getCount()).toBe(1);
      });
    });

    it("save() updates its own row and not another tenant's", async () => {
      await acme(async () => {
        await em.save(TciReview, { id: acmeId, title: "a2", reviewer: "ann2" } as any);
        await expect(
          em.save(TciReview, { id: globexId, title: "x", reviewer: "x" } as any),
        ).rejects.toThrow();
      });
      expect(await rawRows(em, `SELECT title FROM tci_doc ORDER BY id`)).toEqual([
        { title: "a2" },
        { title: "g" },
      ]);
      expect(await rawRows(em, `SELECT reviewer FROM tci_review ORDER BY id`)).toEqual([
        { reviewer: "ann2" },
        { reviewer: "gus" },
      ]);
    });

    it("delete() removes both rows of its own tenant only", async () => {
      await acme(async () => {
        expect((await em.delete(TciReview, { id: globexId } as any)).affected).toBe(0);
        expect((await em.delete(TciReview, { id: acmeId } as any)).affected).toBe(1);
      });
      expect(await rawRows(em, `SELECT id FROM tci_doc`)).toEqual([{ id: globexId }]);
      expect(await rawRows(em, `SELECT id FROM tci_review`)).toEqual([{ id: globexId }]);
    });
  });

  describe("TABLE_PER_CLASS child", () => {
    beforeEach(async () => {
      await acme(() => em.save(TciCard, { amount: 1, card: "a" } as any));
      await globex(() => em.save(TciCard, { amount: 2, card: "g" } as any));
    });

    it("stamps the concrete table", async () => {
      expect(
        await rawRows(em, `SELECT card, tenant_id FROM tci_card ORDER BY id`),
      ).toEqual([
        { card: "a", tenant_id: "acme" },
        { card: "g", tenant_id: "globex" },
      ]);
    });

    it("child reads, count, update and delete are scoped", async () => {
      await acme(async () => {
        expect((await em.find(TciCard, {})).map((r) => r.card)).toEqual(["a"]);
        expect(await em.count(TciCard)).toBe(1);
        expect(
          (await em.updateMany(TciCard, { amount: 9 } as any, { where: { amount: { gt: 0 } } as any })).affected,
        ).toBe(1);
        expect((await em.delete(TciCard, { amount: { gt: 0 } } as any)).affected).toBe(1);
      });
      expect(await rawRows(em, `SELECT card, amount FROM tci_card`)).toEqual([
        { card: "g", amount: 2 },
      ]);
    });

    it("the polymorphic root read returns the tenant's rows", async () => {
      await acme(async () => {
        const rows = await em.find(TciPay, {});
        expect(rows.map((r: any) => r.card)).toEqual(["a"]);
        expect(rows[0]).toBeInstanceOf(TciCard);
      });
    });
  });

  describe("SINGLE_TABLE child (control)", () => {
    it("shares the root's tenant column", async () => {
      await acme(() => em.save(TciDog, { name: "rex", breed: "lab" } as any));
      await globex(() => em.save(TciDog, { name: "max", breed: "pug" } as any));
      await acme(async () => {
        expect((await em.find(TciDog, {})).map((r) => r.name)).toEqual(["rex"]);
        expect((await em.find(TciAnimal, {})).map((r) => r.name)).toEqual(["rex"]);
        expect(await em.count(TciDog)).toBe(1);
      });
    });
  });
});

describe("[Integration] SQLite: injected tenant column does not outlive its connection", () => {
  beforeEach(() => MetadataContext.reset());

  it("a later connection without the strategy gets no tenant column", async () => {
    const tenantEm = await makeEm([TciShared], true);
    expect(await columnsOf(tenantEm, "tci_shared")).toContain("tenant_id");
    await tenantEm.propagateShutdown();

    const plainEm = await makeEm([TciShared], false);
    expect(await columnsOf(plainEm, "tci_shared")).toEqual(["id", "name"]);
    const saved = await plainEm.save(TciShared, { name: "x" } as any);
    expect(saved.name).toBe("x");
    await plainEm.propagateShutdown();
  });

  it("the column stays while another tenant connection still holds it", async () => {
    const first = await makeEm([TciShared], true);
    const second = await makeEm([TciShared], true);
    await first.propagateShutdown();
    await MetadataContext.run("acme", async () => {
      await second.save(TciShared, { name: "y" } as any);
      expect((await second.find(TciShared, {})).map((r) => r.name)).toEqual(["y"]);
    });
    expect(
      await rawRows(second, `SELECT tenant_id FROM tci_shared`),
    ).toEqual([{ tenant_id: "acme" }]);
    await second.propagateShutdown();

    const plainEm = await makeEm([TciShared], false);
    expect(await columnsOf(plainEm, "tci_shared")).toEqual(["id", "name"]);
    await plainEm.propagateShutdown();
  });

  it("re-registering under the strategy injects the column again", async () => {
    const a = await makeEm([TciShared], true);
    await a.propagateShutdown();
    const b = await makeEm([TciShared], true);
    expect(await columnsOf(b, "tci_shared")).toContain("tenant_id");
    await b.propagateShutdown();
  });
});

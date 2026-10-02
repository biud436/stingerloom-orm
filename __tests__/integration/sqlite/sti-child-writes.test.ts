/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: a SINGLE_TABLE child's writes stay on its own subtype's
 * rows.
 *
 * save() wrote the discriminator; no other INSERT path did. insertMany(),
 * insertManyAndReturn(), the saveMany() batch, upsert(), insertIgnore(),
 * batchUpsert() and createInsertBuilder() all died on the NOT NULL
 * discriminator column — for a child, for an STI root, and for a JOINED root.
 * With the column written, the upsert family's conflict branch would have
 * rewritten whatever row held the key, a sibling subtype's included.
 *
 * The key-based writes had the same hole: save() through a child rewrote a
 * sibling's row and returned null, deleteMany() deleted it, the update
 * builder updated it, and clear() emptied the whole shared table.
 *
 * Mirrored against MySQL/PostgreSQL by
 * __tests__/integration/inheritance/sti-child-writes.test.ts.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { Logger } from "../../../src/utils/Logger";
import sql from "../../../src/utils/sqlTag";

let seq = 0;

async function setup(extra: Record<string, unknown> = {}) {
  @Entity({ name: "scw_payment" })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "ptype", type: "varchar", length: 20 })
  class Payment {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "int" }) amount!: number;
  }

  @Entity()
  @DiscriminatorValue("card")
  class Card extends Payment {
    @Column({ type: "varchar", length: 20, nullable: true })
    cardNumber?: string | null;
  }

  @Entity()
  @DiscriminatorValue("bank")
  class Bank extends Payment {
    @Column({ type: "varchar", length: 20, nullable: true })
    iban?: string | null;
  }

  /** A natural key: both subtypes draw from the same key space. */
  @Entity({ name: "scw_doc" })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "dtype", type: "varchar", length: 20 })
  class Doc {
    @PrimaryColumn({ type: "varchar", length: 20 }) code!: string;
    @Column({ type: "varchar", length: 20 }) title!: string;
  }

  @Entity()
  @DiscriminatorValue("memo")
  class Memo extends Doc {}

  @Entity()
  @DiscriminatorValue("note")
  class Note extends Doc {}

  /** The root declares its discriminator as a column of its own. */
  @Entity({ name: "scw_shape" })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
  class Shape {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 20 }) kind!: string;
  }

  @Entity()
  @DiscriminatorValue("circle")
  class Circle extends Shape {}

  @Entity({ name: "scw_vehicle" })
  @Inheritance({ strategy: "JOINED" })
  class Vehicle {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "int" }) wheels!: number;
  }

  @Entity({ name: "scw_car" })
  @DiscriminatorValue("car")
  class Car extends Vehicle {
    @Column({ type: "int" }) seats!: number;
  }

  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: [Payment, Card, Bank, Doc, Memo, Note, Shape, Circle, Vehicle, Car],
      synchronize: true,
      logging: false,
      ...extra,
    } as any,
    `scw_${seq++}`,
  );
  return { em, Payment, Card, Bank, Doc, Memo, Note, Shape, Circle, Vehicle, Car };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function rows(em: EntityManager, table: string): Promise<any[]> {
  return (await em.query(`SELECT * FROM "${table}" ORDER BY 1`)) as any[];
}

describe("[Integration] SQLite: SINGLE_TABLE child writes stay on their subtype's rows", () => {
  let s: Setup;

  beforeEach(async () => {
    s = await setup();
  });

  afterEach(async () => {
    await s.em.propagateShutdown();
  });

  describe("every INSERT path writes the discriminator", () => {
    it.each([
      ["insertMany", (x: Setup) => x.em.insertMany(x.Card, [{ amount: 1 }, { amount: 2 }])],
      ["insertManyAndReturn", (x: Setup) => x.em.insertManyAndReturn(x.Card, [{ amount: 1 }, { amount: 2 }])],
      ["saveMany (batch)", (x: Setup) => x.em.saveMany(x.Card, [{ amount: 1 }, { amount: 2 }])],
      ["upsert", (x: Setup) => x.em.upsert(x.Card, { amount: 1 })],
      ["insertIgnore", (x: Setup) => x.em.insertIgnore(x.Card, { amount: 1 })],
      ["batchUpsert", (x: Setup) => x.em.batchUpsert(x.Card, [{ amount: 1 }, { amount: 2 }])],
      [
        "createInsertBuilder",
        (x: Setup) => x.em.createInsertBuilder(x.Card).values([{ amount: 1 }, { amount: 2 }]).execute(),
      ],
    ] as const)("%s", async (_name, write) => {
      await write(s);

      const stored = await rows(s.em, "scw_payment");
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((row) => row.ptype === "card")).toBe(true);
      expect(await s.em.find(s.Card, {})).toHaveLength(stored.length);
      expect(await s.em.find(s.Bank, {})).toHaveLength(0);
    });

    it("an STI root and a JOINED root write their own value, as save() does", async () => {
      await s.em.insertMany(s.Payment, [{ amount: 1 }]);
      await s.em.save(s.Payment, { amount: 2 });
      await s.em.insertMany(s.Vehicle, [{ wheels: 2 }]);
      await s.em.save(s.Vehicle, { wheels: 3 });

      expect((await rows(s.em, "scw_payment")).map((r) => r.ptype)).toEqual([
        "Payment",
        "Payment",
      ]);
      expect((await rows(s.em, "scw_vehicle")).map((r) => r.dtype)).toEqual([
        "Vehicle",
        "Vehicle",
      ]);
    });

    it("a discriminator the root declares as a column takes the entity's value whatever the row states", async () => {
      await s.em.save(s.Circle, { kind: "square" });
      await s.em.insertMany(s.Circle, [{ kind: "square" }, {}]);
      await s.em.upsert(s.Circle, { kind: "square" });

      expect((await rows(s.em, "scw_shape")).map((r) => r.kind)).toEqual([
        "circle",
        "circle",
        "circle",
        "circle",
      ]);
      expect(await s.em.find(s.Circle, {})).toHaveLength(4);
    });

    it("the saveMany() batch hands back the subtype's rows", async () => {
      const saved = await s.em.saveMany(s.Card, [{ amount: 1, cardNumber: "41" }]);
      expect(saved[0]).toBeInstanceOf(s.Card);
      expect(saved[0]).toMatchObject({ amount: 1, cardNumber: "41" });
    });
  });

  describe("the upsert family's conflict branch", () => {
    let bankId: number;
    let cardId: number;

    beforeEach(async () => {
      bankId = (await s.em.save(s.Bank, { amount: 10, iban: "x" })).id;
      cardId = (await s.em.save(s.Card, { amount: 20 })).id;
    });

    const amounts = async () =>
      (await rows(s.em, "scw_payment")).map((r) => [r.id, r.ptype, r.amount]);

    it("leaves a sibling subtype's row alone and reports it as not affected", async () => {
      expect(await s.em.upsert(s.Card, { id: bankId, amount: 99 })).toEqual({ affected: 0 });
      expect(
        await s.em.batchUpsert(s.Card, [
          { id: bankId, amount: 98 },
          { id: cardId, amount: 21 },
        ]),
      ).toEqual({ affected: 1 });
      expect(
        await s.em
          .createInsertBuilder(s.Card)
          .values([{ id: bankId, amount: 97 }])
          .doUpdate(["amount"])
          .execute(),
      ).toEqual({ affected: 0 });
      expect(await s.em.insertIgnore(s.Card, { id: bankId, amount: 96 })).toEqual({ affected: 0 });

      expect(await amounts()).toEqual([
        [bankId, "bank", 10],
        [cardId, "card", 21],
      ]);
    });

    it("still updates the subtype's own row", async () => {
      await s.em.upsert(s.Card, { id: cardId, amount: 22, cardNumber: "41" });
      expect(await s.em.findOne(s.Card, { where: { id: cardId } })).toMatchObject({
        amount: 22,
        cardNumber: "41",
      });
    });

    it("through the root, updates any subtype's row and keeps its subtype", async () => {
      await s.em.upsert(s.Payment, { id: bankId, amount: 11 });
      expect(await amounts()).toEqual([
        [bankId, "bank", 11],
        [cardId, "card", 20],
      ]);
    });

    it("guards a natural key shared by the subtypes", async () => {
      await s.em.save(s.Memo, { code: "k1", title: "memo" });

      expect(await s.em.upsert(s.Note, { code: "k1", title: "note" })).toEqual({ affected: 0 });
      expect(await rows(s.em, "scw_doc")).toEqual([{ code: "k1", title: "memo", dtype: "memo" }]);
    });

    it("warns once per entity class when a sibling's row was skipped", async () => {
      const warn = jest.spyOn((s.em as any).logger as Logger, "warn").mockImplementation(() => {});
      await s.em.upsert(s.Card, { id: bankId, amount: 99 });
      await s.em.upsert(s.Card, { id: bankId, amount: 98 });

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages.filter((m) => m.includes("another subtype"))).toEqual([
        expect.stringContaining(`upsert on 'Card' skipped at least one row`),
      ]);
      expect(messages[0]).toContain(`its ptype is not 'card'`);
      warn.mockRestore();
    });

    it("guards the statement build() shows", () => {
      const statement = s.em
        .createInsertBuilder(s.Card)
        .values([{ id: bankId, amount: 1 }])
        .doUpdate(["amount"])
        .build();
      expect(statement.text).toMatch(/DO UPDATE SET .* WHERE "scw_payment"."ptype" = \$\d+$/);
      expect(statement.values).toContain("card");
    });
  });

  describe("the key-based writes", () => {
    let bankId: number;
    let cardId: number;

    beforeEach(async () => {
      bankId = (await s.em.save(s.Bank, { amount: 10, iban: "x" })).id;
      cardId = (await s.em.save(s.Card, { amount: 20 })).id;
    });

    const bankRow = async () =>
      (await rows(s.em, "scw_payment")).find((r) => r.id === bankId);

    it("save() rejects a sibling's key as not found", async () => {
      let error: unknown;
      try {
        await s.em.save(s.Card, { id: bankId, amount: 55 });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(String((error as Error).message)).toContain("as a 'Card' row");
      expect(await bankRow()).toMatchObject({ ptype: "bank", amount: 10 });
    });

    it("the saveMany() fallback rejects it too, and rolls back the batch", async () => {
      let error: unknown;
      try {
        await s.em.saveMany(s.Card, [
          { id: cardId, amount: 21 },
          { id: bankId, amount: 56 },
        ]);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EntityNotFoundError);
      expect(await bankRow()).toMatchObject({ ptype: "bank", amount: 10 });
      expect(await s.em.findOne(s.Card, { where: { id: cardId } })).toMatchObject({ amount: 20 });
    });

    it("save() still updates the subtype's own row", async () => {
      const saved = await s.em.save(s.Card, { id: cardId, amount: 21 });
      expect(saved).toMatchObject({ id: cardId, amount: 21 });
    });

    it("deleteMany() deletes only the subtype's rows", async () => {
      expect(await s.em.deleteMany(s.Card, [bankId, cardId])).toEqual({ affected: 1 });
      expect((await rows(s.em, "scw_payment")).map((r) => r.id)).toEqual([bankId]);
    });

    it("the update builder updates only the subtype's rows", async () => {
      const updated = await s.em
        .createUpdateBuilder(s.Card)
        .set({ amount: 50 })
        .where(sql`"id" IN (${bankId}, ${cardId})`)
        .execute();
      expect(updated).toEqual({ affected: 1 });
      expect(await bankRow()).toMatchObject({ amount: 10 });
    });

    it("clear() empties only the subtype's rows; the root still empties the table", async () => {
      await s.em.clear(s.Card);
      expect((await rows(s.em, "scw_payment")).map((r) => r.ptype)).toEqual(["bank"]);

      await s.em.clear(s.Payment);
      expect(await rows(s.em, "scw_payment")).toEqual([]);
    });
  });
});

describe("[Integration] SQLite: SINGLE_TABLE child upserts under tenant_column", () => {
  let s: Setup;
  const acme = <R>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
  const globex = <R>(fn: () => Promise<R>) => MetadataContext.run("globex", fn);

  beforeEach(async () => {
    MetadataContext.reset();
    s = await setup({ tenantStrategy: "tenant_column" });
  });

  afterEach(async () => {
    await s.em.propagateShutdown();
  });

  it("the conflict branch needs both the tenant and the subtype to match", async () => {
    const acmeBank = (await acme(() => s.em.save(s.Bank, { amount: 10 }))).id;
    const globexCard = (await globex(() => s.em.save(s.Card, { amount: 20 }))).id;
    const acmeCard = (await acme(() => s.em.save(s.Card, { amount: 30 }))).id;

    const warn = jest.spyOn((s.em as any).logger as Logger, "warn").mockImplementation(() => {});
    const result = await acme(() =>
      s.em.batchUpsert(s.Card, [
        { id: acmeBank, amount: 1 },
        { id: globexCard, amount: 2 },
        { id: acmeCard, amount: 3 },
      ]),
    );
    expect(result).toEqual({ affected: 1 });
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("belongs to another tenant, or to another subtype"),
    ]);
    warn.mockRestore();

    expect(
      (await rows(s.em, "scw_payment")).map((r) => [r.id, r.tenant_id, r.ptype, r.amount]),
    ).toEqual([
      [acmeBank, "acme", "bank", 10],
      [globexCard, "globex", "card", 20],
      [acmeCard, "acme", "card", 3],
    ]);
  });

  it("insertMany() writes both the tenant and the discriminator", async () => {
    await acme(() => s.em.insertMany(s.Card, [{ amount: 1 }]));
    expect((await rows(s.em, "scw_payment")).map((r) => [r.tenant_id, r.ptype])).toEqual([
      ["acme", "card"],
    ]);
  });
});

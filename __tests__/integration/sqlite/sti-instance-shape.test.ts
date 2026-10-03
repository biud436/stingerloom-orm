/**
 * A SINGLE_TABLE instance holds the columns of its own class — whichever
 * path built it.
 *
 * A single-table row carries every subtype's columns and the discriminator.
 * `find(Child)` selects only the child's columns, but the other paths read
 * the whole row: the `RETURNING *` of `save()` / `insertManyAndReturn()` /
 * the `saveMany()` batch, a polymorphic `find(Root)`, the query builder's
 * `getMany()` on the root or a child, `prepare()`, and a cursor page of the
 * root (which also built every row as the root class). Their instances
 * carried the discriminator (`ptype: "card"`) and every sibling's column as
 * `null` — against docs/inheritance-sti.md, which shows neither.
 *
 * Every case compares an instance's keys with the keys `find(Class)` gives
 * an instance of that class. A discriminator declared as a `@Column` stays.
 *
 * PG / MariaDB: __tests__/integration/sti-instance-shape.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "sis_stores" })
class SisStore {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) name!: string;
}

@Entity({ name: "sis_payments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype", type: "varchar", length: 20 })
class SisPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
  @ManyToOne(() => SisStore, (s: SisStore) => s.id)
  @RelationColumn({ name: "store_id", nullable: true })
  store!: Relation<SisStore> | null;
}

@Entity()
@DiscriminatorValue("card")
class SisCard extends SisPayment {
  @Column({ type: "varchar", length: 20, nullable: true }) last4!: string;
}

@Entity()
@DiscriminatorValue("bank")
class SisBank extends SisPayment {
  @Column({ type: "varchar", length: 20, nullable: true }) iban!: string;
}

// Discriminator declared as a column of the root: it is data here, and stays.
@Entity({ name: "sis_shapes" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
class SisShape {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20, nullable: true }) kind!: string;
}

@Entity()
@DiscriminatorValue("circle")
class SisCircle extends SisShape {
  @Column({ type: "int", nullable: true }) radius!: number;
}

@Entity()
@DiscriminatorValue("square")
class SisSquare extends SisShape {
  @Column({ type: "int", nullable: true }) side!: number;
}

const keysOf = (value: object) => Object.keys(value).sort();

describe("[Integration] SQLite: SINGLE_TABLE instances hold their own class's columns", () => {
  let em: EntityManager;
  let storeId: number;
  const expected: Record<string, string[]> = {};

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [SisStore, SisPayment, SisCard, SisBank, SisShape, SisCircle, SisSquare],
    });
    storeId = (await em.save(SisStore, { name: "s" })).id;
    await em.save(SisCard, { amount: 1, last4: "4242", store: { id: storeId } } as any);
    await em.save(SisBank, { amount: 2, iban: "DE1", store: { id: storeId } } as any);
    await em.save(SisPayment, { amount: 3, store: { id: storeId } } as any);
    for (const [cls, name] of [
      [SisCard, "SisCard"],
      [SisBank, "SisBank"],
    ] as const) {
      const [row] = await em.find(cls as any, {});
      expected[name] = keysOf(row as object);
    }
    expected.SisPayment = ["amount", "id", "storeId"];
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("find(Child) is the reference shape: own and inherited columns, no discriminator", () => {
    expect(expected.SisCard).toEqual(["amount", "id", "last4", "storeId"]);
    expect(expected.SisBank).toEqual(["amount", "iban", "id", "storeId"]);
  });

  describe("writes return that shape", () => {
    it("save() INSERT and UPDATE", async () => {
      const inserted = await em.save(SisCard, { amount: 5, last4: "1111" } as any);
      expect(keysOf(inserted)).toEqual(expect.arrayContaining(["amount", "id", "last4"]));
      expect(keysOf(inserted)).not.toEqual(expect.arrayContaining(["ptype"]));
      expect(keysOf(inserted)).not.toEqual(expect.arrayContaining(["iban"]));
      const updated = await em.save(SisCard, { id: inserted.id, amount: 6, last4: "1111" } as any);
      expect(keysOf(updated)).not.toEqual(expect.arrayContaining(["ptype"]));
      expect(keysOf(updated)).not.toEqual(expect.arrayContaining(["iban"]));
    });

    it("insertManyAndReturn() and the saveMany() batch", async () => {
      const rows = [
        ...(await em.insertManyAndReturn(SisBank, [{ amount: 7, iban: "FR1" }] as any)),
        ...(await em.saveMany(SisBank, [{ amount: 8, iban: "FR2" }, { amount: 9, iban: "FR3" }] as any)),
      ];
      for (const row of rows) {
        expect(row).toBeInstanceOf(SisBank);
        expect(Object.keys(row)).not.toContain("ptype");
        expect(Object.keys(row)).not.toContain("last4");
        expect((row as any).iban).toMatch(/^FR/);
      }
    });
  });

  describe("polymorphic reads build each row as its subclass, in its shape", () => {
    const byClass = (rows: object[]) => {
      const seen: Record<string, string[]> = {};
      for (const row of rows) seen[row.constructor.name] = keysOf(row);
      return seen;
    };

    it("find(Root)", async () => {
      const rows = await em.find(SisPayment, { where: { amount: { lte: 3 } } });
      expect(byClass(rows)).toEqual(expected);
    });

    it("find(Root) with a JOINed relation keeps the relation", async () => {
      const rows = await em.find(SisPayment, { where: { amount: { lte: 3 } }, relations: ["store"] });
      for (const row of rows) expect(row.store?.name).toBe("s");
      expect(Object.keys(rows[0])).not.toContain("ptype");
    });

    it("findWithCursor(Root)", async () => {
      const page = await em.findWithCursor(SisPayment, { where: { amount: { lte: 3 } }, take: 10 });
      expect(page.data.map((row) => row.constructor.name).sort()).toEqual(["SisBank", "SisCard", "SisPayment"]);
      expect(byClass(page.data)).toEqual(expected);
    });

    it("the query builder: getMany() on the root and a child, prepare()", async () => {
      const root = await em.createQueryBuilder(SisPayment, "p").where("p.amount", "<=", 3).getMany();
      expect(byClass(root)).toEqual(expected);

      const cards = await em.createQueryBuilder(SisCard, "c").where("c.amount", "<=", 3).getMany();
      expect(byClass(cards)).toEqual({ SisCard: expected.SisCard });

      const prepared = await em
        .createQueryBuilder(SisPayment, "p")
        .where("p.amount", "<=", 3)
        .prepare()
        .execute({});
      expect(byClass(prepared as object[])).toEqual(expected);
    });
  });

  it("keeps a discriminator declared as a column", async () => {
    await em.save(SisCircle, { radius: 2 } as any);
    await em.save(SisSquare, { side: 3 } as any);
    const shapes = await em.find(SisShape, {});
    const circle = shapes.find((s) => s instanceof SisCircle)!;
    expect(circle).toMatchObject({ kind: "circle", radius: 2 });
    expect(Object.keys(circle)).not.toContain("side");
    const saved = await em.save(SisSquare, { side: 4 } as any);
    expect(saved).toMatchObject({ kind: "square", side: 4 });
    expect(Object.keys(saved)).not.toContain("radius");
  });
});

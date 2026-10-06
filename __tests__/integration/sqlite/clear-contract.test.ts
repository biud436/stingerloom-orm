/**
 * em.clear(Entity) deletes every row of the entity the caller can see, with
 * DELETE in the caller's transaction, and writes no other table.
 *
 * It used to hand the table to the driver's own reset statement, outside
 * the transaction and the tenant scope: PostgreSQL also emptied every table
 * that referenced the cleared one, MySQL left the referencing rows pointing
 * at nothing, SQLite failed on them; a `tenant_column` entity lost every
 * tenant's rows; a JOINED child left its root rows behind, a JOINED root
 * failed on its children's keys, and a TABLE_PER_CLASS root kept its
 * subclasses' rows.
 *
 * Real PostgreSQL / MySQL: __tests__/integration/clear-contract.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Relation } from "../../../src/types/Relation";
import { EntityManager } from "../../../src/core/EntityManager";
import { MetadataContext } from "../../../src/metadata/MetadataContext";

@Entity({ name: "clr_owners" })
class ClrOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => ClrPet, { mappedBy: "owner" }) pets!: ClrPet[];
  @OneToMany(() => ClrToy, { mappedBy: "owner" }) toys!: ClrToy[];
}

/** References owners with the default ON DELETE (NO ACTION). */
@Entity({ name: "clr_pets" })
class ClrPet {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @ManyToOne(() => ClrOwner, (o: ClrOwner) => o.pets)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<ClrOwner> | null;
  @DeletedAt() deletedAt!: Date | null;
}

/** References owners with ON DELETE CASCADE. */
@Entity({ name: "clr_toys" })
class ClrToy {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @ManyToOne(() => ClrOwner, (o: ClrOwner) => o.toys, { onDelete: "CASCADE" })
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<ClrOwner> | null;
}

@Entity({ name: "clr_docs" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class ClrDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
}

@Entity({ name: "clr_reviews" })
@DiscriminatorValue("review")
class ClrReview extends ClrDoc {
  @Column({ type: "varchar", length: 40 }) reviewer!: string;
}

@Entity({ name: "clr_memos" })
@DiscriminatorValue("memo")
class ClrMemo extends ClrDoc {
  @Column({ type: "varchar", length: 40 }) note!: string;
}

@Entity({ name: "clr_pays" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class ClrPay {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) amount!: number;
}

@Entity({ name: "clr_cards" })
@DiscriminatorValue("card")
class ClrCard extends ClrPay {
  @Column({ type: "varchar", length: 4 }) last4!: string;
}

@Entity({ name: "clr_orders" })
class ClrOrder {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) slug!: string;
}

async function register(entities: Array<new () => any>, extra: Record<string, unknown> = {}) {
  const em = new EntityManager();
  await em.register(
    { type: "sqlite", database: ":memory:", entities, synchronize: true, logging: false, ...extra } as any,
    `clr_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

const countOf = async (em: EntityManager, table: string): Promise<number> => {
  const rows = (await em.query(`SELECT COUNT(*) AS n FROM "${table}"`)) as Array<{ n: number }>;
  return Number(rows[0].n);
};

describe("[Integration] SQLite: em.clear()", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = await register([ClrOwner, ClrPet, ClrToy, ClrDoc, ClrReview, ClrMemo, ClrPay, ClrCard]);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("deletes every row, soft-deleted ones included, and does not restart the identity", async () => {
    const a = await em.save(ClrPet, { name: "a" });
    const b = await em.save(ClrPet, { name: "b" });
    await em.softDelete(ClrPet, { id: b.id });

    await em.clear(ClrPet);

    expect(await countOf(em, "clr_pets")).toBe(0);
    const next = await em.save(ClrPet, { name: "c" });
    expect(next.id).toBeGreaterThan(Math.max(a.id, b.id));
  });

  it("fails without deleting anything when referencing rows keep the default ON DELETE", async () => {
    const owner = await em.save(ClrOwner, { name: "alice" });
    await em.save(ClrPet, { name: "rex", owner });

    let error: unknown;
    try {
      await em.clear(ClrOwner);
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/FOREIGN KEY constraint failed/);
    expect(await countOf(em, "clr_owners")).toBe(1);
    expect(await countOf(em, "clr_pets")).toBe(1);

    await em.clear(ClrPet);
    await em.clear(ClrOwner);
    expect(await countOf(em, "clr_owners")).toBe(0);
  });

  it("applies a declared ON DELETE CASCADE to the referencing rows", async () => {
    const owner = await em.save(ClrOwner, { name: "alice" });
    await em.save(ClrToy, { name: "ball", owner });

    await em.clear(ClrOwner);

    expect(await countOf(em, "clr_owners")).toBe(0);
    expect(await countOf(em, "clr_toys")).toBe(0);
  });

  it("is rolled back with the caller's transaction", async () => {
    await em.save(ClrPet, { name: "a" });

    await expect(
      em.transaction(async (tx) => {
        await tx.clear(ClrPet);
        expect(await tx.count(ClrPet)).toBe(0);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect(await countOf(em, "clr_pets")).toBe(1);
  });

  it("deletes a JOINED child's rows from its table and the root's, leaving its siblings", async () => {
    await em.save(ClrReview, { title: "r", reviewer: "x" });
    await em.save(ClrMemo, { title: "m", note: "y" });

    await em.clear(ClrReview);

    expect(await countOf(em, "clr_reviews")).toBe(0);
    expect(await countOf(em, "clr_memos")).toBe(1);
    expect((await em.find(ClrDoc)).map((d) => d.constructor)).toEqual([ClrMemo]);
  });

  it("deletes a JOINED root's rows from every table of the hierarchy", async () => {
    await em.save(ClrReview, { title: "r", reviewer: "x" });
    await em.save(ClrMemo, { title: "m", note: "y" });
    await em.save(ClrDoc, { title: "plain" });

    await em.clear(ClrDoc);

    expect(await countOf(em, "clr_docs")).toBe(0);
    expect(await countOf(em, "clr_reviews")).toBe(0);
    expect(await countOf(em, "clr_memos")).toBe(0);
  });

  it("deletes a TABLE_PER_CLASS root's rows from every concrete table, and a child's from its own", async () => {
    await em.save(ClrPay, { amount: 1 });
    await em.save(ClrCard, { amount: 2, last4: "1234" });

    await em.clear(ClrCard);
    expect(await countOf(em, "clr_cards")).toBe(0);
    expect(await countOf(em, "clr_pays")).toBe(1);

    await em.save(ClrCard, { amount: 3, last4: "5678" });
    await em.clear(ClrPay);
    expect(await countOf(em, "clr_pays")).toBe(0);
    expect(await countOf(em, "clr_cards")).toBe(0);
  });

  it("drops a cached read of the cleared rows", async () => {
    await em.save(ClrPet, { name: "a" });
    expect(await em.find(ClrPet, { cache: true })).toHaveLength(1);

    await em.clear(ClrPet);

    expect(await em.find(ClrPet, { cache: true })).toHaveLength(0);
  });
});

describe("[Integration] SQLite: em.clear() under tenant_column", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = await register([ClrOrder], { tenantStrategy: "tenant_column" });
    await MetadataContext.run("globex", () => em.save(ClrOrder, { slug: "g" }));
    await MetadataContext.run("acme", () => em.save(ClrOrder, { slug: "a" }));
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const slugs = async () =>
    MetadataContext.runUnscoped(async () =>
      ((await em.query(`SELECT slug FROM "clr_orders" ORDER BY slug`)) as Array<{ slug: string }>).map(
        (r) => r.slug,
      ),
    );

  it("deletes the current tenant's rows only", async () => {
    await MetadataContext.run("acme", () => em.clear(ClrOrder));
    expect(await slugs()).toEqual(["g"]);
  });

  it("deletes every tenant's rows when the caller leaves the tenant scope", async () => {
    await MetadataContext.runUnscoped(() => em.clear(ClrOrder));
    expect(await slugs()).toEqual([]);
  });
});

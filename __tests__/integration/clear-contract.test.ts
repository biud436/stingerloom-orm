/**
 * em.clear(Entity) on a real PostgreSQL / MySQL (MariaDB): DELETE of the
 * rows the caller can see, in the caller's transaction, writing no other
 * table. Before, PostgreSQL ran `TRUNCATE ... RESTART IDENTITY CASCADE` —
 * which also emptied every table referencing the cleared one and restarted
 * its sequence — and MySQL a `TRUNCATE` with foreign key checks off, which
 * left the referencing rows pointing at nothing; both outside the caller's
 * transaction and tenant scope.
 *
 * SQLite: __tests__/integration/sqlite/clear-contract.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql, qi } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  DeletedAt,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

async function errorOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe.each(getTestDrivers())(
  "[Integration] $label: em.clear()",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      owner: shortName("clro"),
      pet: shortName("clrp"),
      toy: shortName("clrt"),
      doc: shortName("clrd"),
      review: shortName("clrr"),
      memo: shortName("clrm"),
      pay: shortName("clry"),
      card: shortName("clrc"),
    };

    const countOf = async (table: string): Promise<number> => {
      const result: any = await rawQuery(`SELECT COUNT(*) AS n FROM ${qi(type, table)}`);
      const rows = Array.isArray(result) ? result : (result?.rows ?? []);
      return Number(rows[0].n);
    };

    // Referencing tables first, so no foreign key check needs switching off.
    const wipe = async () => {
      for (const table of [t.pet, t.toy, t.owner, t.review, t.memo, t.doc, t.card, t.pay]) {
        await rawQuery(`DELETE FROM ${qi(type, table)}`);
      }
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.owner })
          class Owner {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @OneToMany(() => Pet, { mappedBy: "owner" }) pets!: any[];
            @OneToMany(() => Toy, { mappedBy: "owner" }) toys!: any[];
          }

          @Entity({ name: t.pet })
          class Pet {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @ManyToOne(() => Owner, (o: any) => o.pets)
            @RelationColumn({ name: "owner_id", nullable: true })
            owner!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.toy })
          class Toy {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @ManyToOne(() => Owner, (o: any) => o.toys, { onDelete: "CASCADE" })
            @RelationColumn({ name: "owner_id", nullable: true })
            owner!: any;
          }

          @Entity({ name: t.doc })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "dtype" })
          class Doc {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
          }

          @Entity({ name: t.review })
          @DiscriminatorValue("review")
          class Review extends Doc {
            @Column({ type: "varchar", length: 40 }) reviewer!: string;
          }

          @Entity({ name: t.memo })
          @DiscriminatorValue("memo")
          class Memo extends Doc {
            @Column({ type: "varchar", length: 40 }) note!: string;
          }

          @Entity({ name: t.pay })
          @Inheritance({ strategy: "TABLE_PER_CLASS" })
          class Pay {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) amount!: number;
          }

          @Entity({ name: t.card })
          @DiscriminatorValue("card")
          class Card extends Pay {
            @Column({ type: "varchar", length: 4 }) last4!: string;
          }

          E = { Owner, Pet, Toy, Doc, Review, Memo, Pay, Card };
          return { entities: Object.values(E) };
        },
      );
      em = conn.em;
    }, 60000);

    beforeEach(wipe);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const table of [t.pet, t.toy, t.owner, t.review, t.memo, t.doc, t.card, t.pay]) {
          await dropTestTable(table);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("deletes every row, soft-deleted ones included, and does not restart the identity", async () => {
      const a = await em.save(E.Pet, { name: "a" });
      const b = await em.save(E.Pet, { name: "b" });
      await em.softDelete(E.Pet, { id: b.id });

      await em.clear(E.Pet);

      expect(await countOf(t.pet)).toBe(0);
      const next = await em.save(E.Pet, { name: "c" });
      expect(next.id).toBeGreaterThan(Math.max(a.id, b.id));
    });

    it("fails without deleting anything when referencing rows keep the default ON DELETE", async () => {
      const owner = await em.save(E.Owner, { name: "alice" });
      await em.save(E.Pet, { name: "rex", owner });

      expect(String(await errorOf(() => em.clear(E.Owner)))).toMatch(/foreign key/i);
      expect(await countOf(t.owner)).toBe(1);
      expect(await countOf(t.pet)).toBe(1);

      await em.clear(E.Pet);
      await em.clear(E.Owner);
      expect(await countOf(t.owner)).toBe(0);
    });

    it("applies a declared ON DELETE CASCADE to the referencing rows", async () => {
      const owner = await em.save(E.Owner, { name: "alice" });
      await em.save(E.Toy, { name: "ball", owner });

      await em.clear(E.Owner);

      expect(await countOf(t.owner)).toBe(0);
      expect(await countOf(t.toy)).toBe(0);
    });

    it("is rolled back with the caller's transaction", async () => {
      await em.save(E.Pet, { name: "a" });

      const error = await errorOf(() =>
        em.transaction(async (tx) => {
          await tx.clear(E.Pet);
          expect(await tx.count(E.Pet)).toBe(0);
          throw new Error("abort");
        }),
      );

      expect(String(error)).toMatch(/abort/);
      expect(await countOf(t.pet)).toBe(1);
    });

    it("deletes a JOINED child's rows from both tables and a JOINED root's from every table", async () => {
      await em.save(E.Review, { title: "r", reviewer: "x" });
      await em.save(E.Memo, { title: "m", note: "y" });
      await em.save(E.Doc, { title: "plain" });

      await em.clear(E.Review);
      expect([await countOf(t.doc), await countOf(t.review), await countOf(t.memo)]).toEqual([2, 0, 1]);

      await em.clear(E.Doc);
      expect([await countOf(t.doc), await countOf(t.review), await countOf(t.memo)]).toEqual([0, 0, 0]);
    });

    it("deletes a TABLE_PER_CLASS root's rows from every concrete table", async () => {
      await em.save(E.Pay, { amount: 1 });
      await em.save(E.Card, { amount: 2, last4: "1234" });

      await em.clear(E.Pay);

      expect([await countOf(t.pay), await countOf(t.card)]).toEqual([0, 0]);
    });
  },
);

describe.each(getTestDrivers())(
  "[Integration] $label: em.clear() under tenant_column",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Order: new () => any;
    const table = shortName("clrn");

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options, tenantStrategy: "tenant_column" },
        () => {
          @Entity({ name: table })
          class TenantOrder {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) slug!: string;
          }
          Order = TenantOrder;
          return { entities: [TenantOrder] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("deletes the current tenant's rows only", async () => {
      await MetadataContext.run("globex", () => em.save(Order, { slug: "g" }));
      await MetadataContext.run("acme", () => em.save(Order, { slug: "a" }));

      await MetadataContext.run("acme", () => em.clear(Order));

      const result: any = await rawQuery(`SELECT slug FROM ${qi(type, table)} ORDER BY slug`);
      const rows = Array.isArray(result) ? result : (result?.rows ?? []);
      expect(rows.map((r: any) => r.slug)).toEqual(["g"]);
    });
  },
);

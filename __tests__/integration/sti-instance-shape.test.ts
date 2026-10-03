/**
 * SINGLE_TABLE instances hold their own class's columns on a real
 * PostgreSQL / MySQL (MariaDB). PostgreSQL returns `RETURNING *` rows for
 * INSERT and UPDATE, MariaDB for INSERT only (MySQL re-reads), so the write
 * paths read the whole single-table row on one and not the other — both must
 * come back in the shape `find(Class)` gives.
 *
 * SQLite: __tests__/integration/sqlite/sti-instance-shape.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: SINGLE_TABLE instances hold their own class's columns",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const table = shortName("sisp");

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: table })
          @Inheritance({ strategy: "SINGLE_TABLE" })
          @DiscriminatorColumn({ name: "ptype", type: "varchar", length: 20 })
          class Payment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) amount!: number;
          }

          @Entity()
          @DiscriminatorValue("card")
          class Card extends Payment {
            @Column({ type: "varchar", length: 20, nullable: true }) last4!: string;
          }

          @Entity()
          @DiscriminatorValue("bank")
          class Bank extends Payment {
            @Column({ type: "varchar", length: 20, nullable: true }) iban!: string;
          }

          E = { Payment, Card, Bank };
          return { entities: [Payment, Card, Bank] };
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

    const keysOf = (value: object) => Object.keys(value).sort();

    it("returns writes in the class's shape", async () => {
      const card = await em.save(E.Card, { amount: 1, last4: "4242" });
      expect(keysOf(card)).toEqual(["amount", "id", "last4"]);
      const updated = await em.save(E.Card, { id: card.id, amount: 2, last4: "4242" });
      expect(keysOf(updated)).toEqual(["amount", "id", "last4"]);
      // insertManyAndReturn() needs INSERT ... RETURNING, which the MySQL
      // family path does not offer.
      if (type === "postgres") {
        const [bank] = await em.insertManyAndReturn(E.Bank, [{ amount: 3, iban: "DE1" }]);
        expect(keysOf(bank)).toEqual(["amount", "iban", "id"]);
      }
      const batch = await em.saveMany(E.Bank, [{ amount: 4, iban: "DE2" }, { amount: 5, iban: "DE3" }]);
      expect(batch.map(keysOf)).toEqual([
        ["amount", "iban", "id"],
        ["amount", "iban", "id"],
      ]);
    });

    it("builds a polymorphic root read's rows as their subclasses, in their shape", async () => {
      await em.save(E.Payment, { amount: 6 });
      const shapes = new Map<string, string[]>();
      for (const row of await em.find(E.Payment, {})) shapes.set(row.constructor.name, keysOf(row));
      expect(Object.fromEntries(shapes)).toEqual({
        Card: ["amount", "id", "last4"],
        Bank: ["amount", "iban", "id"],
        Payment: ["amount", "id"],
      });
      const page = await em.findWithCursor(E.Payment, { take: 20 });
      expect(new Set(page.data.map((row: any) => row.constructor.name))).toEqual(new Set(["Card", "Bank", "Payment"]));
    });
  },
);

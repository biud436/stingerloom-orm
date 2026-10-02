/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A SINGLE_TABLE child's writes stay on its own subtype's rows against real
 * servers (MySQL/MariaDB + PostgreSQL): every batch and upsert INSERT writes
 * the discriminator, a conflicting key held by a sibling's row is never
 * rewritten, and the key-based writes cannot reach a sibling's row.
 *
 * Mirrors __tests__/integration/sqlite/sti-child-writes.test.ts. The
 * dialect-specific parts are the conflict branch (ON CONFLICT … WHERE vs
 * MySQL's per-assignment IF()), clear() (TRUNCATE on these servers) and the
 * WriteBuffer's multi-row INSERT, which SQLite never takes.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
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
import { EntityNotFoundError } from "../../../src/errors/EntityNotFoundError";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import sql, { raw } from "../../../src/utils/sqlTag";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "../helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  payment: "sti_cw_payment",
  vehicle: "sti_cw_vehicle",
  car: "sti_cw_car",
} as const;
/** Children before parents, so the foreign keys never block a DELETE / DROP. */
const TEARDOWN_ORDER = [TABLES.car, TABLES.vehicle, TABLES.payment];

describe.each(drivers)(
  "[Integration][$label] SINGLE_TABLE child writes stay on their subtype's rows",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let PaymentE: new () => any;
    let CardE: new () => any;
    let BankE: new () => any;
    let CarE: new () => any;

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, plugins: [bufferPlugin({ batchInsert: true })] },
        () => {
          @Entity({ name: TABLES.payment })
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

          @Entity({ name: TABLES.vehicle })
          @Inheritance({ strategy: "JOINED" })
          class Vehicle {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) wheels!: number;
          }

          @Entity({ name: TABLES.car })
          @DiscriminatorValue("car")
          class Car extends Vehicle {
            @Column({ type: "int" }) seats!: number;
          }

          PaymentE = Payment;
          CardE = Card;
          BankE = Bank;
          CarE = Car;
          return { entities: [Payment, Card, Bank, Vehicle, Car] };
        },
      );
      em = conn.em as EntityManager;
    }, 60000);

    afterAll(async () => {
      for (const t of TEARDOWN_ORDER) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const t of TEARDOWN_ORDER) {
        await rawQuery(`DELETE FROM ${q(t)}`);
      }
    });

    async function stored(): Promise<Array<{ id: number; ptype: string; amount: number }>> {
      const rows = (await em.query(
        `SELECT ${q("id")}, ${q("ptype")}, ${q("amount")} FROM ${q(TABLES.payment)} ORDER BY ${q("id")}`,
      )) as any[];
      return rows.map((row) => ({
        id: Number(row.id),
        ptype: row.ptype,
        amount: Number(row.amount),
      }));
    }

    it("every batch and upsert INSERT writes the subtype's discriminator", async () => {
      await em.insertMany(CardE, [{ amount: 1 }, { amount: 2 }]);
      await em.saveMany(CardE, [{ amount: 3 }, { amount: 4 }]);
      await em.upsert(CardE, { amount: 5 });
      await em.insertIgnore(CardE, { amount: 6 });
      await em.batchUpsert(CardE, [{ amount: 7 }]);
      await em.createInsertBuilder(CardE).values([{ amount: 8 }]).execute();
      await em.insertMany(PaymentE, [{ amount: 9 }]);

      expect((await stored()).map((row) => [row.amount, row.ptype])).toEqual([
        [1, "card"],
        [2, "card"],
        [3, "card"],
        [4, "card"],
        [5, "card"],
        [6, "card"],
        [7, "card"],
        [8, "card"],
        [9, "Payment"],
      ]);
      expect(await em.find(CardE, {})).toHaveLength(8);
      expect(await em.find(BankE, {})).toHaveLength(0);
    });

    it("insertManyAndReturn() writes the discriminator where it is supported", async () => {
      if (type !== "postgres") return;
      const [card] = await em.insertManyAndReturn(CardE, [{ amount: 1 }]);
      expect(card).toBeInstanceOf(CardE);
      expect(await stored()).toEqual([{ id: Number(card.id), ptype: "card", amount: 1 }]);
    });

    it("the upsert family's conflict branch leaves a sibling subtype's row alone", async () => {
      const bank = await em.save(BankE, { amount: 10, iban: "x" });
      const card = await em.save(CardE, { amount: 20 });

      await em.upsert(CardE, { id: bank.id, amount: 99 });
      await em.batchUpsert(CardE, [{ id: bank.id, amount: 98 }]);
      await em.insertIgnore(CardE, { id: bank.id, amount: 97 });
      await em
        .createInsertBuilder(CardE)
        .values([{ id: bank.id, amount: 96 }])
        .doUpdate(["amount"])
        .execute();
      // The subtype's own row still takes the conflict branch.
      await em.upsert(CardE, { id: card.id, amount: 21 });

      expect(await stored()).toEqual([
        { id: Number(bank.id), ptype: "bank", amount: 10 },
        { id: Number(card.id), ptype: "card", amount: 21 },
      ]);
    });

    it("save() through a subtype rejects a sibling's key", async () => {
      const bank = await em.save(BankE, { amount: 10, iban: "x" });

      await expect(em.save(CardE, { id: bank.id, amount: 55 })).rejects.toBeInstanceOf(
        EntityNotFoundError,
      );
      expect(await stored()).toEqual([{ id: Number(bank.id), ptype: "bank", amount: 10 }]);
    });

    it("deleteMany(), the update builder and clear() reach only the subtype's rows", async () => {
      const bank = await em.save(BankE, { amount: 10, iban: "x" });
      const card = await em.save(CardE, { amount: 20 });
      const byId = (id: number) => sql`${raw(q("id"))} = ${id}`;

      const updated = await em
        .createUpdateBuilder(CardE)
        .set({ amount: 50 })
        .where(byId(bank.id))
        .execute();
      expect(updated.affected).toBe(0);

      const deleted = await em.deleteMany(CardE, [bank.id, card.id]);
      expect(deleted.affected).toBe(1);
      expect(await stored()).toEqual([{ id: Number(bank.id), ptype: "bank", amount: 10 }]);

      await em.save(CardE, { amount: 30 });
      await em.clear(CardE);
      expect(await stored()).toEqual([{ id: Number(bank.id), ptype: "bank", amount: 10 }]);
    });

    it("a batchInsert WriteBuffer flush of several subtype instances writes each through its hierarchy", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      buf.persist(Object.assign(new CardE(), { amount: 1 }));
      buf.persist(Object.assign(new CardE(), { amount: 2 }));
      buf.persist(Object.assign(new CarE(), { wheels: 4, seats: 5 }));
      buf.persist(Object.assign(new CarE(), { wheels: 4, seats: 2 }));
      await buf.flush();

      expect((await stored()).map((row) => [row.amount, row.ptype])).toEqual([
        [1, "card"],
        [2, "card"],
      ]);
      const cars = await em.find(CarE, { orderBy: { seats: "ASC" } } as any);
      expect(cars.map((car: any) => [car.wheels, car.seats])).toEqual([
        [4, 2],
        [4, 5],
      ]);
    });
  },
);

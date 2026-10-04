/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `@ComputedColumn`s in an inheritance hierarchy on a real PostgreSQL /
 * MySQL (MariaDB): each generated column is created on the table that holds
 * the columns its expression reads — PostgreSQL always STORED, MySQL
 * VIRTUAL — every read hands it back on the classes that declare it, and a
 * restart leaves the tables as they are.
 *
 * SQLite: __tests__/integration/sqlite/inheritance/computed-columns.test.ts
 */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import {
  Entity,
  Column,
  ComputedColumn,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  ManyToOne,
  RelationColumn,
} from "../../src";

type Strategy = "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS";

function buildHierarchy(prefix: string, strategy: Strategy) {
  @Entity({ name: `${prefix}_item` })
  @Inheritance({ strategy })
  @DiscriminatorColumn({ name: "itype", type: "varchar", length: 20 })
  class Item {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "int" }) price!: number;
    @ComputedColumn({ expression: "price * 10", type: "int" }) priceTen!: number;
  }

  const childName = (name: string) =>
    strategy === "SINGLE_TABLE" ? undefined : { name: `${prefix}_${name}` };

  @Entity(childName("book"))
  @DiscriminatorValue("book")
  class Book extends Item {
    @Column({ type: "int", nullable: true }) qty!: number;
    @ComputedColumn({ expression: "qty * 2", type: "int" }) doubled!: number;
  }

  @Entity(childName("pen"))
  @DiscriminatorValue("pen")
  class Pen extends Item {
    @Column({ type: "int", nullable: true }) ink!: number;
  }

  @Entity({ name: `${prefix}_shelf` })
  class Shelf {
    @PrimaryGeneratedColumn() id!: number;
    @ManyToOne(() => Book, (b: any) => b.id)
    @RelationColumn({ name: "book_id", nullable: true })
    book!: Book | null;
  }

  return { Item, Book, Pen, Shelf, entities: [Item, Book, Pen, Shelf] };
}

const STRATEGIES: Strategy[] = ["SINGLE_TABLE", "JOINED", "TABLE_PER_CLASS"];

describe.each(getTestDrivers())(
  "[Integration] $label: @ComputedColumn in an inheritance hierarchy",
  ({ options }: TestDriverConfig) => {
    describe.each(STRATEGIES)("%s", (strategy) => {
      const prefix = `icc${strategy[0].toLowerCase()}_${String(Date.now()).slice(-6)}`;
      let conn: TestConnectionResult | undefined;
      let E: ReturnType<typeof buildHierarchy>;

      const connect = async () => {
        conn = await createTestConnection(
          {
            ...options,
            // A DDL statement that fails stops the boot instead of being logged.
            synchronize: { mode: true, continueOnError: false },
            logging: false,
          } as any,
          () => {
            E = buildHierarchy(prefix, strategy);
            return { entities: E.entities };
          },
        );
        return conn.em;
      };

      afterEach(async () => {
        if (conn) await conn.cleanup();
        conn = undefined;
      }, 30000);

      afterAll(async () => {
        await connect();
        for (const table of ["shelf", "book", "pen", "item"]) {
          await dropTestTable(`${prefix}_${table}`);
        }
        await conn!.cleanup();
        conn = undefined;
      }, 30000);

      it("creates the tables and hands the generated values back on every read", async () => {
        const em = await connect();

        const book = await em.save(E.Book, { price: 1, qty: 3 } as any);
        expect(book).toMatchObject({ price: 1, qty: 3, priceTen: 10, doubled: 6 });
        const pen = await em.save(E.Pen, { price: 4, ink: 7 } as any);
        expect(pen).toMatchObject({ price: 4, ink: 7, priceTen: 40 });
        expect(pen).not.toHaveProperty("doubled");

        const [found] = await em.find(E.Book, {});
        expect(found).toMatchObject({ priceTen: 10, doubled: 6 });

        for (const rows of [
          await em.find(E.Item, {}),
          await em.createQueryBuilder(E.Item, "i").getMany(),
          (await em.findWithCursor(E.Item, { take: 10 } as any)).data,
        ]) {
          const bookRow = (rows as any[]).find((r) => r instanceof E.Book);
          const penRow = (rows as any[]).find((r) => r instanceof E.Pen);
          expect(bookRow).toMatchObject({ priceTen: 10, doubled: 6 });
          expect(penRow).toMatchObject({ priceTen: 40 });
          expect(penRow).not.toHaveProperty("doubled");
        }

        const [viaBuilder] = await em.createQueryBuilder(E.Book, "b").getMany();
        expect(viaBuilder).toMatchObject({ priceTen: 10, doubled: 6 });

        await em.save(E.Shelf, { book: { id: book.id } } as any);
        const [shelf] = await em.find(E.Shelf, { relations: ["book"] } as any);
        expect(shelf.book).toMatchObject({ id: book.id, priceTen: 10, doubled: 6 });
      }, 60000);

      it("boots again over the same tables and keeps the generated values", async () => {
        const em = await connect();
        const [found] = await em.find(E.Book, {});
        expect(found).toMatchObject({ qty: 3, priceTen: 10, doubled: 6 });
      }, 60000);
    });
  },
);

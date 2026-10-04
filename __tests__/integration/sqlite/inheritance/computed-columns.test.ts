/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite: `@ComputedColumn`s in an inheritance hierarchy live on the table
 * that holds the columns their expressions read, and every read hands them
 * back on the classes that declare them.
 *
 * A generated column used to be created from the class's own decorator list
 * alone. A SINGLE_TABLE child's never reached the shared table, so
 * `find(Child)` failed with `no such column`; a JOINED child copied the
 * root's onto its own table, whose CREATE TABLE then failed because the
 * expression names a root column. The reads that build their own column
 * lists — the polymorphic root reads, the JOINED child reads, the TPC UNION,
 * the query builder — left generated columns out.
 *
 * PG / MariaDB: __tests__/integration/inheritance-computed-columns.test.ts
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";
import { SchemaDiff } from "../../../../src/core/generators/SchemaDiff";
import { SchemaGenerator } from "../../../../src/core/generators/SchemaGenerator";

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

  // A SINGLE_TABLE child shares the root's table and so takes its name.
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

  return { Item, Book, Pen, Shelf };
}

async function boot(file: string, entities: any[], label: string) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: file,
      entities,
      // A DDL statement that fails stops the boot instead of being logged.
      synchronize: { mode: true, continueOnError: false },
      logging: false,
    } as any,
    `${label}_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

/** The generated columns of a table, sorted (`table_info` hides them). */
async function generatedColumns(em: EntityManager, table: string): Promise<string[]> {
  const rows = (await em.query(`PRAGMA table_xinfo("${table}")`)) as any[];
  return rows
    .filter((r) => r.hidden === 2 || r.hidden === 3)
    .map((r) => r.name)
    .sort();
}

const LAYOUT: Record<Strategy, Record<string, string[]>> = {
  SINGLE_TABLE: { item: ["doubled", "priceTen"] },
  JOINED: { item: ["priceTen"], book: ["doubled"], pen: [] },
  TABLE_PER_CLASS: {
    item: ["priceTen"],
    book: ["doubled", "priceTen"],
    pen: ["priceTen"],
  },
};

const STRATEGIES: Strategy[] = ["SINGLE_TABLE", "JOINED", "TABLE_PER_CLASS"];

describe("[Integration] SQLite: @ComputedColumn in an inheritance hierarchy", () => {
  let file: string;

  beforeEach(() => {
    file = path.join(
      os.tmpdir(),
      `inh-computed-${process.pid}-${Math.random().toString(36).slice(2, 10)}.db`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  describe.each(STRATEGIES)("%s", (strategy) => {
    const prefix = `icc${strategy[0].toLowerCase()}`;
    const { Item, Book, Pen, Shelf } = buildHierarchy(prefix, strategy);
    const entities = [Item, Book, Pen, Shelf];

    it("creates each generated column on the table that holds its operands", async () => {
      const em = await boot(file, entities, prefix);
      try {
        const layout: Record<string, string[]> = {};
        for (const table of Object.keys(LAYOUT[strategy])) {
          layout[table] = await generatedColumns(em, `${prefix}_${table}`);
        }
        expect(layout).toEqual(LAYOUT[strategy]);
      } finally {
        await em.propagateShutdown();
      }
    });

    it("hands the generated values back on every read, to the classes that declare them", async () => {
      const em = await boot(file, entities, prefix);
      try {
        const book = await em.save(Book, { price: 1, qty: 3 } as any);
        expect(book).toMatchObject({ price: 1, qty: 3, priceTen: 10, doubled: 6 });
        const [many] = await em.saveMany(Book, [{ price: 2, qty: 5 }] as any);
        expect(many).toMatchObject({ priceTen: 20, doubled: 10 });
        const pen = await em.save(Pen, { price: 4, ink: 7 } as any);
        expect(pen).toMatchObject({ price: 4, ink: 7, priceTen: 40 });
        expect(pen).not.toHaveProperty("doubled");

        const expectBook = (row: any, id: number, doubled: number) => {
          expect(row).toBeInstanceOf(Book);
          expect(row).toMatchObject({ id, doubled, priceTen: row.price * 10 });
        };
        const expectPen = (row: any) => {
          expect(row).toBeInstanceOf(Pen);
          expect(row).toMatchObject({ ink: 7, priceTen: 40 });
          expect(row).not.toHaveProperty("doubled");
        };

        const books = await em.find(Book, { orderBy: { id: "ASC" } } as any);
        expectBook(books[0], book.id, 6);
        expectBook(books[1], many.id, 10);
        expectPen((await em.find(Pen, {}))[0]);

        const byType = (rows: any[]) => ({
          books: rows.filter((r) => r instanceof Book),
          pens: rows.filter((r) => r instanceof Pen),
        });
        for (const rows of [
          await em.find(Item, {}),
          await em.createQueryBuilder(Item, "i").getMany(),
          (await em.findWithCursor(Item, { take: 10 } as any)).data,
        ]) {
          const { books: b, pens: p } = byType(rows as any[]);
          expect(b.map((r) => r.doubled).sort()).toEqual([10, 6]);
          expect(p).toHaveLength(1);
          expectPen(p[0]);
        }

        const viaBuilder = await em
          .createQueryBuilder(Book, "b")
          .orderBy({ id: "ASC" } as any)
          .getMany();
        expectBook(viaBuilder[0], book.id, 6);

        await em.save(Shelf, { book: { id: book.id } } as any);
        const [shelf] = await em.find(Shelf, { relations: ["book"] } as any);
        expect(shelf.book).toMatchObject({ id: book.id, priceTen: 10, doubled: 6 });
      } finally {
        await em.propagateShutdown();
      }
    });

    it("keeps the generated columns across a restart, and the diff sees no change", async () => {
      const first = await boot(file, entities, `${prefix}r1`);
      await first.save(Book, { price: 1, qty: 3 } as any);
      await first.propagateShutdown();

      const second = await boot(file, entities, `${prefix}r2`);
      try {
        for (const table of Object.keys(LAYOUT[strategy])) {
          expect(await generatedColumns(second, `${prefix}_${table}`)).toEqual(
            LAYOUT[strategy][table],
          );
        }
        const [book] = await second.find(Book, {});
        expect(book).toMatchObject({ priceTen: 10, doubled: 6 });

        const diff = await new SchemaDiff().diff(
          entities,
          { query: (s: any) => second.query(s) },
          "sqlite",
        );
        expect({
          addComputedColumns: diff.addComputedColumns!.map(
            (c) => `${c.tableName}.${c.column.name}`,
          ),
          dropColumns: diff.dropColumns.map((c) => `${c.tableName}.${c.columnName}`),
        }).toEqual({ addComputedColumns: [], dropColumns: [] });
      } finally {
        await second.propagateShutdown();
      }
    });
  });

  it("adds a child's generated column to a SINGLE_TABLE table created without it", async () => {
    const { Item, Book, Pen } = buildHierarchy("icca", "SINGLE_TABLE");

    @Entity({ name: "icca_marker" })
    class Marker {
      @PrimaryGeneratedColumn() id!: number;
    }

    // The table an earlier boot left: the root's generated column only.
    const first = await boot(file, [Marker], "icca1");
    await first.query(
      `CREATE TABLE "icca_item" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "price" INTEGER NOT NULL, "itype" VARCHAR(20) NOT NULL, "qty" INTEGER, "ink" INTEGER, "priceTen" INTEGER GENERATED ALWAYS AS (price * 10) VIRTUAL)`,
    );
    await first.query(
      `INSERT INTO "icca_item" ("price", "itype", "qty") VALUES (1, 'book', 3)`,
    );
    await first.propagateShutdown();

    const second = await boot(file, [Item, Book, Pen], "icca2");
    try {
      expect(await generatedColumns(second, "icca_item")).toEqual(["doubled", "priceTen"]);
      const [book] = await second.find(Book, {});
      expect(book).toMatchObject({ qty: 3, priceTen: 10, doubled: 6 });
    } finally {
      await second.propagateShutdown();
    }
  });

  it("migrate:generate's CREATE TABLE puts each generated column on its table", () => {
    const sti = buildHierarchy("iccs", "SINGLE_TABLE");
    const tpt = buildHierarchy("iccj", "JOINED");
    const tpc = buildHierarchy("icct", "TABLE_PER_CLASS");
    const generator = new SchemaGenerator({ dialect: "sqlite" });
    const generatedOf = (ddl: string) =>
      [...ddl.matchAll(/"(\w+)" \w+ GENERATED ALWAYS AS/g)].map((m) => m[1]).sort();

    expect(generatedOf(generator.generateCreateTableDDL(sti.Item))).toEqual([
      "doubled",
      "priceTen",
    ]);
    expect(generatedOf(generator.generateCreateTableDDL(tpt.Item))).toEqual(["priceTen"]);
    expect(generatedOf(generator.generateCreateTableDDL(tpt.Book))).toEqual(["doubled"]);
    expect(generatedOf(generator.generateCreateTableDDL(tpt.Pen))).toEqual([]);
    expect(generatedOf(generator.generateCreateTableDDL(tpc.Book))).toEqual([
      "doubled",
      "priceTen",
    ]);
  });
});

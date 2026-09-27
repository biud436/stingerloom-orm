/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite file DB: an inheritance hierarchy survives a synchronize restart.
 *
 * The schema diff that synchronize runs against existing tables compared each
 * table with the entity's own column list. That is not the table an
 * inheritance hierarchy has: a SINGLE_TABLE table also holds the
 * discriminator and every child's columns, a JOINED root the discriminator,
 * and a JOINED child only its key and its own columns. So the second boot
 * with `synchronize: true` dropped the discriminator (and, for SINGLE_TABLE,
 * every child's column with its data) and added the root's columns to each
 * JOINED child table. migrate:generate read the same wrong layout.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Entity,
  Column,
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
  @Entity({ name: `${prefix}_owner` })
  class Owner {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  @Entity({ name: `${prefix}_doc` })
  @Inheritance({ strategy })
  @DiscriminatorColumn({ name: "dtype" })
  class Doc {
    @PrimaryGeneratedColumn() id!: number;
    @Column() title!: string;
    @ManyToOne(() => Owner, (o: any) => o.docs)
    @RelationColumn({ name: "owner_id" })
    owner!: Owner | null;
  }

  // A SINGLE_TABLE child shares the root's table and so takes its name.
  const childName = (name: string) =>
    strategy === "SINGLE_TABLE" ? undefined : { name: `${prefix}_${name}` };

  @Entity(childName("review"))
  @DiscriminatorValue("review")
  class Review extends Doc {
    @Column() reviewer!: string;
  }

  @Entity(childName("memo"))
  @DiscriminatorValue("memo")
  class Memo extends Doc {
    @Column({ nullable: true }) note!: string;
  }

  return { Owner, Doc, Review, Memo };
}

async function boot(file: string, entities: any[], label: string) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: file,
      entities,
      synchronize: true,
      logging: false,
    } as any,
    `${label}_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function tableColumns(em: EntityManager, table: string): Promise<string[]> {
  const rows = (await em.query(`PRAGMA table_info("${table}")`)) as any[];
  return rows.map((r) => r.name).sort();
}

describe("[Integration] SQLite: inheritance tables across a synchronize restart", () => {
  let file: string;

  beforeEach(() => {
    file = path.join(
      os.tmpdir(),
      `inh-restart-${process.pid}-${Math.random().toString(36).slice(2, 10)}.db`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it("SINGLE_TABLE keeps the discriminator and every child's column and data", async () => {
    const { Owner, Doc, Review, Memo } = buildHierarchy("isr", "SINGLE_TABLE");
    const entities = [Owner, Doc, Review, Memo];

    const first = await boot(file, entities, "isr1");
    const created = await tableColumns(first, "isr_doc");
    const owner = await first.save(Owner, { name: "alice" } as any);
    await first.save(Review, { title: "t1", reviewer: "bob", owner } as any);
    await first.save(Memo, { title: "t2", note: "n" } as any);
    await first.propagateShutdown();

    const second = await boot(file, entities, "isr2");
    try {
      expect(await tableColumns(second, "isr_doc")).toEqual(created);
      expect(created).toEqual(
        ["dtype", "id", "note", "owner_id", "reviewer", "title"],
      );

      const docs = await second.find(Doc, { orderBy: { id: "ASC" } } as any);
      expect(docs[0]).toBeInstanceOf(Review);
      expect(docs[0]).toMatchObject({ title: "t1", reviewer: "bob" });
      expect(docs[1]).toBeInstanceOf(Memo);
      expect(docs[1]).toMatchObject({ title: "t2", note: "n" });
    } finally {
      await second.propagateShutdown();
    }
  });

  it("JOINED keeps the discriminator on the root and the inherited columns off the child tables", async () => {
    const { Owner, Doc, Review, Memo } = buildHierarchy("ijr", "JOINED");
    const entities = [Owner, Doc, Review, Memo];

    const first = await boot(file, entities, "ijr1");
    const layout = {
      doc: await tableColumns(first, "ijr_doc"),
      review: await tableColumns(first, "ijr_review"),
      memo: await tableColumns(first, "ijr_memo"),
    };
    await first.save(Review, { title: "t1", reviewer: "bob" } as any);
    await first.save(Memo, { title: "t2", note: "n" } as any);
    await first.propagateShutdown();

    const second = await boot(file, entities, "ijr2");
    try {
      expect({
        doc: await tableColumns(second, "ijr_doc"),
        review: await tableColumns(second, "ijr_review"),
        memo: await tableColumns(second, "ijr_memo"),
      }).toEqual(layout);
      expect(layout).toEqual({
        doc: ["dtype", "id", "owner_id", "title"],
        review: ["id", "reviewer"],
        memo: ["id", "note"],
      });

      const docs = await second.find(Doc, { orderBy: { id: "ASC" } } as any);
      expect(docs[0]).toBeInstanceOf(Review);
      expect(docs[0]).toMatchObject({ title: "t1", reviewer: "bob" });
      expect(docs[1]).toBeInstanceOf(Memo);

      // A child row still inserts: no NOT NULL copy of an inherited column
      // sits on its table waiting for a value the INSERT never sends.
      const third = await second.save(Review, { title: "t3", reviewer: "cy" } as any);
      expect(third).toMatchObject({ title: "t3", reviewer: "cy" });
    } finally {
      await second.propagateShutdown();
    }
  });

  it("TABLE_PER_CLASS tables are unchanged by a restart", async () => {
    const { Owner, Doc, Review, Memo } = buildHierarchy("itr", "TABLE_PER_CLASS");
    const entities = [Owner, Doc, Review, Memo];

    const first = await boot(file, entities, "itr1");
    const layout = await tableColumns(first, "itr_review");
    await first.propagateShutdown();

    const second = await boot(file, entities, "itr2");
    try {
      expect(await tableColumns(second, "itr_review")).toEqual(layout);
      expect(layout).toEqual(["id", "owner_id", "reviewer", "title"]);
    } finally {
      await second.propagateShutdown();
    }
  });

  describe.each(["SINGLE_TABLE", "JOINED", "TABLE_PER_CLASS"] as Strategy[])(
    "SchemaDiff (migrate:generate) on a %s hierarchy",
    (strategy) => {
      it("reports no change for the tables synchronize created", async () => {
        const prefix = `isd${strategy[0].toLowerCase()}`;
        const { Owner, Doc, Review, Memo } = buildHierarchy(prefix, strategy);
        const entities = [Owner, Doc, Review, Memo];
        const em = await boot(file, entities, prefix);
        try {
          const diff = await new SchemaDiff().diff(
            entities,
            { query: (s: any) => em.query(s) },
            "sqlite",
          );
          expect({
            addTables: diff.addTables,
            addColumns: diff.addColumns.map((c) => `${c.tableName}.${c.columnName}`),
            dropColumns: diff.dropColumns.map((c) => `${c.tableName}.${c.columnName}`),
            alterColumns: diff.alterColumns.map((c) => `${c.tableName}.${c.columnName}`),
          }).toEqual({ addTables: [], addColumns: [], dropColumns: [], alterColumns: [] });
        } finally {
          await em.propagateShutdown();
        }
      });
    },
  );

  it("SchemaDiff lists a SINGLE_TABLE hierarchy's missing table once, under its root", async () => {
    const { Owner, Doc, Review, Memo } = buildHierarchy("isn", "SINGLE_TABLE");
    const em = await boot(file, [Owner], "isn");
    try {
      const diff = await new SchemaDiff().diff(
        [Owner, Doc, Review, Memo],
        { query: (s: any) => em.query(s) },
        "sqlite",
      );
      expect(diff.addTables).toEqual(["isn_doc"]);
      expect(diff.addTableEntityMap?.["isn_doc"]).toBe(Doc);
    } finally {
      await em.propagateShutdown();
    }
  });

  it("migrate:generate's CREATE TABLE lays out each table of the hierarchy", () => {
    const sti = buildHierarchy("igs", "SINGLE_TABLE");
    const tpt = buildHierarchy("igj", "JOINED");
    const generator = new SchemaGenerator({ dialect: "sqlite" });
    const columnsOf = (ddl: string) =>
      [...ddl.slice(ddl.indexOf("(")).matchAll(/"(\w+)" /g)]
        .map((m) => m[1])
        .sort();

    expect(columnsOf(generator.generateCreateTableDDL(sti.Doc))).toEqual(
      ["dtype", "id", "note", "owner_id", "reviewer", "title"],
    );
    expect(columnsOf(generator.generateCreateTableDDL(tpt.Doc))).toEqual(
      ["dtype", "id", "owner_id", "title"],
    );
    expect(columnsOf(generator.generateCreateTableDDL(tpt.Review))).toEqual(
      ["id", "reviewer"],
    );
  });
});

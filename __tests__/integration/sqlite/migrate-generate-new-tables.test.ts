/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `migrate:generate` creates a new table with everything `synchronize`
 * creates it with: the foreign key column of every relation, the indexes,
 * the foreign key constraints and the `@ManyToMany` join tables.
 *
 * The generated migration used to stop at a bare CREATE TABLE that also left
 * out the column of a `joinColumn` relation. The diff compares columns only,
 * so the next `migrate:generate` reported the schema as in sync and the gap
 * stayed.
 *
 * Each case applies the generated statements to an empty database and
 * compares the result, structurally, with a database `synchronize` built
 * from the same entities.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Column,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import {
  DiscriminatorColumn,
  DiscriminatorValue,
  Inheritance,
} from "../../../src";
import { MigrationCli } from "../../../src/migration/MigrationCli";
import { createTestConnection, resetMetadata } from "../helpers/test-connection";

interface TableShape {
  columns: string[];
  foreignKeys: string[];
  indexes: string[];
}

describe("[Integration] SQLite: migrate:generate creates new tables in full", () => {
  let dir: string;
  let seq = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-mgnt-"));
  });

  afterEach(() => {
    resetMetadata();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const database = (name: string) => ({
    type: "sqlite",
    database: path.join(dir, `${name}.sqlite`),
  });

  async function synchronize(db: any, entities: () => any[]): Promise<void> {
    resetMetadata();
    const booted = await createTestConnection(
      { ...db, synchronize: true, logging: false },
      () => ({ entities: entities() }),
    );
    await booted.cleanup();
  }

  async function generate(
    db: any,
    entities: () => any[],
  ): Promise<{ up: string[]; down: string[]; filePath: string }> {
    resetMetadata();
    const cli = new MigrationCli([], {
      ...db,
      entities: entities(),
      synchronize: false,
      logging: false,
    });
    await cli.connect();
    cli.setGenerateOptions({ outputDir: path.join(dir, `migrations-${seq++}`) });
    try {
      const result = (await cli.execute("migrate:generate")) as any;
      return { ...result.sql, filePath: result.filePath };
    } finally {
      await cli.close();
    }
  }

  async function onDatabase<R>(
    db: any,
    work: (query: (statement: string) => Promise<any[]>) => Promise<R>,
  ): Promise<R> {
    resetMetadata();
    const conn = await createTestConnection(
      { ...db, synchronize: false, logging: false },
      () => ({ entities: [] }),
    );
    try {
      return await work(
        async (statement) => (await conn.em.query(statement)) as unknown as any[],
      );
    } finally {
      await conn.cleanup();
    }
  }

  const run = (db: any, statements: string[]) =>
    onDatabase(db, async (query) => {
      for (const statement of statements) await query(statement);
    });

  /** Every table with its columns, foreign keys and indexes, order-free. */
  const shape = (db: any): Promise<Record<string, TableShape>> =>
    onDatabase(db, async (query) => {
      const tables = await query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const result: Record<string, TableShape> = {};
      for (const { name } of tables) {
        const columns = await query(`PRAGMA table_xinfo("${name}")`);
        const foreignKeys = await query(`PRAGMA foreign_key_list("${name}")`);
        const indexes = await query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${name}' AND sql IS NOT NULL`,
        );
        result[name] = {
          columns: columns
            .map((c) => `${c.name} ${c.type} notnull=${c.notnull} pk=${c.pk}`)
            .sort(),
          foreignKeys: foreignKeys
            .map(
              (fk) =>
                `${fk.from} -> ${fk.table}.${fk.to} delete=${fk.on_delete} update=${fk.on_update}`,
            )
            .sort(),
          indexes: indexes
            .map((i) => String(i.sql).replace(/ IF NOT EXISTS/, ""))
            .sort(),
        };
      }
      return result;
    });

  /** Generates against an empty database, applies it, and returns both shapes. */
  async function roundTrip(entities: () => any[]) {
    const synced = database("synced");
    const migrated = database("migrated");
    await synchronize(synced, entities);
    const first = await generate(migrated, entities);
    await run(migrated, first.up);
    return {
      first,
      migrated,
      syncedShape: await shape(synced),
      migratedShape: await shape(migrated),
    };
  }

  const library = () => {
    @Entity({ name: "mgnt_tag" })
    class Tag {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "varchar", length: 40 }) label!: string;
    }

    @Entity({ name: "mgnt_author" })
    @UniqueIndex(["name"], "uq_mgnt_author_name")
    @Index(["name", "email"])
    class Author {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "varchar", length: 40 }) name!: string;
      @Index() @Column({ type: "varchar", length: 40 }) email!: string;
    }

    @Entity({ name: "mgnt_book" })
    class Book {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "varchar", length: 40 }) title!: string;

      @ManyToOne(() => Author, undefined as any, {
        joinColumn: "author_id",
        onDelete: "CASCADE",
      })
      author!: Author;

      @ManyToOne(() => Author, undefined as any)
      @RelationColumn({ name: "editor_id", nullable: false })
      editor!: Author;

      @ManyToOne(() => Author, undefined as any, {
        joinColumn: "reviewer_id",
        createForeignKeyConstraints: false,
      })
      reviewer!: Author;

      @ManyToMany(() => Tag, {
        joinTable: {
          name: "mgnt_book_tags",
          joinColumn: "book_id",
          inverseJoinColumn: "tag_id",
        },
      } as any)
      tags!: Tag[];
    }

    @Entity({ name: "mgnt_cover" })
    class Cover {
      @PrimaryGeneratedColumn() id!: number;
      @OneToOne(() => Book, { joinColumn: "book_id" } as any)
      book!: Book;
    }

    return [Tag, Author, Book, Cover];
  };

  it("creates the same schema synchronize creates", async () => {
    const { first, migrated, syncedShape, migratedShape } =
      await roundTrip(library);

    expect(migratedShape).toEqual(syncedShape);
    // Spelled out once, so the comparison cannot pass on two empty schemas.
    expect(migratedShape.mgnt_book.columns).toEqual(
      expect.arrayContaining([
        "author_id INTEGER notnull=0 pk=0",
        "editor_id INTEGER notnull=1 pk=0",
        "reviewer_id INTEGER notnull=0 pk=0",
      ]),
    );
    expect(migratedShape.mgnt_book.foreignKeys).toEqual([
      "author_id -> mgnt_author.id delete=CASCADE update=NO ACTION",
      "editor_id -> mgnt_author.id delete=NO ACTION update=NO ACTION",
    ]);
    expect(migratedShape.mgnt_author.indexes).toHaveLength(3);
    expect(migratedShape.mgnt_book_tags.foreignKeys).toHaveLength(2);
    expect(first.filePath).not.toBe("");

    // Nothing is left for a second run to find.
    const second = await generate(migrated, library);
    expect(second.up).toEqual([]);
    expect(second.filePath).toBe("");
  });

  it("reverts everything it created", async () => {
    const { first, migrated } = await roundTrip(library);

    await run(migrated, first.down);

    expect(await shape(migrated)).toEqual({});
  });

  it("does not propose dropping the column of a joinColumn relation", async () => {
    const synced = database("synced");
    await synchronize(synced, library);

    const result = await generate(synced, library);

    expect(result.up).toEqual([]);
    expect(result.filePath).toBe("");
  });

  it("adds the column of a relation declared on an existing table", async () => {
    const before = () => {
      @Entity({ name: "mgnt_owner" })
      class Owner {
        @PrimaryGeneratedColumn() id!: number;
      }
      @Entity({ name: "mgnt_pet" })
      class Pet {
        @PrimaryGeneratedColumn() id!: number;
      }
      return [Owner, Pet];
    };
    const after = () => {
      @Entity({ name: "mgnt_owner" })
      class Owner {
        @PrimaryGeneratedColumn() id!: number;
      }
      @Entity({ name: "mgnt_pet" })
      class Pet {
        @PrimaryGeneratedColumn() id!: number;
        @ManyToOne(() => Owner, undefined as any, { joinColumn: "owner_id" })
        owner!: Owner;
      }
      return [Owner, Pet];
    };
    const db = database("existing");
    await synchronize(db, before);

    const result = await generate(db, after);

    expect(result.up).toEqual([
      `ALTER TABLE "mgnt_pet" ADD COLUMN "owner_id" INTEGER NULL`,
    ]);
  });

  it("creates the join table of a relation declared on an existing table", async () => {
    const before = () => {
      @Entity({ name: "mgnt_post" })
      class Post {
        @PrimaryGeneratedColumn() id!: number;
      }
      @Entity({ name: "mgnt_label" })
      class Label {
        @PrimaryGeneratedColumn() id!: number;
      }
      return [Post, Label];
    };
    const after = () => {
      @Entity({ name: "mgnt_label" })
      class Label {
        @PrimaryGeneratedColumn() id!: number;
      }
      @Entity({ name: "mgnt_post" })
      class Post {
        @PrimaryGeneratedColumn() id!: number;
        @ManyToMany(() => Label, {
          joinTable: {
            name: "mgnt_post_labels",
            joinColumn: "post_id",
            inverseJoinColumn: "label_id",
          },
        } as any)
        labels!: Label[];
      }
      return [Post, Label];
    };
    const migrated = database("migrated");
    const synced = database("synced");
    await synchronize(migrated, before);
    await synchronize(synced, after);

    const result = await generate(migrated, after);
    expect(result.up).toHaveLength(1);
    await run(migrated, result.up);

    expect(await shape(migrated)).toEqual(await shape(synced));
    expect((await generate(migrated, after)).up).toEqual([]);

    await run(migrated, result.down);
    expect(Object.keys(await shape(migrated)).sort()).toEqual([
      "mgnt_label",
      "mgnt_post",
    ]);
  });

  it("creates the tables of an inheritance hierarchy as synchronize does", async () => {
    const hierarchy = () => {
      @Entity({ name: "mgnt_depot" })
      class Depot {
        @PrimaryColumn({ type: "varchar", length: 36 }) code!: string;
      }

      @Entity({ name: "mgnt_vehicle" })
      @Inheritance({ strategy: "SINGLE_TABLE" })
      @DiscriminatorColumn({ name: "kind" })
      class Vehicle {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) plate!: string;
      }

      @Entity()
      @DiscriminatorValue("truck")
      class Truck extends Vehicle {
        @Column({ type: "int", nullable: true }) payload!: number;
        @ManyToOne(() => Depot, undefined as any)
        @RelationColumn({ name: "depot_code" })
        depot!: Depot;
      }

      @Entity({ name: "mgnt_account" })
      @Inheritance({ strategy: "JOINED" })
      @DiscriminatorColumn({ name: "kind" })
      class Account {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) holder!: string;
      }

      @Entity({ name: "mgnt_savings" })
      @DiscriminatorValue("savings")
      class Savings extends Account {
        @Column({ type: "int" }) rate!: number;
        @ManyToOne(() => Depot, undefined as any, { joinColumn: "branch_code" })
        branch!: Depot;
      }

      return [Depot, Vehicle, Truck, Account, Savings];
    };

    const { migrated, syncedShape, migratedShape } = await roundTrip(hierarchy);

    expect(migratedShape).toEqual(syncedShape);
    expect(migratedShape.mgnt_vehicle.columns).toContain(
      "depot_code TEXT(36) notnull=0 pk=0",
    );
    expect(migratedShape.mgnt_savings.foreignKeys).toHaveLength(2);
    expect((await generate(migrated, hierarchy)).up).toEqual([]);
  });
});

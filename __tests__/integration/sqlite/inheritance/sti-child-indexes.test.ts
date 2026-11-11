/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite: synchronize creates the indexes a SINGLE_TABLE child declares.
 *
 * A SINGLE_TABLE child has no table of its own, so synchronize skipped it
 * after the first pass and never reached the pass that creates indexes.
 * Its `@Index()`, `@Index([...])` and `@UniqueIndex([...])` were therefore
 * missing from the shared table, while migrate:generate (which groups a
 * root's children with its table) did create them.
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
  Index,
  UniqueIndex,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

function buildHierarchy(prefix: string) {
  @Entity({ name: `${prefix}_doc` })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "dtype" })
  class Doc {
    @PrimaryGeneratedColumn() id!: number;
    @Index() @Column() title!: string;
  }

  @Entity()
  @DiscriminatorValue("review")
  @Index(["reviewer", "score"])
  @UniqueIndex(["ticket"])
  class Review extends Doc {
    @Index() @Column() reviewer!: string;
    @Column() score!: number;
    @Column() ticket!: string;
  }

  @Entity()
  @DiscriminatorValue("memo")
  class Memo extends Doc {
    @Index() @Column({ nullable: true }) note!: string;
  }

  return { Doc, Review, Memo };
}

async function boot(database: string, entities: any[], label: string) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database,
      entities,
      synchronize: { mode: true, continueOnError: false },
      logging: false,
    } as any,
    `${label}_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function indexNames(em: EntityManager, table: string): Promise<string[]> {
  const rows = (await em.query(`PRAGMA index_list("${table}")`)) as any[];
  return rows
    .map((r) => r.name as string)
    .filter((n) => !n.startsWith("sqlite_autoindex"))
    .sort();
}

const EXPECTED = (prefix: string) =>
  [
    `INDEX_${prefix}_doc_note`,
    `INDEX_${prefix}_doc_reviewer`,
    `INDEX_${prefix}_doc_title`,
    `idx_${prefix}_doc_reviewer_score`,
    `uq_${prefix}_doc_ticket`,
  ].sort();

describe("[Integration] SQLite: SINGLE_TABLE child indexes under synchronize", () => {
  let file: string;

  beforeEach(() => {
    file = path.join(
      os.tmpdir(),
      `sti-idx-${process.pid}-${Math.random().toString(36).slice(2, 10)}.db`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it("creates every child's single, composite and unique index on the shared table", async () => {
    const { Doc, Review, Memo } = buildHierarchy("sci");
    const em = await boot(":memory:", [Doc, Review, Memo], "sci");
    try {
      expect(await indexNames(em, "sci_doc")).toEqual(EXPECTED("sci"));
    } finally {
      await em.propagateShutdown();
    }
  });

  it("enforces a child's unique index", async () => {
    const { Doc, Review, Memo } = buildHierarchy("scu");
    const em = await boot(":memory:", [Doc, Review, Memo], "scu");
    try {
      await em.save(Review, { title: "a", reviewer: "r", score: 1, ticket: "T-1" } as any);
      let error: unknown;
      try {
        await em.save(Review, { title: "b", reviewer: "s", score: 2, ticket: "T-1" } as any);
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(String((error as any)?.message ?? error)).toMatch(/UNIQUE/i);
    } finally {
      await em.propagateShutdown();
    }
  });

  it("boots again without error and keeps the same indexes", async () => {
    const { Doc, Review, Memo } = buildHierarchy("scr");
    const entities = [Doc, Review, Memo];

    const first = await boot(file, entities, "scr1");
    await first.propagateShutdown();

    const second = await boot(file, entities, "scr2");
    try {
      expect(await indexNames(second, "scr_doc")).toEqual(EXPECTED("scr"));
    } finally {
      await second.propagateShutdown();
    }
  });

  it("adds a child's index that an existing table is missing", async () => {
    const { Doc, Review, Memo } = buildHierarchy("scm");
    const entities = [Doc, Review, Memo];

    const first = await boot(file, entities, "scm1");
    await first.query(`DROP INDEX "INDEX_scm_doc_reviewer"`);
    await first.query(`DROP INDEX "idx_scm_doc_reviewer_score"`);
    await first.query(`DROP INDEX "uq_scm_doc_ticket"`);
    await first.propagateShutdown();

    const second = await boot(file, entities, "scm2");
    try {
      expect(await indexNames(second, "scm_doc")).toEqual(EXPECTED("scm"));
    } finally {
      await second.propagateShutdown();
    }
  });
});

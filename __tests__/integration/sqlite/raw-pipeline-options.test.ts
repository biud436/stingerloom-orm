/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: what `em.pipe()` accepts, and how keyset batches page.
 *
 * The pipeline takes `where`, `orderBy` and `select` in `find()`'s syntax, so
 * it checks them as `find()` does: an unknown option, column or operator is
 * rejected when the pipeline is created, with the valid names, instead of
 * being ignored or reaching the driver. Keyset batches page the way
 * `findWithCursor` does — by the ordering column, then the primary key, with
 * NULLs kept together — so every row comes back exactly once.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from "../../../src";
import { ComputedColumn } from "../../../src/decorators/ComputedColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { InvalidQueryError } from "../../../src/errors";

@Entity({ name: "rpo_author" })
class RpoAuthor {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "rpo_item" })
class RpoItem {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column({ type: "int" }) grp!: number;
  @Column({ type: "int", nullable: true }) score!: number | null;
  @Column({ type: "int" }) qty!: number;
  @ComputedColumn({ expression: "qty * 2", type: "int" }) doubled!: number;
  @ManyToOne(() => RpoAuthor, () => undefined, { joinColumn: "author_id" })
  author!: RpoAuthor;
}

const GROUPS = [1, 1, 1, 1, 2, 2, 2];
const SCORES = [null, 5, null, 7, 5, null, 9];

async function drain(gen: AsyncGenerator<any[]>, maxBatches = 50): Promise<any[]> {
  const rows: any[] = [];
  let batches = 0;
  for await (const batch of gen) {
    rows.push(...batch);
    // A keyset that cannot advance repeats a batch forever.
    if (++batches > maxBatches) throw new Error("the pipeline did not terminate");
  }
  return rows;
}

const ids = (rows: any[]) => rows.map((row) => row.id);

function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("[Integration] SQLite: em.pipe() options and keyset batches", () => {
  let base: EntityManager;
  let em: any;
  let authors: RpoAuthor[];

  beforeAll(async () => {
    base = new EntityManager();
    await base.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RpoAuthor, RpoItem],
        synchronize: true,
        logging: false,
      } as any,
      `rpo_${Math.random().toString(36).slice(2, 10)}`,
    );
    em = base.extend(rawPipelinePlugin());
    authors = [
      await base.save(RpoAuthor, { name: "ann" }),
      await base.save(RpoAuthor, { name: "bob" }),
    ];
    for (let i = 0; i < GROUPS.length; i++) {
      await base.save(RpoItem, {
        name: `item${i + 1}`,
        grp: GROUPS[i],
        score: SCORES[i],
        qty: i + 1,
        author: authors[i % 2],
      } as any);
    }
  });

  afterAll(async () => {
    await base?.propagateShutdown();
  });

  describe("options", () => {
    it("rejects find() options a pipeline does not apply, and says why", () => {
      const take = thrown(() => em.pipe(RpoItem, { take: 2 }));
      expect(take).toBeInstanceOf(InvalidQueryError);
      expect(take.message).toContain(
        "'take' is not a pipe() option: a pipeline reads every row 'where' matches.",
      );
      expect(thrown(() => em.pipe(RpoItem, { limit: [0, 2] })).message).toContain(
        "'limit' is not a pipe() option",
      );
      expect(thrown(() => em.pipe(RpoItem, { withDeleted: true })).message).toContain(
        "a pipeline does not filter soft-deleted rows",
      );
      expect(thrown(() => em.pipe(RpoItem, { relations: ["author"] })).message).toContain(
        "Load relations with find()",
      );
    });

    it("suggests the option a misspelled key meant", () => {
      const err = thrown(() => em.pipe(RpoItem, { batchsize: 10 }));
      expect(err.message).toContain("Unknown option 'batchsize'. Did you mean 'batchSize'?");
      expect(err.suggestion).toBe("pipe() takes: where, orderBy, select, batchSize, keyset.");
    });

    it("rejects a select that is not a list of properties and a batchSize that is not a positive integer", () => {
      expect(thrown(() => em.pipe(RpoItem, { select: { name: true } })).message).toContain(
        "'select' must be an array of property names",
      );
      expect(thrown(() => em.pipe(RpoItem, { batchSize: 0 })).message).toContain(
        "'batchSize' must be a positive integer, got 0.",
      );
      expect(thrown(() => em.pipe(RpoItem, { batchSize: "100" })).message).toContain(
        "'batchSize' must be a positive integer",
      );
    });

    it("reports an unknown column in where, orderBy and select with the valid ones", () => {
      for (const [clause, options] of [
        ["where", { where: { nmae: "item1" } }],
        ["orderBy", { orderBy: { nmae: "ASC" } }],
        ["select", { select: ["id", "nmae"] }],
      ] as const) {
        const err = thrown(() => em.pipe(RpoItem, options));
        expect(err).toBeInstanceOf(InvalidQueryError);
        expect(err.message).toContain(`Unknown column "nmae" in "${clause}" for entity "RpoItem".`);
        expect(err.suggestion).toContain("Valid columns: id, name, grp");
      }
    });

    it("rejects an unknown operator with the message find() gives", async () => {
      const where = { name: { isNotNull: true } } as any;
      const fromFind = await base.find(RpoItem, { where }).catch((e) => e);
      const fromPipe = thrown(() => em.pipe(RpoItem, { where }));
      expect(fromFind).toBeInstanceOf(InvalidQueryError);
      expect(fromPipe.message).toBe(fromFind.message);
    });

    it("resolves FK and computed properties as find() does", async () => {
      const annId = authors[0].id;
      const byAuthor = await drain(em.pipe(RpoItem, { where: { authorId: annId } }).raw());
      const found = await base.find(RpoItem, { where: { authorId: annId } as any });
      expect(ids(byAuthor).sort()).toEqual(found.map((r) => r.id).sort());

      const [selected] = await drain(
        em.pipe(RpoItem, { select: ["id", "authorId"], orderBy: { id: "ASC" } }).raw(),
      );
      expect(selected).toEqual({ id: 1, author_id: annId });

      const doubled = await drain(em.pipe(RpoItem, { where: { doubled: { gt: 10 } } }).raw());
      expect(ids(doubled)).toEqual([6, 7]);
    });

    it("reads an orderBy direction in either case and skips a falsy one, as find() does", async () => {
      const mixed = await drain(
        em.pipe(RpoItem, { orderBy: { grp: "desc", id: "asc" }, batchSize: 3 }).raw(),
      );
      const found = await base.find(RpoItem, { orderBy: { grp: "DESC", id: "ASC" } });
      expect(ids(mixed)).toEqual(found.map((r) => r.id));
      expect(ids(mixed)).toEqual([5, 6, 7, 1, 2, 3, 4]);

      const skipped = await drain(
        em.pipe(RpoItem, { orderBy: { grp: undefined, id: "DESC" } }).raw(),
      );
      expect(ids(skipped)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });
  });

  describe("keyset", () => {
    it("pages a column with repeated values without skipping or repeating a row", async () => {
      for (const direction of ["ASC", "DESC"] as const) {
        const expected = (
          await base.find(RpoItem, { orderBy: { grp: direction, id: direction } })
        ).map((r) => r.id);
        // Every batch size puts the boundary inside a run of equal values somewhere.
        for (const batchSize of [1, 2, 3, 4]) {
          const pipe = em.pipe(RpoItem, { orderBy: { grp: direction }, keyset: true, batchSize });
          expect(ids(await drain(pipe.raw()))).toEqual(expected);
          expect(ids(await drain(pipe.binary()))).toEqual(expected);
        }
      }
    });

    it("pages a nullable column in the order findWithCursor does", async () => {
      for (const direction of ["ASC", "DESC"] as const) {
        const viaCursor: number[] = [];
        let cursor: string | undefined;
        do {
          const page: any = await base.findWithCursor(RpoItem, {
            orderBy: "score",
            direction,
            take: 2,
            cursor,
          } as any);
          viaCursor.push(...page.data.map((r: RpoItem) => r.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        const viaPipe = ids(
          await drain(
            em.pipe(RpoItem, { orderBy: { score: direction }, keyset: true, batchSize: 2 }).raw(),
          ),
        );
        expect(viaPipe).toEqual(viaCursor);
        expect(new Set(viaPipe).size).toBe(GROUPS.length);
      }
      // NULLs last ascending, first descending, on every dialect.
      expect(
        ids(await drain(em.pipe(RpoItem, { orderBy: { score: "ASC" }, keyset: true, batchSize: 2 }).raw())),
      ).toEqual([2, 5, 4, 7, 1, 3, 6]);
    });

    it("reads the columns it pages by when select leaves them out", async () => {
      const rows = await drain(
        em.pipe(RpoItem, { select: ["name"], orderBy: { grp: "ASC" }, keyset: true, batchSize: 2 }).raw(),
      );
      expect(rows).toHaveLength(GROUPS.length);
      expect(rows[0]).toEqual({ name: "item1", grp: 1, id: 1 });
    });

    it("needs exactly one orderBy property", () => {
      expect(thrown(() => em.pipe(RpoItem, { keyset: true })).message).toContain(
        'keyset: true needs an orderBy to page by, for entity "RpoItem".',
      );
      expect(
        thrown(() => em.pipe(RpoItem, { orderBy: { grp: "ASC", id: "ASC" }, keyset: true })).message,
      ).toContain(
        'keyset: true pages by one column, but the orderBy for entity "RpoItem" names 2 (grp, id).',
      );
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: TPT (JOINED) delete, whatever the criteria names and
 * whichever class of the hierarchy it is called on (V6-T1-6).
 *
 * A JOINED row lives in two tables — the root holds the inherited columns,
 * the child table its own columns and the shared PK. delete() used to run
 * the caller's WHERE verbatim against both tables, so:
 *
 *   - a child-class criteria naming anything but the PK failed with
 *     `no such column` on whichever table lacked that column;
 *   - a root-class delete took the single-table path, deleting the root row
 *     while the child row still referenced it — an FK violation, or, with
 *     the FK off, a child row orphaned from its root;
 *   - deleteMany() on a child cleared the child table only, orphaning the
 *     root row; on the root it hit the same FK violation.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";
import { MetadataContext } from "../../../../src/metadata/MetadataContext";

@Entity({ name: "tdc_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TdcDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}

@Entity({ name: "tdc_review" })
@DiscriminatorValue("review")
class TdcReview extends TdcDoc {
  @Column() reviewer!: string;
}

@Entity({ name: "tdc_memo" })
@DiscriminatorValue("memo")
class TdcMemo extends TdcDoc {
  @Column() note!: string;
}

const ENTITIES = [TdcDoc, TdcReview, TdcMemo];

async function makeEm(tenant = false): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      ...(tenant ? { tenantStrategy: "tenant_column" } : {}),
    } as any,
    `tdc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rawRows(em: EntityManager, query: string): Promise<any[]> {
  const raw: any = await em.getDriver()!.executeRaw(query);
  return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
}

const ids = async (em: EntityManager, table: string): Promise<number[]> =>
  (await rawRows(em, `SELECT id FROM "${table}" ORDER BY id`)).map((r) =>
    Number(r.id),
  );

/**
 * Seeds one plain Doc, two Reviews and two Memos. `title: "shared"` is used
 * by one row of each class so a root-column criteria has rows to (not) hit
 * in every table.
 */
async function seed(em: EntityManager) {
  const doc = await em.save(TdcDoc, { title: "shared" } as any);
  const bob = await em.save(TdcReview, { title: "shared", reviewer: "bob" } as any);
  const amy = await em.save(TdcReview, { title: "r2", reviewer: "amy" } as any);
  const memo = await em.save(TdcMemo, { title: "shared", note: "n1" } as any);
  const memo2 = await em.save(TdcMemo, { title: "m2", note: "n2" } as any);
  return { doc: doc.id, bob: bob.id, amy: amy.id, memo: memo.id, memo2: memo2.id };
}

describe.each([
  ["FK enforced", true],
  ["FK not enforced", false],
])("[Integration] SQLite: TPT delete criteria (%s)", (_label, fkOn) => {
  let em: EntityManager;
  let s: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    em = await makeEm();
    if (!fkOn) {
      // Stands in for MyISAM / a schema without the child→root FK: nothing
      // stops a delete from leaving a child row without its root.
      await em.getDriver()!.executeRaw(`PRAGMA foreign_keys = OFF`);
    }
    s = await seed(em);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  describe("on a child class", () => {
    it("deletes by a child-table column from both tables", async () => {
      const result = await em.delete(TdcReview, { reviewer: "bob" } as any);
      expect(result.affected).toBe(1);
      expect(await ids(em, "tdc_review")).toEqual([s.amy]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.amy, s.memo, s.memo2]);
    });

    it("deletes by a root-table column, touching only this class's rows", async () => {
      // "shared" also names the plain Doc and a Memo: neither may go.
      const result = await em.delete(TdcReview, { title: "shared" } as any);
      expect(result.affected).toBe(1);
      expect(await ids(em, "tdc_review")).toEqual([s.amy]);
      expect(await ids(em, "tdc_memo")).toEqual([s.memo, s.memo2]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.amy, s.memo, s.memo2]);
    });

    it("deletes by criteria mixing both tables, operators and OR", async () => {
      const result = await em.delete(TdcReview, {
        OR: [{ reviewer: "amy" }, { title: { like: "sha%" } }],
        id: { gt: 0 },
      } as any);
      expect(result.affected).toBe(2);
      expect(await ids(em, "tdc_review")).toEqual([]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.memo, s.memo2]);
    });

    it("still deletes by primary key", async () => {
      expect((await em.delete(TdcReview, { id: s.amy } as any)).affected).toBe(1);
      expect(await ids(em, "tdc_review")).toEqual([s.bob]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.bob, s.memo, s.memo2]);
    });

    it("does not reach a sibling's row through its primary key", async () => {
      expect((await em.delete(TdcReview, { id: s.memo } as any)).affected).toBe(0);
      expect(await ids(em, "tdc_memo")).toEqual([s.memo, s.memo2]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.bob, s.amy, s.memo, s.memo2]);
    });

    it("reports 0 and deletes nothing when no row matches", async () => {
      expect((await em.delete(TdcReview, { reviewer: "nobody" } as any)).affected).toBe(0);
      expect(await ids(em, "tdc_doc")).toHaveLength(5);
    });

    it("deleteMany() removes the root rows too", async () => {
      const result = await em.deleteMany(TdcReview, [s.bob, s.amy, s.memo]);
      expect(result.affected).toBe(2);
      expect(await ids(em, "tdc_review")).toEqual([]);
      expect(await ids(em, "tdc_memo")).toEqual([s.memo, s.memo2]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.memo, s.memo2]);
    });
  });

  describe("on the root class", () => {
    it("deletes a child's row by primary key from every table", async () => {
      expect((await em.delete(TdcDoc, { id: s.bob } as any)).affected).toBe(1);
      expect(await ids(em, "tdc_review")).toEqual([s.amy]);
      expect(await ids(em, "tdc_doc")).toEqual([s.doc, s.amy, s.memo, s.memo2]);
    });

    it("deletes every class's matching row by a root column", async () => {
      expect((await em.delete(TdcDoc, { title: "shared" } as any)).affected).toBe(3);
      expect(await ids(em, "tdc_doc")).toEqual([s.amy, s.memo2]);
      expect(await ids(em, "tdc_review")).toEqual([s.amy]);
      expect(await ids(em, "tdc_memo")).toEqual([s.memo2]);
    });

    it("deletes a plain root row", async () => {
      expect((await em.delete(TdcDoc, { id: s.doc } as any)).affected).toBe(1);
      expect(await ids(em, "tdc_doc")).toEqual([s.bob, s.amy, s.memo, s.memo2]);
    });

    it("deleteMany() removes the child rows too", async () => {
      const result = await em.deleteMany(TdcDoc, [s.doc, s.bob, s.memo2]);
      expect(result.affected).toBe(3);
      expect(await ids(em, "tdc_doc")).toEqual([s.amy, s.memo]);
      expect(await ids(em, "tdc_review")).toEqual([s.amy]);
      expect(await ids(em, "tdc_memo")).toEqual([s.memo]);
    });

    it("leaves no child row without its root", async () => {
      await em.delete(TdcDoc, { title: { in: ["shared", "r2", "m2"] } } as any);
      expect(await ids(em, "tdc_doc")).toEqual([]);
      expect(await ids(em, "tdc_review")).toEqual([]);
      expect(await ids(em, "tdc_memo")).toEqual([]);
    });
  });

  it("rolls every table back when the delete fails part-way", async () => {
    // A trigger on the root table rejects the delete after the child rows
    // are gone: the whole delete is one transaction.
    await em.getDriver()!.executeRaw(
      `CREATE TRIGGER tdc_block BEFORE DELETE ON tdc_doc BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    let rejection: unknown;
    try {
      await em.delete(TdcReview, { reviewer: "bob" } as any);
    } catch (e) {
      rejection = e;
    }
    expect(String((rejection as { message?: string } | undefined)?.message)).toContain(
      "blocked",
    );
    expect(await ids(em, "tdc_review")).toEqual([s.bob, s.amy]);
    expect(await ids(em, "tdc_doc")).toHaveLength(5);
  });
});

describe("[Integration] SQLite: TPT delete criteria under tenant_column", () => {
  let em: EntityManager;
  const acme = <R>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
  const globex = <R>(fn: () => Promise<R>) => MetadataContext.run("globex", fn);

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(true);
    await acme(() => em.save(TdcReview, { title: "t", reviewer: "bob" } as any));
    await globex(() => em.save(TdcReview, { title: "t", reviewer: "bob" } as any));
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("a child-class delete by non-PK criteria stays in its tenant", async () => {
    await acme(async () => {
      expect((await em.delete(TdcReview, { reviewer: "bob" } as any)).affected).toBe(1);
    });
    expect(await rawRows(em, `SELECT tenant_id FROM tdc_doc`)).toEqual([
      { tenant_id: "globex" },
    ]);
    expect(await rawRows(em, `SELECT reviewer FROM tdc_review`)).toEqual([
      { reviewer: "bob" },
    ]);
  });

  it("a root-class delete stays in its tenant", async () => {
    await globex(async () => {
      expect((await em.delete(TdcDoc, { title: "t" } as any)).affected).toBe(1);
    });
    expect(await rawRows(em, `SELECT tenant_id FROM tdc_doc`)).toEqual([
      { tenant_id: "acme" },
    ]);
    expect(await ids(em, "tdc_review")).toHaveLength(1);
  });
});

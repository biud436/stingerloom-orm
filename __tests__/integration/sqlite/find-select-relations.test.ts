/**
 * `select` without the primary key combined with a relation loaded by a
 * follow-up query (V6-T0-6, defect 2).
 *
 * OneToMany, ManyToMany (either side) and the inverse side of OneToOne are
 * not JOINed: RelationLoader collects each parent's primary key from the
 * hydrated row and issues one batched `IN (...)` query. When `select` left the
 * key out, every parent's key read as undefined, the loader skipped the query
 * and assigned `[]` / `null` — rows existed, no error, no warning.
 *
 * These cases pin the fix: the read adds the missing key columns to the
 * SELECT list (qualified like the rest when a JOIN is present) without
 * touching the caller's option, and keeps them on the hydrated entity.
 * Reads that collapse rows are rejected instead — a `groupBy` that omits a
 * key column whatever `select` says, and `distinct` over a key-less `select`.
 * An empty `select` keeps failing on its empty SELECT list. ManyToOne /
 * owning OneToOne reads and reads without such a relation keep their SQL.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { TransactionSessionManager } from "../../../src/dialects/TransactionSessionManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { Relation } from "../../../src/types/Relation";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";

// ── Plain parent with every deferred relation kind ──

@Entity({ name: "fsr_owners" })
class FsrOwner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrItem, { mappedBy: "owner" })
  items!: FsrItem[];

  @ManyToMany(() => FsrTag, {
    joinTable: {
      name: "fsr_owner_tags",
      joinColumn: "owner_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: FsrTag[];

  @OneToOne(() => FsrProfile, { inverseSide: "owner" })
  profile!: Relation<FsrProfile> | null;
}

@Entity({ name: "fsr_items" })
class FsrItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  label!: string;

  @ManyToOne(() => FsrOwner, (o: FsrOwner) => o.items)
  @RelationColumn({ name: "owner_id" })
  owner!: Relation<FsrOwner>;
}

@Entity({ name: "fsr_tags" })
class FsrTag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  label!: string;

  @ManyToMany(() => FsrOwner, { mappedBy: "tags" })
  owners!: FsrOwner[];
}

@Entity({ name: "fsr_profiles" })
class FsrProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  bio!: string;

  @OneToOne(() => FsrOwner)
  @RelationColumn({ name: "owner_id" })
  owner!: Relation<FsrOwner>;
}

// ── Eager ManyToOne next to a OneToMany: the SELECT list is table-qualified ──

@Entity({ name: "fsr_projects" })
class FsrProject {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @ManyToOne(() => FsrOwner, (o: FsrOwner) => o.id, { eager: true })
  @RelationColumn({ name: "owner_id" })
  owner!: Relation<FsrOwner>;

  @OneToMany(() => FsrTask, { mappedBy: "project" })
  tasks!: FsrTask[];
}

@Entity({ name: "fsr_tasks" })
class FsrTask {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @ManyToOne(() => FsrProject, (p: FsrProject) => p.tasks)
  @RelationColumn({ name: "project_id" })
  project!: Relation<FsrProject>;
}

// ── Composite primary key ──

@Entity({ name: "fsr_composites" })
class FsrComposite {
  @PrimaryColumn({ type: "int" })
  a!: number;

  @PrimaryColumn({ type: "int" })
  b!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrCompositeKid, { mappedBy: "parent" })
  kids!: FsrCompositeKid[];
}

@Entity({ name: "fsr_composite_kids" })
class FsrCompositeKid {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  label!: string;

  @Column({ name: "parent_a", type: "int", nullable: true })
  parentA!: number;

  @ManyToOne(() => FsrComposite, (p: FsrComposite) => p.kids, {
    createForeignKeyConstraints: false,
  })
  @RelationColumn({ name: "parent_a", type: "int" })
  parent!: Relation<FsrComposite>;
}

// ── Primary key stored under a different column name ──

@Entity({ name: "fsr_renamed" })
class FsrRenamed {
  @PrimaryGeneratedColumn({ name: "own_pk" })
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrRenamedNote, { mappedBy: "renamed" })
  notes!: FsrRenamedNote[];
}

@Entity({ name: "fsr_renamed_notes" })
class FsrRenamedNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @ManyToOne(() => FsrRenamed, (r: FsrRenamed) => r.notes)
  @RelationColumn({ name: "renamed_id" })
  renamed!: Relation<FsrRenamed>;
}

// ── Inheritance: single table, joined (TPT), table per class (TPC) ──

@Entity({ name: "fsr_sti" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
class FsrSti {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrStiNote, { mappedBy: "sti" })
  notes!: FsrStiNote[];
}

@Entity()
@DiscriminatorValue("x")
class FsrStiX extends FsrSti {
  @Column({ type: "varchar", length: 40, nullable: true })
  xval!: string;
}

@Entity({ name: "fsr_sti_notes" })
class FsrStiNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @Column({ name: "sti_id", type: "int", nullable: true })
  stiId!: number;

  @ManyToOne(() => FsrSti, (s: FsrSti) => s.notes, { createForeignKeyConstraints: false })
  @RelationColumn({ name: "sti_id" })
  sti!: Relation<FsrSti>;
}

@Entity({ name: "fsr_tpt" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
class FsrTpt {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrTptNote, { mappedBy: "tpt" })
  notes!: FsrTptNote[];
}

@Entity({ name: "fsr_tpt_y" })
@DiscriminatorValue("y")
class FsrTptY extends FsrTpt {
  @Column({ type: "varchar", length: 40, nullable: true })
  yval!: string;
}

@Entity({ name: "fsr_tpt_notes" })
class FsrTptNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @Column({ name: "tpt_id", type: "int", nullable: true })
  tptId!: number;

  @ManyToOne(() => FsrTpt, (s: FsrTpt) => s.notes, { createForeignKeyConstraints: false })
  @RelationColumn({ name: "tpt_id" })
  tpt!: Relation<FsrTpt>;
}

@Entity({ name: "fsr_tpc" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class FsrTpc {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FsrTpcNote, { mappedBy: "tpc" })
  notes!: FsrTpcNote[];
}

@Entity({ name: "fsr_tpc_z" })
@DiscriminatorValue("z")
class FsrTpcZ extends FsrTpc {
  @Column({ type: "varchar", length: 40, nullable: true })
  zval!: string;
}

@Entity({ name: "fsr_tpc_notes" })
class FsrTpcNote {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @Column({ name: "tpc_id", type: "int", nullable: true })
  tpcId!: number;

  @ManyToOne(() => FsrTpc, (s: FsrTpc) => s.notes, { createForeignKeyConstraints: false })
  @RelationColumn({ name: "tpc_id" })
  tpc!: Relation<FsrTpc>;
}

type Row = Record<string, unknown>;

async function captureError(run: () => Promise<unknown>): Promise<InvalidQueryError> {
  try {
    await run();
  } catch (error) {
    return error as InvalidQueryError;
  }
  throw new Error("expected the query to reject, but it resolved");
}

/** Plain JSON view of a result, so assertions ignore class identity. */
function plain(value: unknown): Row[] {
  const rows = value == null ? [] : Array.isArray(value) ? value : [value];
  return JSON.parse(JSON.stringify(rows)) as Row[];
}

function labelsOf(rows: unknown, key: string): string[] {
  return ((rows as Row[] | undefined) ?? []).map((r) => String(r[key])).sort();
}

describe("[Integration] SQLite: find() select without the primary key + deferred relations", () => {
  let em: EntityManager;
  let querySpy: jest.SpyInstance;

  /** SELECT statements issued since the last reset, in order. */
  function selects(): string[] {
    return querySpy.mock.calls
      .map((call) => {
        const q = call[0] as string | { text?: string; sql?: string };
        return typeof q === "string" ? q : (q.text ?? q.sql ?? "");
      })
      .filter((text) => /^\s*SELECT/i.test(text));
  }

  /** The column list of the first SELECT whose FROM names `table`. */
  function selectListFrom(table: string): string {
    const statement = selects().find((text) => text.includes(`FROM "${table}"`));
    if (!statement) throw new Error(`no SELECT from "${table}" was issued`);
    return statement.slice(statement.search(/SELECT/i) + "SELECT".length, statement.indexOf(" FROM "));
  }

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [
        FsrOwner, FsrItem, FsrTag, FsrProfile,
        FsrProject, FsrTask,
        FsrComposite, FsrCompositeKid,
        FsrRenamed, FsrRenamedNote,
        FsrSti, FsrStiX, FsrStiNote,
        FsrTpt, FsrTptY, FsrTptNote,
        FsrTpc, FsrTpcZ, FsrTpcNote,
      ],
    });

    await em.query(`INSERT INTO "fsr_owners" ("name") VALUES ('o1'), ('o2')`);
    await em.query(`INSERT INTO "fsr_items" ("label", "owner_id") VALUES ('i1', 1), ('i2', 1), ('i3', 2)`);
    await em.query(`INSERT INTO "fsr_tags" ("label") VALUES ('t1'), ('t2')`);
    await em.query(`INSERT INTO "fsr_owner_tags" ("owner_id", "tag_id") VALUES (1, 1), (1, 2), (2, 2)`);
    await em.query(`INSERT INTO "fsr_profiles" ("bio", "owner_id") VALUES ('bio1', 1)`);

    await em.query(`INSERT INTO "fsr_projects" ("name", "owner_id") VALUES ('p1', 1), ('p2', 2)`);
    await em.query(`INSERT INTO "fsr_tasks" ("title", "project_id") VALUES ('k1', 1), ('k2', 1), ('k3', 2)`);

    await em.query(`INSERT INTO "fsr_composites" ("a", "b", "name") VALUES (1, 10, 'c1'), (2, 20, 'c2')`);
    await em.query(`INSERT INTO "fsr_composite_kids" ("label", "parent_a") VALUES ('ck1', 1), ('ck2', 1), ('ck3', 2)`);

    await em.query(`INSERT INTO "fsr_renamed" ("name") VALUES ('r1'), ('r2')`);
    await em.query(`INSERT INTO "fsr_renamed_notes" ("body", "renamed_id") VALUES ('rn1', 1), ('rn2', 2), ('rn3', 2)`);

    await em.save(FsrStiX, { name: "s1", xval: "xv" });
    await em.query(`INSERT INTO "fsr_sti_notes" ("body", "sti_id") VALUES ('sn1', 1)`);
    await em.save(FsrTptY, { name: "tp1", yval: "yv" });
    await em.query(`INSERT INTO "fsr_tpt_notes" ("body", "tpt_id") VALUES ('tn1', 1)`);
    await em.save(FsrTpcZ, { name: "tc1", zval: "zv" });
    await em.query(`INSERT INTO "fsr_tpc_notes" ("body", "tpc_id") VALUES ('cn1', 1)`);
  });

  beforeEach(() => {
    querySpy = jest.spyOn(TransactionSessionManager.prototype, "query");
  });

  afterEach(() => {
    querySpy.mockRestore();
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  describe("loads the relation and keeps the key on the entity", () => {
    it("find: select [name] + OneToMany", async () => {
      const rows = plain(
        await em.find(FsrOwner, { select: ["name"], relations: ["items"], orderBy: { id: "ASC" } }),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 1, name: "o1" });
      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
      expect(rows[1]).toMatchObject({ id: 2, name: "o2" });
      expect(labelsOf(rows[1].items, "label")).toEqual(["i3"]);
      expect(selectListFrom("fsr_owners")).toBe(` "name", "id"`);
    });

    it("findOne: select [name] + OneToMany", async () => {
      const row = await em.findOne(FsrOwner, {
        where: { id: 1 },
        select: ["name"],
        relations: ["items"],
      });

      expect(row).not.toBeNull();
      expect(row!.id).toBe(1);
      expect(labelsOf(row!.items, "label")).toEqual(["i1", "i2"]);
    });

    it("findAndCount and findWithPage: select [name] + OneToMany", async () => {
      const [rows, total] = await em.findAndCount(FsrOwner, {
        select: ["name"],
        relations: ["items"],
        orderBy: { id: "ASC" },
      });
      expect(total).toBe(2);
      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(rows[1].items, "label")).toEqual(["i3"]);

      const page = await em.findWithPage(FsrOwner, {
        select: ["name"],
        relations: ["items"],
        orderBy: { id: "ASC" },
        page: 1,
        pageSize: 10,
      });
      expect(page.total).toBe(2);
      expect(labelsOf(page.data[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(page.data[1].items, "label")).toEqual(["i3"]);
    });

    it("stream with a batch of one: select [name] + OneToMany", async () => {
      const seen: FsrOwner[] = [];
      for await (const owner of em.stream(
        FsrOwner,
        { select: ["name"], relations: ["items"], orderBy: { id: "ASC" } },
        1,
      )) {
        seen.push(owner);
      }

      expect(seen.map((o) => o.id)).toEqual([1, 2]);
      expect(labelsOf(seen[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(seen[1].items, "label")).toEqual(["i3"]);
    });

    it("ManyToMany owner side", async () => {
      const rows = plain(
        await em.find(FsrOwner, { select: ["name"], relations: ["tags"], orderBy: { id: "ASC" } }),
      );

      expect(labelsOf(rows[0].tags, "label")).toEqual(["t1", "t2"]);
      expect(labelsOf(rows[1].tags, "label")).toEqual(["t2"]);
    });

    it("ManyToMany inverse side", async () => {
      const rows = plain(
        await em.find(FsrTag, { select: ["label"], relations: ["owners"], orderBy: { id: "ASC" } }),
      );

      expect(rows[0]).toMatchObject({ id: 1, label: "t1" });
      expect(labelsOf(rows[0].owners, "name")).toEqual(["o1"]);
      expect(labelsOf(rows[1].owners, "name")).toEqual(["o1", "o2"]);
    });

    it("OneToOne inverse side", async () => {
      const rows = plain(
        await em.find(FsrOwner, { select: ["name"], relations: ["profile"], orderBy: { id: "ASC" } }),
      );

      expect(rows[0].profile).toMatchObject({ bio: "bio1" });
      expect(rows[1].profile).toBeNull();
    });

    it("every deferred kind at once adds the key a single time", async () => {
      const rows = plain(
        await em.find(FsrOwner, {
          select: ["name"],
          relations: ["items", "tags", "profile"],
          orderBy: { id: "ASC" },
        }),
      );

      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(rows[0].tags, "label")).toEqual(["t1", "t2"]);
      expect(rows[0].profile).toMatchObject({ bio: "bio1" });
      expect(selectListFrom("fsr_owners")).toBe(` "name", "id"`);
    });

    it("record-form select, including an explicit { id: false }", async () => {
      const fromRecord = plain(
        await em.find(FsrOwner, { select: { name: true }, relations: ["items"], orderBy: { id: "ASC" } }),
      );
      expect(fromRecord[0]).toMatchObject({ id: 1, name: "o1" });
      expect(labelsOf(fromRecord[0].items, "label")).toEqual(["i1", "i2"]);

      const withIdFalse = plain(
        await em.find(FsrOwner, {
          select: { id: false, name: true },
          relations: ["items"],
          orderBy: { id: "ASC" },
        }),
      );
      expect(withIdFalse[0].id).toBe(1);
      expect(labelsOf(withIdFalse[0].items, "label")).toEqual(["i1", "i2"]);
    });

    it("does not mutate the caller's select", async () => {
      const select: (keyof FsrOwner)[] = ["name"];
      const option = { select, relations: ["items"] as ("items")[] };

      await em.find(FsrOwner, option);

      expect(option.select).toEqual(["name"]);
      expect(option.select).toBe(select);
    });

    it("an eager ManyToOne JOIN qualifies the added key like the other columns", async () => {
      const rows = plain(
        await em.find(FsrProject, { select: ["name"], relations: ["tasks"], orderBy: { id: "ASC" } }),
      );

      expect(rows[0]).toMatchObject({ id: 1, name: "p1" });
      expect(rows[0].owner).toMatchObject({ id: 1, name: "o1" });
      expect(labelsOf(rows[0].tasks, "title")).toEqual(["k1", "k2"]);
      expect(labelsOf(rows[1].tasks, "title")).toEqual(["k3"]);
      expect(selectListFrom("fsr_projects")).toMatch(
        /^ "fsr_projects"\."name", "fsr_projects"\."id", "owner"\./,
      );
    });

    it("a composite key selects every key column", async () => {
      const rows = plain(
        await em.find(FsrComposite, { select: ["name"], relations: ["kids"], orderBy: { a: "ASC" } }),
      );

      expect(rows[0]).toMatchObject({ a: 1, b: 10, name: "c1" });
      expect(labelsOf(rows[0].kids, "label")).toEqual(["ck1", "ck2"]);
      expect(labelsOf(rows[1].kids, "label")).toEqual(["ck3"]);
      expect(selectListFrom("fsr_composites")).toBe(` "name", "a", "b"`);
    });

    it("a partially selected composite key adds only the missing column", async () => {
      await em.find(FsrComposite, { select: ["b", "name"], relations: ["kids"] });

      expect(selectListFrom("fsr_composites")).toBe(` "b", "name", "a"`);
    });

    it("a key under another column name selects the DB column and hydrates the property", async () => {
      const rows = plain(
        await em.find(FsrRenamed, { select: ["name"], relations: ["notes"], orderBy: { id: "ASC" } }),
      );

      expect(rows[0]).toMatchObject({ id: 1, name: "r1" });
      expect(rows[0]).not.toHaveProperty("own_pk");
      expect(labelsOf(rows[0].notes, "body")).toEqual(["rn1"]);
      expect(labelsOf(rows[1].notes, "body")).toEqual(["rn2", "rn3"]);
      expect(selectListFrom("fsr_renamed")).toBe(` "name", "own_pk"`);

      // Naming the key by its DB column counts as selecting it.
      querySpy.mockClear();
      await em.find(FsrRenamed, { select: ["own_pk", "name"] as never, relations: ["notes"] });
      expect(selectListFrom("fsr_renamed")).toBe(` "own_pk", "name"`);
    });
  });

  describe("inheritance", () => {
    it("single-table child", async () => {
      const rows = plain(await em.find(FsrStiX, { select: ["name"], relations: ["notes"] }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, name: "s1" });
      expect(labelsOf(rows[0].notes, "body")).toEqual(["sn1"]);
    });

    it("joined (TPT) polymorphic root qualifies the key with the root table", async () => {
      const rows = plain(await em.find(FsrTpt, { select: ["name"], relations: ["notes"] }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, name: "tp1" });
      expect(labelsOf(rows[0].notes, "body")).toEqual(["tn1"]);
      expect(selectListFrom("fsr_tpt")).toMatch(/^ "fsr_tpt"\."name", "fsr_tpt"\."id", /);
    });

    it("joined (TPT) child, which reads every column regardless of select", async () => {
      const rows = plain(await em.find(FsrTptY, { select: ["name"], relations: ["notes"] }));

      expect(rows[0]).toMatchObject({ id: 1, name: "tp1", yval: "yv" });
      expect(labelsOf(rows[0].notes, "body")).toEqual(["tn1"]);
    });

    it("table-per-class child", async () => {
      const rows = plain(await em.find(FsrTpcZ, { select: ["name"], relations: ["notes"] }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, name: "tc1" });
      expect(labelsOf(rows[0].notes, "body")).toEqual(["cn1"]);
    });
  });

  describe("distinct and groupBy", () => {
    it("rejects distinct when select omits the key", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { select: ["name"], distinct: true, relations: ["items"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Cannot load "items" for entity "FsrOwner" in a "distinct" read whose "select" omits primary key column "id". ' +
          '"items" is matched to each row by that key, and adding the key to the SELECT list would change which rows DISTINCT removes.',
      );
      expect(error.suggestion).toBe(
        'Add "id" to "select", drop "distinct", or load "items" with a separate find().',
      );
      expect(selects()).toEqual([]);
    });

    it("names every keyed relation, and only those, in the rejection", async () => {
      const error = await captureError(() =>
        em.find(FsrProject, { select: ["name"], distinct: true, relations: ["owner", "tasks"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Cannot load "tasks" for entity "FsrProject"');

      const several = await captureError(() =>
        em.find(FsrOwner, { select: ["name"], distinct: true, relations: ["items", "profile"] }),
      );
      expect(several.message).toContain('"items", "profile" are matched to each row by that key');
    });

    it("keeps distinct working when select already names the key", async () => {
      const rows = plain(
        await em.find(FsrOwner, {
          select: ["id", "name"],
          distinct: true,
          relations: ["items"],
          orderBy: { id: "ASC" },
        }),
      );

      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
    });

    it("rejects groupBy that lacks the key", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { select: ["name"], groupBy: ["name"], relations: ["items"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Cannot load "items" for entity "FsrOwner" in a "groupBy" read whose grouping omits primary key column "id". ' +
          '"items" is matched to each row by that key, and a grouped row carries the key of one arbitrary member, ' +
          "so it would be attached to the whole group.",
      );
      expect(error.suggestion).toBe(
        'Add "id" to "groupBy", or load "items" with a separate find().',
      );
      expect(selects()).toEqual([]);
    });

    // The rejection keys off the grouping alone. Naming the key in `select`
    // does not make a collapsed row point at one parent: SQLite and MySQL
    // hand back an arbitrary member's key and the loader would attach that
    // member's children to the whole group.
    it("rejects groupBy that lacks the key even when select names it", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { select: ["id", "name"], groupBy: ["name"], relations: ["items"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'in a "groupBy" read whose grouping omits primary key column "id"',
      );
      expect(selects()).toEqual([]);
    });

    it("rejects groupBy that lacks the key when there is no select", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { groupBy: ["name"], relations: ["items"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'in a "groupBy" read whose grouping omits primary key column "id"',
      );
      expect(selects()).toEqual([]);
    });

    it("rejects a grouped TPT / TPC read that lacks the key", async () => {
      const tpt = await captureError(() =>
        em.find(FsrTptY, { groupBy: ["name"], relations: ["notes"] }),
      );
      expect(tpt).toBeInstanceOf(InvalidQueryError);

      const tpc = await captureError(() =>
        em.find(FsrTpcZ, { groupBy: ["name"], relations: ["notes"] }),
      );
      expect(tpc).toBeInstanceOf(InvalidQueryError);
    });

    it("rejects groupBy that lacks one column of a composite key", async () => {
      const error = await captureError(() =>
        em.find(FsrComposite, { select: ["name"], groupBy: ["a", "name"], relations: ["kids"] }),
      );

      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('grouping omits primary key column "b"');
    });

    it("names the key by property in the rejection when its column is renamed", async () => {
      const error = await captureError(() =>
        em.find(FsrRenamed, { select: ["name"], groupBy: ["name"], relations: ["notes"] }),
      );

      expect(error.message).toContain('grouping omits primary key column "id"');
      expect(error.message).not.toContain("own_pk");
    });

    it("accepts groupBy that includes the key with no select", async () => {
      const rows = plain(
        await em.find(FsrOwner, { groupBy: ["id"], relations: ["items"], orderBy: { id: "ASC" } }),
      );

      expect(rows).toHaveLength(2);
      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(rows[1].items, "label")).toEqual(["i3"]);
    });

    it("accepts groupBy that already includes the key", async () => {
      const rows = plain(
        await em.find(FsrOwner, {
          select: ["name"],
          groupBy: ["id", "name"],
          relations: ["items"],
          orderBy: { id: "ASC" },
        }),
      );

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 1, name: "o1" });
      expect(labelsOf(rows[0].items, "label")).toEqual(["i1", "i2"]);
      expect(labelsOf(rows[1].items, "label")).toEqual(["i3"]);
    });
  });

  describe("reads that need no key keep their SQL", () => {
    it("select without relations", async () => {
      const rows = plain(await em.find(FsrOwner, { select: ["name"], orderBy: { id: "ASC" } }));

      expect(rows[0]).toEqual({ name: "o1" });
      expect(selectListFrom("fsr_owners")).toBe(` "name"`);
    });

    it("select + ManyToOne relation", async () => {
      const rows = plain(
        await em.find(FsrItem, { select: ["label"], relations: ["owner"], orderBy: { id: "ASC" } }),
      );

      expect(rows[0].owner).toMatchObject({ id: 1, name: "o1" });
      const list = selectListFrom("fsr_items");
      expect(list).toMatch(/^ "fsr_items"\."label", "owner"\./);
      expect(list).not.toContain(`"fsr_items"."id"`);
    });

    it("select + owning OneToOne relation", async () => {
      await em.find(FsrProfile, { select: ["bio"], relations: ["owner"] });

      const list = selectListFrom("fsr_profiles");
      expect(list).not.toContain(`"fsr_profiles"."id"`);
    });

    it("select that already names the key is not duplicated", async () => {
      await em.find(FsrOwner, { select: ["id", "name"], relations: ["items"] });

      expect(selectListFrom("fsr_owners")).toBe(` "id", "name"`);
    });

    it("distinct and groupBy without a deferred relation are not rejected", async () => {
      await expect(
        em.find(FsrItem, { select: ["label"], distinct: true, relations: ["owner"] }),
      ).resolves.toHaveLength(3);
      const grouped = await em.find(FsrOwner, { select: ["name"], groupBy: ["name"] });
      expect(grouped).toHaveLength(2);
    });
  });

  // An empty `select` asks for no columns at all. The key addition must not
  // turn that into a primary-key-only answer: the read keeps failing on its
  // empty SELECT list, the way it does without relations.
  describe("an empty select stays an error", () => {
    const emptySelectMessage =
      'select() requires at least one column. Use "*" to select all columns.';

    it("select: [] with a deferred relation", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { select: [], relations: ["items"] }),
      );

      expect(error.message).toContain(emptySelectMessage);
    });

    it("select: { id: false } with a deferred relation", async () => {
      const error = await captureError(() =>
        em.find(FsrOwner, { select: { id: false } as never, relations: ["items"] }),
      );

      expect(error.message).toContain(emptySelectMessage);
    });

    it("select: [] without relations keeps the same error", async () => {
      const error = await captureError(() => em.find(FsrOwner, { select: [] }));

      expect(error.message).toContain(emptySelectMessage);
    });
  });

  // Accepted consequence of selecting the key: under the buffer plugin a
  // partial read is non-canonical, so it returns the instance the identity
  // map already holds instead of the freshly loaded row — the relation this
  // read fetched is not attached to it. Read the relation from the tracked
  // instance (`await owner.items`) or use a canonical read.
  describe("buffer plugin: an already-tracked parent is returned as-is", () => {
    it("the partial read returns the tracked instance, not the fresh row", async () => {
      const buf = em.extend(bufferPlugin()).buffer();

      const tracked = (await buf.findOne(FsrOwner, { where: { id: 1 } })) as any;
      expect(tracked.id).toBe(1);

      const rows = (await buf.find(FsrOwner, {
        select: ["name"],
        relations: ["items"],
        where: { id: 1 },
      } as never)) as any[];

      expect(rows[0]).toBe(tracked);
      expect(Array.isArray(rows[0].items)).toBe(false);
      expect(labelsOf(await rows[0].items, "label")).toEqual(["i1", "i2"]);
    });

    it("an untracked parent gets the freshly loaded relation", async () => {
      const buf = em.buffer();

      const rows = (await buf.find(FsrOwner, {
        select: ["name"],
        relations: ["items"],
        where: { id: 2 },
      } as never)) as any[];

      expect(rows[0].id).toBe(2);
      expect(labelsOf(rows[0].items, "label")).toEqual(["i3"]);
    });
  });
});

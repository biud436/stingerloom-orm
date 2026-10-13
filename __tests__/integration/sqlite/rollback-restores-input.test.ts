/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A rolled-back write puts the caller's objects back the way they were.
 *
 * save() and the bulk inserts write what the database generated onto the
 * objects passed in — the key, a cascade's foreign key, timestamps and the
 * `@Version` seed. When the transaction rolled back, the row was gone but the
 * object still claimed it: saving it again ran an UPDATE that matched nothing
 * ("no row matched the primary key"), and on SQLite the key could meanwhile
 * belong to someone else's row. The values a write left on the caller's
 * objects are now undone when its transaction — or the savepoint it ran
 * under — rolls back, so retrying with the same objects inserts again.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Version } from "../../../src/decorators/Version";
import { CreateTimestamp } from "../../../src/decorators/CreateTimestamp";
import { UpdateTimestamp } from "../../../src/decorators/UpdateTimestamp";
import { TransactionPropagation } from "../../../src/decorators/Transactional";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "rri_docs" })
class RriDoc {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @Version()
  version!: number;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;
}

@Entity({ name: "rri_tokens" })
class RriToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 40 })
  label!: string;
}

@Entity({ name: "rri_teams" })
class RriTeam {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => RriMember, { mappedBy: "team", cascade: ["insert"] })
  members!: RriMember[];
}

@Entity({ name: "rri_members" })
class RriMember {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @ManyToOne(() => RriTeam, (t: RriTeam) => t.members, { cascade: ["insert"] })
  @RelationColumn({ name: "teamId", nullable: true })
  team!: Relation<RriTeam>;
}

async function rolledBack(em: EntityManager, work: (tx: EntityManager) => Promise<unknown>) {
  await expect(
    em.transaction(async (tx) => {
      await work(tx);
      throw new Error("abort");
    }),
  ).rejects.toThrow("abort");
}

describe("[Integration] SQLite: a rolled-back write restores the caller's objects", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [RriDoc, RriToken, RriTeam, RriMember] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const table of ["rri_members", "rri_teams", "rri_docs", "rri_tokens"]) {
      await em.query(`DELETE FROM "${table}"`);
    }
  });

  it("removes the generated key and lets the same object be saved again", async () => {
    const input = { title: "draft" } as Partial<RriDoc>;

    await rolledBack(em, (tx) => tx.save(RriDoc, input));

    expect(input).toEqual({ title: "draft" });
    const saved = await em.save(RriDoc, input);
    expect(saved).toMatchObject({ title: "draft", version: 1 });
    expect(await em.count(RriDoc)).toBe(1);
  });

  it("restores a class instance's own fields", async () => {
    const doc = new RriDoc();
    doc.title = "draft";

    await rolledBack(em, (tx) => tx.save(RriDoc, doc));

    expect(doc.id).toBeUndefined();
    await expect(em.save(RriDoc, doc)).resolves.toMatchObject({ title: "draft" });
  });

  it("removes a client-generated uuid key", async () => {
    const token = { label: "t" } as Partial<RriToken>;

    await rolledBack(em, (tx) => tx.save(RriToken, token));

    expect(token).toEqual({ label: "t" });
    await em.save(RriToken, token);
    expect(await em.count(RriToken)).toBe(1);
  });

  it("restores the parent a cascade saved and the foreign key it wrote", async () => {
    const member = { name: "kim", team: { name: "core" } } as any;

    await rolledBack(em, (tx) => tx.save(RriMember, member));

    expect(member).toEqual({ name: "kim", team: { name: "core" } });
    await em.save(RriMember, member);
    expect(await em.count(RriTeam)).toBe(1);
    expect(await em.count(RriMember)).toBe(1);
  });

  it("restores the children a cascade saved and the foreign keys it wrote", async () => {
    const team = { name: "core", members: [{ name: "kim" }, { name: "lee" }] } as any;

    await rolledBack(em, (tx) => tx.save(RriTeam, team));

    expect(team).toEqual({ name: "core", members: [{ name: "kim" }, { name: "lee" }] });
    await em.save(RriTeam, team);
    expect(await em.count(RriMember)).toBe(2);
  });

  it("restores the parent when the ORM's own transaction for a cascade rolls back", async () => {
    const team = { name: "core", members: [{ name: "kim" }, { name: "lee" }] } as any;
    const reject = (payload: any) => {
      if (payload.entity === RriMember && payload.data.name === "lee") {
        throw new Error("member rejected");
      }
    };
    em.on("beforeInsert", reject);
    try {
      // No em.transaction(): save() opens its own for the cascade.
      await expect(em.save(RriTeam, team)).rejects.toThrow("member rejected");
    } finally {
      em.off("beforeInsert", reject);
    }

    expect(team).toEqual({ name: "core", members: [{ name: "kim" }, { name: "lee" }] });
    expect(await em.count(RriTeam)).toBe(0);
  });

  it("restores the timestamps and version saveMany() and insertMany() stamp", async () => {
    const batch = [{ title: "a" }, { title: "b" }] as Partial<RriDoc>[];
    const bulk = [{ title: "c" }] as Partial<RriDoc>[];
    const tokens = [{ label: "x" }] as Partial<RriToken>[];

    await rolledBack(em, async (tx) => {
      await tx.saveMany(RriDoc, batch);
      await tx.insertMany(RriDoc, bulk);
      await tx.saveMany(RriToken, tokens);
    });

    expect(batch).toEqual([{ title: "a" }, { title: "b" }]);
    expect(bulk).toEqual([{ title: "c" }]);
    expect(tokens).toEqual([{ label: "x" }]);
    await em.saveMany(RriToken, tokens);
    expect(await em.count(RriToken)).toBe(1);
  });

  it("keeps what the caller set on the object after the save", async () => {
    const input = { title: "draft" } as Partial<RriDoc>;

    await rolledBack(em, async (tx) => {
      await tx.save(RriDoc, input);
      input.title = "edited";
    });

    expect(input).toEqual({ title: "edited" });
  });

  it("keeps the values of a write whose transaction commits", async () => {
    const input = { title: "draft" } as Partial<RriDoc>;

    await em.transaction((tx) => tx.save(RriDoc, input));

    expect(input.id).toEqual(expect.any(Number));
  });

  it("restores only the writes a NESTED savepoint rolled back", async () => {
    const kept = { title: "kept" } as Partial<RriDoc>;
    const undone = { title: "undone" } as Partial<RriDoc>;

    await em.transaction(async (tx) => {
      await tx.save(RriDoc, kept);
      await expect(
        tx.transaction(
          async (inner) => {
            await inner.save(RriDoc, undone);
            throw new Error("inner abort");
          },
          { propagation: TransactionPropagation.NESTED },
        ),
      ).rejects.toThrow("inner abort");
    });

    expect(kept.id).toEqual(expect.any(Number));
    expect(undone).toEqual({ title: "undone" });
    expect(await em.find(RriDoc, { orderBy: { id: "ASC" } })).toEqual([
      expect.objectContaining({ id: kept.id, title: "kept" }),
    ]);
  });

  it("leaves a loaded entity's version alone when its update rolls back", async () => {
    const saved = await em.save(RriDoc, { title: "v1" });
    const loaded = (await em.findOne(RriDoc, { where: { id: saved.id } }))!;
    loaded.title = "v2";

    await rolledBack(em, (tx) => tx.save(RriDoc, loaded));

    expect(loaded).toMatchObject({ id: saved.id, title: "v2", version: 1 });
    await expect(em.save(RriDoc, loaded)).resolves.toMatchObject({ title: "v2", version: 2 });
  });
});

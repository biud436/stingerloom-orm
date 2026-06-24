/**
 * SQLite in-memory: nested-set (tree) queries expressed entirely through the
 * query builder — no raw SQL. Models a real-world Category entity with custom
 * column names (CTGR_SQ / CTGR_NM / LFT_NO / RGT_NO / CTGR_GRP_SQ) plus Post,
 * the shape that previously forced `em.query` raw SQL in a consuming app.
 *
 * Exercises end-to-end (build + execute against a real driver):
 *  - self-join via JoinOnBuilder.onBetween (range containment)
 *  - aggregate arithmetic in SELECT (COUNT(name) - 1 AS depth)
 *  - scalar arithmetic in SELECT (FLOOR((rgt - (lft + 1)) / 2) AS children)
 *  - correlated scalar subquery in SELECT (addSelectSubquery + outer refs)
 *  - operator-object DELETE criteria ({ between }) for subtree removal
 *  - save() mapping a custom-named PK/columns back to entity property keys
 *
 * The breadcrumb + subtree-count cases double as regression guards for two QB
 * fixes:
 *  - deferred aliased-projection rendering (select() before innerJoin())
 *  - selectRaw() raw-expression passthrough (COUNT(*) inside a subquery)
 *
 * Guarded by INTEGRATION_TEST=true (excluded from the default unit run).
 */
import "reflect-metadata";
import {
  createTestConnection,
  rawQuery,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, qAlias } from "../../../src";

@Entity({ name: "category" })
class Category {
  @PrimaryGeneratedColumn({ name: "CTGR_SQ" })
  id!: number;
  @Column({ type: "varchar", length: 255, name: "CTGR_NM" })
  name!: string;
  @Column({ type: "int", name: "LFT_NO" })
  left!: number;
  @Column({ type: "int", name: "RGT_NO" })
  right!: number;
  @Column({ type: "int", name: "CTGR_GRP_SQ", default: 1 })
  groupId!: number;
}

@Entity({ name: "post" })
class Post {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: "int", name: "category_id" })
  categoryId!: number;
}

describe("[Integration] SQLite In-Memory: nested-set tree via QueryBuilder", () => {
  let conn: TestConnectionResult;
  let em: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: false, logging: false },
      () => ({ entities: [Category, Post] }),
    );
    em = conn.em;

    await rawQuery(
      `CREATE TABLE "category" (
        "CTGR_SQ" INTEGER PRIMARY KEY AUTOINCREMENT,
        "CTGR_NM" TEXT NOT NULL,
        "LFT_NO" INTEGER NOT NULL,
        "RGT_NO" INTEGER NOT NULL,
        "CTGR_GRP_SQ" INTEGER NOT NULL DEFAULT 1
      )`,
    );
    await rawQuery(
      `CREATE TABLE "post" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "category_id" INTEGER NOT NULL
      )`,
    );

    // Tree:  Root(1,10) → A(2,5) → A1(3,4) ; Root → B(6,9) → B1(7,8)
    const repo = em.getRepository(Category);
    await repo.save({ name: "Root", left: 1, right: 10, groupId: 1 });
    await repo.save({ name: "A", left: 2, right: 5, groupId: 1 });
    await repo.save({ name: "A1", left: 3, right: 4, groupId: 1 });
    await repo.save({ name: "B", left: 6, right: 9, groupId: 1 });
    await repo.save({ name: "B1", left: 7, right: 8, groupId: 1 });

    // Posts: 2 in A1 (id 3), 1 in B (id 4)
    const postRepo = em.getRepository(Post);
    await postRepo.save({ categoryId: 3 });
    await postRepo.save({ categoryId: 3 });
    await postRepo.save({ categoryId: 4 });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("save() maps custom-named columns back to entity property keys", async () => {
    const repo = em.getRepository(Category);
    const saved = await repo.save({ name: "Probe", left: 100, right: 101, groupId: 1 });

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.name).toBe("Probe");
    expect(saved.left).toBe(100);
    // The raw DB column name must NOT leak onto the returned entity.
    expect((saved as any).CTGR_SQ).toBeUndefined();

    await repo.deleteMany([saved.id]);
  });

  it("computes depth via self-join + COUNT(name)-1 + GROUP BY", async () => {
    const node = qAlias(Category, "node");
    const repo = em.getRepository(Category);
    const rows = await repo
      .createQueryBuilder("node")
      .select([
        node.id.as("id"),
        node.left.as("left"),
        node.right.as("right"),
        node.name.as("name"),
        node.name.count().sub(1).as("depth"),
      ])
      .innerJoin(Category, "parent", (j: any) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .groupBy(["node.left"])
      .addOrderBy("node.left", "ASC")
      .getRawMany();

    const depthByName = Object.fromEntries(
      rows.map((r: any) => [r.name, Number(r.depth)]),
    );
    expect(depthByName).toEqual({ Root: 0, A: 1, A1: 2, B: 1, B1: 2 });
  });

  it("builds a breadcrumb path via self-join (select before join)", async () => {
    const node = qAlias(Category, "node");
    const parent = qAlias(Category, "parent");
    const repo = em.getRepository(Category);
    const rows = await repo
      .createQueryBuilder("node")
      .select([parent.name.as("name")])
      .innerJoin(Category, "parent", (j: any) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .where(node.name.eq("A1"))
      .addOrderBy("parent.left", "ASC")
      .getRawMany();

    expect(rows.map((r: any) => r.name).join(" > ")).toBe("Root > A > A1");
  });

  it("counts subtree posts via a correlated scalar subquery in SELECT", async () => {
    const node = qAlias(Category, "node");
    const a = qAlias(Category, "a");
    const repo = em.getRepository(Category);
    const rows = await repo
      .createQueryBuilder("node")
      .select([
        node.id.as("id"),
        node.name.as("name"),
        node.right.sub(node.left.add(1)).div(2).floor().as("children"),
        node.name.count().sub(1).as("depth"),
      ])
      .addSelectSubquery(
        (outer: any) =>
          em
            .createQueryBuilder(Post, "post")
            .selectRaw(["COUNT(*)"])
            .innerJoin(Category, "a", (j: any) =>
              j.on("post.categoryId", "=", "a.id"),
            )
            .where(a.left.between(outer("node.left"), outer("node.right"))),
        "postCount",
      )
      .innerJoin(Category, "parent", (j: any) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .groupBy(["node.left"])
      .addOrderBy("node.left", "ASC")
      .getRawMany();

    const byName = Object.fromEntries(
      rows.map((r: any) => [
        r.name,
        { children: Number(r.children), postCount: Number(r.postCount) },
      ]),
    );
    // Root subtree owns all 3 posts; A subtree (A,A1) owns 2; A1 owns 2; B owns 1.
    expect(byName.Root.postCount).toBe(3);
    expect(byName.A.postCount).toBe(2);
    expect(byName.A1.postCount).toBe(2);
    expect(byName.B.postCount).toBe(1);
    expect(byName.B1.postCount).toBe(0);
    // children = (rgt - (lft + 1)) / 2
    expect(byName.Root.children).toBe(4);
    expect(byName.A.children).toBe(1);
    expect(byName.A1.children).toBe(0);
  });

  it("removes a subtree via operator-object DELETE criteria ({ between })", async () => {
    const repo = em.getRepository(Category);
    await repo.save({ name: "tmp", left: 200, right: 201, groupId: 9 });

    const res = await em.delete(Category, {
      left: { between: [200, 201] },
      groupId: 9,
    });

    expect(res.affected).toBe(1);
    const remaining = await repo.findOne({ where: { groupId: 9 } });
    expect(remaining).toBeNull();
  });
});

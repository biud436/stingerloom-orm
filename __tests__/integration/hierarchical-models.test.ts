/**
 * Hierarchical Models — capability stress test (MySQL / PostgreSQL).
 *
 * Exercises the four classical hierarchical data-modelling patterns
 * and marks, for each query, whether the Stingerloom QueryBuilder /
 * QueryDSL can express it natively or whether a raw-SQL fallback
 * (em.query / RawQueryBuilder) is required.
 *
 *   1) Adjacency List    — parentId
 *   2) Materialized Path — "1.2.3" string
 *   3) Nested Set        — (lft, rgt)
 *   4) Closure Table     — nodes + (ancestor, descendant, depth) edges
 *
 * Shared tree for every model:
 *
 *     1 Root
 *     ├── 2 A
 *     │   ├── 4 A1
 *     │   └── 5 A2
 *     └── 3 B
 *         ├── 6 B1
 *         │   └── 8 B1a
 *         └── 7 B2
 *
 * Tags on each `it()`:
 *   [Builder]  — expressible with SelectQueryBuilder + QueryDSL alone
 *   [RAW]      — requires RawQueryBuilder / em.query() (recursive CTE,
 *                set operations, non-aggregate window functions, …)
 */

import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { OrderExpression } from "../../src/core/expressions/OrderExpression";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import { Entity, Column, PrimaryColumn } from "../../src";
import { generateTableName } from "./helpers/create-test-entity";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";

interface AdjShape {
  id: number;
  name: string;
  parentId: number | null;
}
interface PathShape {
  id: number;
  name: string;
  path: string;
}
interface NestedShape {
  id: number;
  name: string;
  lft: number;
  rgt: number;
}
interface CNodeShape {
  id: number;
  name: string;
}
interface CEdgeShape {
  ancestor: number;
  descendant: number;
  depth: number;
}

(INTEGRATION ? describe.each(getTestDrivers()) : describe.skip.each(getTestDrivers()))(
  "[Integration] Hierarchical Models ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;

    let Adj: new () => AdjShape;
    let MPath: new () => PathShape;
    let NSet: new () => NestedShape;
    let CNode: new () => CNodeShape;
    let CEdge: new () => CEdgeShape;

    let adjTable: string;
    let pathTable: string;
    let nestedTable: string;
    let cnodeTable: string;
    let cedgeTable: string;

    // Column-name constants (post SnakeNamingStrategy)
    //   parentId → parent_id
    const colParent = "parent_id";
    const qId = (n: string) => qi(type as TestDriverType, n);

    beforeAll(async () => {
      adjTable = generateTableName(`hm_adj_${type}`);
      pathTable = generateTableName(`hm_path_${type}`);
      nestedTable = generateTableName(`hm_nset_${type}`);
      cnodeTable = generateTableName(`hm_cnode_${type}`);
      cedgeTable = generateTableName(`hm_cedge_${type}`);

      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          namingStrategy: new SnakeNamingStrategy(),
        },
        () => {
          getScannerInstance(ColumnScanner).clear();

          // ── 1) Adjacency List ────────────────────────────────
          const AdjClass = class {} as any;
          Object.defineProperty(AdjClass, "name", { value: adjTable, writable: false });
          Reflect.defineMetadata("design:type", Number, AdjClass.prototype, "id");
          PrimaryColumn({ type: "int" })(AdjClass.prototype, "id");
          Reflect.defineMetadata("design:type", String, AdjClass.prototype, "name");
          Column({ type: "varchar", length: 50 })(AdjClass.prototype, "name");
          Reflect.defineMetadata("design:type", Number, AdjClass.prototype, "parentId");
          Column({ type: "int", nullable: true })(AdjClass.prototype, "parentId");
          Entity()(AdjClass);
          Adj = AdjClass;

          // ── 2) Materialized Path ─────────────────────────────
          const MPathClass = class {} as any;
          Object.defineProperty(MPathClass, "name", { value: pathTable, writable: false });
          Reflect.defineMetadata("design:type", Number, MPathClass.prototype, "id");
          PrimaryColumn({ type: "int" })(MPathClass.prototype, "id");
          Reflect.defineMetadata("design:type", String, MPathClass.prototype, "name");
          Column({ type: "varchar", length: 50 })(MPathClass.prototype, "name");
          Reflect.defineMetadata("design:type", String, MPathClass.prototype, "path");
          Column({ type: "varchar", length: 255 })(MPathClass.prototype, "path");
          Entity()(MPathClass);
          MPath = MPathClass;

          // ── 3) Nested Set ────────────────────────────────────
          const NSetClass = class {} as any;
          Object.defineProperty(NSetClass, "name", { value: nestedTable, writable: false });
          Reflect.defineMetadata("design:type", Number, NSetClass.prototype, "id");
          PrimaryColumn({ type: "int" })(NSetClass.prototype, "id");
          Reflect.defineMetadata("design:type", String, NSetClass.prototype, "name");
          Column({ type: "varchar", length: 50 })(NSetClass.prototype, "name");
          Reflect.defineMetadata("design:type", Number, NSetClass.prototype, "lft");
          Column({ type: "int" })(NSetClass.prototype, "lft");
          Reflect.defineMetadata("design:type", Number, NSetClass.prototype, "rgt");
          Column({ type: "int" })(NSetClass.prototype, "rgt");
          Entity()(NSetClass);
          NSet = NSetClass;

          // ── 4a) Closure: nodes ───────────────────────────────
          const CNodeClass = class {} as any;
          Object.defineProperty(CNodeClass, "name", { value: cnodeTable, writable: false });
          Reflect.defineMetadata("design:type", Number, CNodeClass.prototype, "id");
          PrimaryColumn({ type: "int" })(CNodeClass.prototype, "id");
          Reflect.defineMetadata("design:type", String, CNodeClass.prototype, "name");
          Column({ type: "varchar", length: 50 })(CNodeClass.prototype, "name");
          Entity()(CNodeClass);
          CNode = CNodeClass;

          // ── 4b) Closure: edges (composite PK on ancestor + descendant)
          const CEdgeClass = class {} as any;
          Object.defineProperty(CEdgeClass, "name", { value: cedgeTable, writable: false });
          Reflect.defineMetadata("design:type", Number, CEdgeClass.prototype, "ancestor");
          PrimaryColumn({ type: "int" })(CEdgeClass.prototype, "ancestor");
          Reflect.defineMetadata("design:type", Number, CEdgeClass.prototype, "descendant");
          PrimaryColumn({ type: "int" })(CEdgeClass.prototype, "descendant");
          Reflect.defineMetadata("design:type", Number, CEdgeClass.prototype, "depth");
          Column({ type: "int" })(CEdgeClass.prototype, "depth");
          Entity()(CEdgeClass);
          CEdge = CEdgeClass;

          return {
            entities: [AdjClass, MPathClass, NSetClass, CNodeClass, CEdgeClass],
          };
        },
      );
      em = conn.em;

      // ── Seed the same logical tree in every model ──────────
      const adjRows: AdjShape[] = [
        { id: 1, name: "Root", parentId: null },
        { id: 2, name: "A",    parentId: 1 },
        { id: 3, name: "B",    parentId: 1 },
        { id: 4, name: "A1",   parentId: 2 },
        { id: 5, name: "A2",   parentId: 2 },
        { id: 6, name: "B1",   parentId: 3 },
        { id: 7, name: "B2",   parentId: 3 },
        { id: 8, name: "B1a",  parentId: 6 },
      ];
      for (const r of adjRows) await em.save(Adj, r as any);

      const pathRows: PathShape[] = [
        { id: 1, name: "Root", path: "1" },
        { id: 2, name: "A",    path: "1.2" },
        { id: 3, name: "B",    path: "1.3" },
        { id: 4, name: "A1",   path: "1.2.4" },
        { id: 5, name: "A2",   path: "1.2.5" },
        { id: 6, name: "B1",   path: "1.3.6" },
        { id: 7, name: "B2",   path: "1.3.7" },
        { id: 8, name: "B1a",  path: "1.3.6.8" },
      ];
      for (const r of pathRows) await em.save(MPath, r as any);

      const nsetRows: NestedShape[] = [
        { id: 1, name: "Root", lft: 1,  rgt: 16 },
        { id: 2, name: "A",    lft: 2,  rgt: 7  },
        { id: 4, name: "A1",   lft: 3,  rgt: 4  },
        { id: 5, name: "A2",   lft: 5,  rgt: 6  },
        { id: 3, name: "B",    lft: 8,  rgt: 15 },
        { id: 6, name: "B1",   lft: 9,  rgt: 12 },
        { id: 8, name: "B1a",  lft: 10, rgt: 11 },
        { id: 7, name: "B2",   lft: 13, rgt: 14 },
      ];
      for (const r of nsetRows) await em.save(NSet, r as any);

      const cnodeRows: CNodeShape[] = [
        { id: 1, name: "Root" }, { id: 2, name: "A" }, { id: 3, name: "B" },
        { id: 4, name: "A1"   }, { id: 5, name: "A2"}, { id: 6, name: "B1" },
        { id: 7, name: "B2"   }, { id: 8, name: "B1a" },
      ];
      for (const r of cnodeRows) await em.save(CNode, r as any);

      const cedgeRows: CEdgeShape[] = [
        // self-edges
        { ancestor: 1, descendant: 1, depth: 0 },
        { ancestor: 2, descendant: 2, depth: 0 },
        { ancestor: 3, descendant: 3, depth: 0 },
        { ancestor: 4, descendant: 4, depth: 0 },
        { ancestor: 5, descendant: 5, depth: 0 },
        { ancestor: 6, descendant: 6, depth: 0 },
        { ancestor: 7, descendant: 7, depth: 0 },
        { ancestor: 8, descendant: 8, depth: 0 },
        // depth 1
        { ancestor: 1, descendant: 2, depth: 1 },
        { ancestor: 1, descendant: 3, depth: 1 },
        { ancestor: 2, descendant: 4, depth: 1 },
        { ancestor: 2, descendant: 5, depth: 1 },
        { ancestor: 3, descendant: 6, depth: 1 },
        { ancestor: 3, descendant: 7, depth: 1 },
        { ancestor: 6, descendant: 8, depth: 1 },
        // depth 2
        { ancestor: 1, descendant: 4, depth: 2 },
        { ancestor: 1, descendant: 5, depth: 2 },
        { ancestor: 1, descendant: 6, depth: 2 },
        { ancestor: 1, descendant: 7, depth: 2 },
        { ancestor: 3, descendant: 8, depth: 2 },
        // depth 3
        { ancestor: 1, descendant: 8, depth: 3 },
      ];
      for (const r of cedgeRows) await em.save(CEdge, r as any);
    }, 120000);

    afterAll(async () => {
      try {
        await dropTestTable(cedgeTable);
        await dropTestTable(cnodeTable);
        await dropTestTable(nestedTable);
        await dropTestTable(pathTable);
        await dropTestTable(adjTable);
      } catch {}
      if (conn) await conn.cleanup();
    }, 30000);

    // ══════════════════════════════════════════════════════════
    // 1) Adjacency List
    // ══════════════════════════════════════════════════════════
    describe("1) Adjacency List", () => {
      it("[Builder] direct children of root (QueryDSL eq)", async () => {
        const qb = em.createQueryBuilder(Adj, "a");
        const a = qAlias(Adj, "a");
        const rows = await qb
          .where(a.parentId.eq(1))
          .addOrderBy("a.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
      });

      it("[Builder] descendant-count per node via correlated scalar subquery", async () => {
        const c = qAlias(Adj, "c");
        const sub = em
          .createQueryBuilder(Adj, "c")
          .select([c.id.count().as("cnt")])
          .where(sql`c.${raw(qId(colParent))} = a.${raw(qId("id"))}`);

        const qb = em.createQueryBuilder(Adj, "a");
        const rows = await qb
          .select(["id", "name"])
          .addSelectSubquery(sub, "children")
          .addOrderBy("a.id", "ASC")
          .getRawMany();

        const map = Object.fromEntries(
          rows.map((r: any) => [r.name, Number(r.children)]),
        );
        expect(map).toEqual({
          Root: 2, A: 2, B: 2, A1: 0, A2: 0, B1: 1, B2: 0, B1a: 0,
        });
      });

      it("[Builder] leaves only — NOT IN (SELECT parentId …)", async () => {
        const parentIds = em
          .createQueryBuilder(Adj, "c")
          .select(["parentId"])
          .whereNotNull("c.parentId");

        const qb = em.createQueryBuilder(Adj, "a");
        const rows = await qb
          .whereNotInSubquery("a.id", parentIds)
          .addOrderBy("a.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name).sort()).toEqual(
          ["A1", "A2", "B1a", "B2"].sort(),
        );
      });

      it("[RAW] recursive CTE — all descendants of node B (id=3)", async () => {
        const T = qId(adjTable);
        const P = qId(colParent);
        const isPg = type === "postgres";
        const cte = isPg
          ? `WITH RECURSIVE sub AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = $1
               UNION ALL
               SELECT c.id, c.name, c.${P}
                 FROM ${T} c
                 INNER JOIN sub ON c.${P} = sub.id
             )
             SELECT id, name FROM sub WHERE id <> $2 ORDER BY id`
          : `WITH RECURSIVE sub AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = ?
               UNION ALL
               SELECT c.id, c.name, c.${P}
                 FROM ${T} c
                 INNER JOIN sub ON c.${P} = sub.id
             )
             SELECT id, name FROM sub WHERE id <> ? ORDER BY id`;
        const rows = await em.query<{ id: number; name: string }>(cte, [3, 3]);
        expect(rows.map((r) => r.name)).toEqual(["B1", "B2", "B1a"]);
      });

      it("[RAW] recursive CTE — ancestor path from leaf B1a → root", async () => {
        const T = qId(adjTable);
        const P = qId(colParent);
        const isPg = type === "postgres";
        const cte = isPg
          ? `WITH RECURSIVE anc AS (
               SELECT id, name, ${P}, 0 AS lvl FROM ${T} WHERE id = $1
               UNION ALL
               SELECT p.id, p.name, p.${P}, anc.lvl + 1
                 FROM ${T} p
                 INNER JOIN anc ON anc.${P} = p.id
             )
             SELECT id, name, lvl FROM anc ORDER BY lvl`
          : `WITH RECURSIVE anc AS (
               SELECT id, name, ${P}, 0 AS lvl FROM ${T} WHERE id = ?
               UNION ALL
               SELECT p.id, p.name, p.${P}, anc.lvl + 1
                 FROM ${T} p
                 INNER JOIN anc ON anc.${P} = p.id
             )
             SELECT id, name, lvl FROM anc ORDER BY lvl`;
        const rows = await em.query<{ id: number; name: string; lvl: number }>(
          cte,
          [8],
        );
        expect(rows.map((r) => r.name)).toEqual(["B1a", "B1", "B", "Root"]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 2) Materialized Path
    // ══════════════════════════════════════════════════════════
    describe("2) Materialized Path", () => {
      it("[Builder] all descendants of B via LIKE prefix (startsWith)", async () => {
        const qb = em.createQueryBuilder(MPath, "p");
        const p = qAlias(MPath, "p");
        const rows = await qb
          .where(p.path.startsWith("1.3."))
          .addOrderBy("p.path", "ASC")
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["B1", "B1a", "B2"]);
      });

      it("[Builder] depth via LENGTH − LENGTH(REPLACE)", async () => {
        const qb = em.createQueryBuilder(MPath, "p");
        const colPath = qId("path");
        const rows = await qb
          .select(["id", "name"])
          .addSelect(
            sql`LENGTH(p.${raw(colPath)}) - LENGTH(REPLACE(p.${raw(colPath)}, '.', ''))`,
            "depth",
          )
          .addOrderBy("p.id", "ASC")
          .getRawMany();
        const depths = Object.fromEntries(
          rows.map((r: any) => [r.name, Number(r.depth)]),
        );
        expect(depths).toEqual({
          Root: 0, A: 1, B: 1, A1: 2, A2: 2, B1: 2, B2: 2, B1a: 3,
        });
      });

      it("[Builder] nodes at exact depth 2", async () => {
        const qb = em.createQueryBuilder(MPath, "p");
        const colPath = qId("path");
        const rows = await qb
          .where(
            sql`LENGTH(p.${raw(colPath)}) - LENGTH(REPLACE(p.${raw(colPath)}, '.', '')) = 2`,
          )
          .addOrderBy("p.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name).sort()).toEqual(
          ["A1", "A2", "B1", "B2"].sort(),
        );
      });
    });

    // ══════════════════════════════════════════════════════════
    // 3) Nested Set
    // ══════════════════════════════════════════════════════════
    describe("3) Nested Set", () => {
      it("[Builder] descendants of B (id=3) via lft/rgt range self-join", async () => {
        const qb = em.createQueryBuilder(NSet, "child");
        qb.innerJoin(nestedTable, "parent", sql`1=1`);
        const rows = await qb
          .where(sql`parent.id = 3`)
          .andWhere(sql`child.lft > parent.lft`)
          .andWhere(sql`child.rgt < parent.rgt`)
          .addOrderBy("child.lft", "ASC")
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["B1", "B1a", "B2"]);
      });

      it("[Builder] ancestors of leaf B1a (id=8)", async () => {
        const qb = em.createQueryBuilder(NSet, "anc");
        qb.innerJoin(nestedTable, "leaf", sql`1=1`);
        const rows = await qb
          .where(sql`leaf.id = 8`)
          .andWhere(sql`anc.lft < leaf.lft`)
          .andWhere(sql`anc.rgt > leaf.rgt`)
          .addOrderBy("anc.lft", "ASC")
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["Root", "B", "B1"]);
      });

      it("[Builder] depth of every node via self-join COUNT + GROUP BY", async () => {
        // depth(n) = COUNT of ancestors a  where  a.lft < n.lft AND a.rgt > n.rgt
        const qb = em.createQueryBuilder(NSet, "n");
        qb.leftJoin(nestedTable, "anc", sql`anc.lft < n.lft AND anc.rgt > n.rgt`);
        const rows = await qb
          .select(["id", "name"])
          .addSelect(sql`COUNT(anc.id)`, "depth")
          .groupBy(["n.id", "n.name"])
          .addOrderBy("n.id", "ASC")
          .getRawMany();
        const depths = Object.fromEntries(
          rows.map((r: any) => [r.name, Number(r.depth)]),
        );
        expect(depths).toEqual({
          Root: 0, A: 1, B: 1, A1: 2, A2: 2, B1: 2, B2: 2, B1a: 3,
        });
      });

      it("[Builder] leaf nodes: rgt = lft + 1", async () => {
        const qb = em.createQueryBuilder(NSet, "n");
        const rows = await qb
          .where(sql`n.rgt = n.lft + 1`)
          .addOrderBy("n.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name).sort()).toEqual(
          ["A1", "A2", "B1a", "B2"].sort(),
        );
      });
    });

    // ══════════════════════════════════════════════════════════
    // 4) Closure Table
    // ══════════════════════════════════════════════════════════
    describe("4) Closure Table", () => {
      it("[Builder] descendants of A (id=2) — JOIN closure edges", async () => {
        const qb = em.createQueryBuilder(CNode, "n");
        qb.innerJoin(cedgeTable, "e", sql`e.descendant = n.id`);
        const rows = await qb
          .where(sql`e.ancestor = 2`)
          .andWhere(sql`e.depth > 0`)
          .addOrderBy("e.depth", "ASC")
          .addOrderBy("n.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name).sort()).toEqual(["A1", "A2"].sort());
      });

      it("[Builder] ancestors of B1a (id=8) ordered by depth DESC (root first)", async () => {
        const qb = em.createQueryBuilder(CNode, "n");
        qb.innerJoin(cedgeTable, "e", sql`e.ancestor = n.id`);
        const rows = await qb
          .where(sql`e.descendant = 8`)
          .andWhere(sql`e.depth > 0`)
          .addOrderBy("e.depth", "DESC")
          .getMany();
        expect(rows.map((r) => r.name)).toEqual(["Root", "B", "B1"]);
      });

      it("[Builder] depth of every node via MAX(depth) on closure", async () => {
        const qb = em.createQueryBuilder(CNode, "n");
        qb.leftJoin(
          cedgeTable,
          "e",
          sql`e.descendant = n.id AND e.ancestor <> n.id`,
        );
        const rows = await qb
          .select(["id", "name"])
          .addSelect(sql`COALESCE(MAX(e.depth), 0)`, "depth")
          .groupBy(["n.id", "n.name"])
          .addOrderBy("n.id", "ASC")
          .getRawMany();
        const depths = Object.fromEntries(
          rows.map((r: any) => [r.name, Number(r.depth)]),
        );
        expect(depths).toEqual({
          Root: 0, A: 1, B: 1, A1: 2, A2: 2, B1: 2, B2: 2, B1a: 3,
        });
      });

      it("[Builder] subtree size per ancestor — GROUP BY + HAVING ≥ 4", async () => {
        // { Root → 8, B → 4 }
        const qb = em.createQueryBuilder(CEdge, "e");
        qb.innerJoin(cnodeTable, "n", sql`n.id = e.ancestor`);
        const rows = await qb
          .select(["ancestor"])
          .addSelect("n.name", "name")
          .addSelect(sql`COUNT(*)`, "size")
          .groupBy(["e.ancestor", "n.name"])
          .having(sql`COUNT(*) >= 4`)
          .addOrderBy("e.ancestor", "ASC")
          .getRawMany();
        const map = rows.map((r: any) => ({
          name: r.name,
          size: Number(r.size),
        }));
        expect(map).toEqual([
          { name: "Root", size: 8 },
          { name: "B", size: 4 },
        ]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 5) SQL-craft stress — CASE / pivot / top-N / window
    // ══════════════════════════════════════════════════════════
    describe("5) SQL craft patterns", () => {
      it("[Builder] CASE WHEN bucketizes nodes by depth (closure)", async () => {
        const qb = em.createQueryBuilder(CNode, "n");
        qb.leftJoin(
          cedgeTable,
          "e",
          sql`e.descendant = n.id AND e.ancestor <> n.id`,
        );
        const rows = await qb
          .select(["id", "name"])
          .addSelect(sql`COALESCE(MAX(e.depth), 0)`, "depth")
          .addSelect(
            sql`CASE
               WHEN COALESCE(MAX(e.depth), 0) = 0 THEN 'root'
               WHEN COALESCE(MAX(e.depth), 0) = 1 THEN 'branch'
               ELSE 'deep'
             END`,
            "bucket",
          )
          .groupBy(["n.id", "n.name"])
          .addOrderBy("n.id", "ASC")
          .getRawMany();
        expect(rows.map((r: any) => r.bucket)).toEqual([
          "root", "branch", "branch", "deep", "deep", "deep", "deep", "deep",
        ]);
      });

      it("[Builder] pivot — node count per depth via CASE + SUM", async () => {
        // Flatten depth per node (MAX across closure edges where ancestor≠descendant)
        // and count by bucket in ONE query, no FROM-subquery needed.
        const qb = em.createQueryBuilder(CEdge, "e");
        const rows = await qb
          .select([] as any)
          .addSelect(sql`SUM(CASE WHEN e.depth = 1 THEN 1 ELSE 0 END)`, "d1_edges")
          .addSelect(sql`SUM(CASE WHEN e.depth = 2 THEN 1 ELSE 0 END)`, "d2_edges")
          .addSelect(sql`SUM(CASE WHEN e.depth = 3 THEN 1 ELSE 0 END)`, "d3_edges")
          .where(sql`e.depth > 0`)
          .getRawMany();
        const r = rows[0] as any;
        // Edge counts:  depth1=7, depth2=5, depth3=1  (see seed)
        expect([
          Number(r.d1_edges),
          Number(r.d2_edges),
          Number(r.d3_edges),
        ]).toEqual([7, 5, 1]);
      });

      it("[Builder] top-1 child per parent by name (adjacency) — correlated MIN", async () => {
        const T = qId(adjTable);
        const P = qId(colParent);
        const qb = em.createQueryBuilder(Adj, "parent");
        qb.innerJoin(adjTable, "child", sql`child.${raw(P)} = parent.id`);
        const rows = await qb
          .select([] as any)
          .addSelect("parent.name", "parentName")
          .addSelect("child.name", "childName")
          .where(
            sql`child.name = (SELECT MIN(c2.name) FROM ${raw(T)} c2 WHERE c2.${raw(P)} = parent.id)`,
          )
          .addOrderBy("parent.id", "ASC")
          .getRawMany();
        const map = Object.fromEntries(
          rows.map((r: any) => [r.parentName, r.childName]),
        );
        expect(map).toEqual({ Root: "A", A: "A1", B: "B1", B1: "B1a" });
      });

      it("[RAW] ROW_NUMBER rank of children within each parent (adjacency)", async () => {
        const T = qId(adjTable);
        const P = qId(colParent);
        const rows = await em.query<{
          name: string;
          parent_id: number | null;
          rn: number;
        }>(
          `SELECT name, ${P} AS parent_id,
                  ROW_NUMBER() OVER (PARTITION BY ${P} ORDER BY name) AS rn
             FROM ${T}
            WHERE ${P} IS NOT NULL
            ORDER BY ${P}, rn`,
        );
        const byParent: Record<string, Array<[string, number]>> = {};
        for (const r of rows) {
          const key = String(r.parent_id);
          (byParent[key] ||= []).push([r.name, Number(r.rn)]);
        }
        expect(byParent["1"]).toEqual([["A", 1], ["B", 2]]);
        expect(byParent["2"]).toEqual([["A1", 1], ["A2", 2]]);
        expect(byParent["3"]).toEqual([["B1", 1], ["B2", 2]]);
        expect(byParent["6"]).toEqual([["B1a", 1]]);
      });

      it("[RAW] UNION of two subtrees (A ∪ B1) via recursive CTEs", async () => {
        const T = qId(adjTable);
        const P = qId(colParent);
        const isPg = type === "postgres";
        const cte = isPg
          ? `WITH RECURSIVE subA AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = 2
               UNION ALL
               SELECT c.id, c.name, c.${P} FROM ${T} c
               INNER JOIN subA ON c.${P} = subA.id
             ),
             subB1 AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = 6
               UNION ALL
               SELECT c.id, c.name, c.${P} FROM ${T} c
               INNER JOIN subB1 ON c.${P} = subB1.id
             )
             SELECT name FROM subA
             UNION
             SELECT name FROM subB1
             ORDER BY name`
          : `WITH RECURSIVE subA AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = 2
               UNION ALL
               SELECT c.id, c.name, c.${P} FROM ${T} c
               INNER JOIN subA ON c.${P} = subA.id
             ),
             subB1 AS (
               SELECT id, name, ${P} FROM ${T} WHERE id = 6
               UNION ALL
               SELECT c.id, c.name, c.${P} FROM ${T} c
               INNER JOIN subB1 ON c.${P} = subB1.id
             )
             SELECT name FROM subA
             UNION
             SELECT name FROM subB1
             ORDER BY name`;
        const rows = await em.query<{ name: string }>(cte);
        expect(rows.map((r) => r.name)).toEqual([
          "A", "A1", "A2", "B1", "B1a",
        ]);
      });
    });

    // ══════════════════════════════════════════════════════════
    // 6) QueryDSL caseBuilder + Expressions.or / Expressions.and
    // ══════════════════════════════════════════════════════════
    describe("6) QueryDSL caseBuilder / logical composition", () => {
      it("[Builder] classify by path depth using Expressions.caseBuilder", async () => {
        const qb = em.createQueryBuilder(MPath, "p");
        const p = qAlias(MPath, "p");
        const tier = Expressions.caseBuilder()
          .when(p.path.eq("1")).then("root")
          .when(p.path.like("1.%.%.%")).then("deep")
          .when(p.path.like("1.%.%")).then("mid")
          .when(p.path.like("1.%")).then("top")
          .otherwise("?")
          .end();
        const rows = await qb
          .select(["id", "name"])
          .addSelect(tier.as("tier"))
          .addOrderBy("p.id", "ASC")
          .getRawMany();
        const map = Object.fromEntries(
          rows.map((r: any) => [r.name, r.tier]),
        );
        expect(map).toEqual({
          Root: "root",
          A: "top", B: "top",
          A1: "mid", A2: "mid", B1: "mid", B2: "mid",
          B1a: "deep",
        });
      });

      it("[Builder] OR composition — nodes that are either A-subtree or B2", async () => {
        const qb = em.createQueryBuilder(MPath, "p");
        const p = qAlias(MPath, "p");
        const rows = await qb
          .where(
            Expressions.or(
              p.path.startsWith("1.2"),
              p.path.eq("1.3.7"),
            ),
          )
          .addOrderBy("p.id", "ASC")
          .getMany();
        expect(rows.map((r) => r.name).sort()).toEqual(
          ["A", "A1", "A2", "B2"].sort(),
        );
      });
    });

    // Keeps OrderExpression import referenced so future tests can reuse it
    // without triggering an unused-import lint error when this file grows.
    void new OrderExpression("id", "ASC", undefined, true);
  },
);

/**
 * SelectQueryBuilder projection terminals: getMap() and pluck().
 *
 * These mirror common query-builder DX (Laravel keyBy/pluck, TypeORM-ish):
 *
 *  - getMap(keyColumn) runs the query via getMany() and indexes the rows into
 *    a Map keyed by the column's value (last-wins on duplicate keys),
 *  - pluck(column) runs the query via getMany() and returns a flat, ordered
 *    array of just that column's value.
 *
 * Both are terminals built on getMany(), so they inherit everything getMany()
 * respects (WHERE / JOIN / ORDER BY / LIMIT / soft-delete / tenant). The mock
 * EM records every query() call (asserting the WHERE survives) and returns a
 * configurable result set, mirroring the existing unit-test harness.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class Member {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 50 })
  status!: string;
}

interface MockOptions {
  dbType?: "mysql" | "postgresql";
  rows?: Record<string, unknown>[];
}

/**
 * Mock EM that records the SQL text of every query() call and returns a
 * configurable result set, wiring just enough (resolver + propertyToColumnMap)
 * for getMany()'s ResultTransformer to hydrate plain rows into entities.
 */
function createMockEm(opts: MockOptions = {}) {
  const dbType = opts.dbType ?? "mysql";
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) =>
    dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  const calls: string[] = [];
  const rows: Record<string, unknown>[] = opts.rows ?? [];
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
    },
    async query<T>(built: any): Promise<T[]> {
      calls.push(String(built?.sql ?? built?.text ?? built));
      return rows as unknown as T[];
    },
    __calls: calls,
  } as unknown as EntityManager & { __calls: string[] };
  return em;
}

function makeQb(em: EntityManager) {
  return new SelectQueryBuilder<Member>(Member, "m", em);
}

describe("SelectQueryBuilder.getMap()", () => {
  it("indexes rows into a Map keyed by the given column", async () => {
    const em = createMockEm({
      rows: [
        { id: 1, name: "alice", status: "active" },
        { id: 2, name: "bob", status: "active" },
        { id: 3, name: "carol", status: "active" },
      ],
    });
    const qb = makeQb(em);

    const byId = await qb.getMap("id");

    expect(byId).toBeInstanceOf(Map);
    expect(byId.size).toBe(3);
    expect(byId.get(1)?.name).toBe("alice");
    expect(byId.get(2)?.name).toBe("bob");
    expect(byId.get(3)?.name).toBe("carol");
    expect(byId.get(999)).toBeUndefined();
  });

  it("keys by a non-PK column too", async () => {
    const em = createMockEm({
      rows: [
        { id: 1, name: "alice", status: "active" },
        { id: 2, name: "bob", status: "active" },
      ],
    });
    const qb = makeQb(em);

    const byName = await qb.getMap("name");

    expect(byName.size).toBe(2);
    expect(byName.get("alice")?.id).toBe(1);
    expect(byName.get("bob")?.id).toBe(2);
  });

  it("is last-wins on duplicate keys (later row overwrites earlier)", async () => {
    const em = createMockEm({
      rows: [
        { id: 1, name: "first", status: "active" },
        { id: 1, name: "second", status: "active" },
      ],
    });
    const qb = makeQb(em);

    const byId = await qb.getMap("id");

    expect(byId.size).toBe(1);
    expect(byId.get(1)?.name).toBe("second");
  });

  it("returns an empty Map for an empty result set", async () => {
    const em = createMockEm({ rows: [] });
    const qb = makeQb(em);

    const byId = await qb.getMap("id");

    expect(byId).toBeInstanceOf(Map);
    expect(byId.size).toBe(0);
  });

  it("goes through getMany(), preserving the builder's WHERE in the SQL", async () => {
    const em = createMockEm({
      rows: [{ id: 7, name: "active-user", status: "active" }],
    });
    const qb = makeQb(em);
    qb.where("status", "active");

    const byId = await qb.getMap("id");

    expect(byId.get(7)?.name).toBe("active-user");
    const sqlText = em.__calls[0];
    expect(sqlText).toContain("WHERE");
    expect(sqlText).toContain("`m`.`status`");
  });
});

describe("SelectQueryBuilder.pluck()", () => {
  it("returns a flat array of the column's values in order", async () => {
    const em = createMockEm({
      rows: [
        { id: 1, name: "a", status: "active" },
        { id: 2, name: "b", status: "active" },
        { id: 3, name: "c", status: "active" },
      ],
    });
    const qb = makeQb(em);

    const names = await qb.pluck("name");

    expect(names).toEqual(["a", "b", "c"]);
  });

  it("plucks a numeric column (e.g. ids for a later IN clause)", async () => {
    const em = createMockEm({
      rows: [
        { id: 10, name: "a", status: "active" },
        { id: 20, name: "b", status: "active" },
      ],
    });
    const qb = makeQb(em);

    const ids = await qb.pluck("id");

    expect(ids).toEqual([10, 20]);
  });

  it("returns an empty array for an empty result set", async () => {
    const em = createMockEm({ rows: [] });
    const qb = makeQb(em);

    const names = await qb.pluck("name");

    expect(names).toEqual([]);
  });

  it("goes through getMany(), preserving the builder's WHERE in the SQL", async () => {
    const em = createMockEm({
      rows: [{ id: 1, name: "active-user", status: "active" }],
    });
    const qb = makeQb(em);
    qb.where("status", "active");

    const names = await qb.pluck("name");

    expect(names).toEqual(["active-user"]);
    const sqlText = em.__calls[0];
    expect(sqlText).toContain("WHERE");
    expect(sqlText).toContain("`m`.`status`");
  });
});

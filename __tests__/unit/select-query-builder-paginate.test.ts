import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  age!: number;
}

/**
 * Mock EM whose `query()` inspects the generated SQL: COUNT(*) queries
 * (from getCount()) resolve to the configured total, every other query
 * resolves to the configured page rows. This lets paginate() exercise its
 * real getCount() + getMany() sequence without a database.
 */
function createMockEm(opts: { total: number; rows: any[] }) {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    return `\`${col.replace(/`/g, "``")}\``;
  }
  const calls: string[] = [];
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
    },
    async query<T>(built: any): Promise<T[]> {
      const text = String(built?.sql ?? built?.text ?? "").toUpperCase();
      calls.push(text);
      if (text.includes("COUNT(*)")) {
        return [{ count: opts.total }] as unknown as T[];
      }
      return opts.rows as T[];
    },
    __calls: calls,
  } as unknown as EntityManager & { __calls: string[] };
  return em;
}

function makeRows(n: number, startId = 1): any[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `user-${startId + i}`,
    age: 20 + i,
  }));
}

describe("SelectQueryBuilder.paginate()", () => {
  it("returns full page metadata for a middle page", async () => {
    const em = createMockEm({ total: 25, rows: makeRows(10, 11) });
    const result = await new SelectQueryBuilder(User, "u", em).paginate({
      page: 2,
      pageSize: 10,
    });

    expect(result.total).toBe(25);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(true);
    expect(result.data).toHaveLength(10);
    expect(result.data[0]).toBeInstanceOf(User);
  });

  it("sets LIMIT/OFFSET from page + pageSize", async () => {
    const em = createMockEm({ total: 25, rows: makeRows(10, 11) });
    await new SelectQueryBuilder(User, "u", em).paginate({ page: 2, pageSize: 10 });

    // Two queries are issued: a COUNT(*) and the data SELECT. The data
    // query carries the page window (MySQL renders `LIMIT <offset>, <count>`).
    const countIssued = em.__calls.some((c) => c.includes("COUNT(*)"));
    const dataSql = em.__calls.find((c) => !c.includes("COUNT(*)"))!;
    expect(countIssued).toBe(true);
    expect(dataSql).toContain("LIMIT");
  });

  it("defaults to page 1 / pageSize 20", async () => {
    const em = createMockEm({ total: 5, rows: makeRows(5) });
    const result = await new SelectQueryBuilder(User, "u", em).paginate();

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.totalPages).toBe(1);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("normalizes non-positive page to 1 and floors fractional pages", async () => {
    const zero = await new SelectQueryBuilder(
      User,
      "u",
      createMockEm({ total: 5, rows: makeRows(5) }),
    ).paginate({ page: -3, pageSize: 10 });
    expect(zero.page).toBe(1);

    const frac = await new SelectQueryBuilder(
      User,
      "u",
      createMockEm({ total: 50, rows: makeRows(10, 21) }),
    ).paginate({ page: 3.9, pageSize: 10 });
    expect(frac.page).toBe(3);
  });

  it("reports the last page as having no next page", async () => {
    const em = createMockEm({ total: 25, rows: makeRows(5, 21) });
    const result = await new SelectQueryBuilder(User, "u", em).paginate({
      page: 3,
      pageSize: 10,
    });
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
    expect(result.data).toHaveLength(5);
  });

  it("does not mutate the source builder's LIMIT/OFFSET", async () => {
    const em = createMockEm({ total: 25, rows: makeRows(10) });
    const qb = new SelectQueryBuilder(User, "u", em);

    await qb.paginate({ page: 2, pageSize: 10 });

    // After paginate(), the original builder still emits no LIMIT/OFFSET.
    const { text } = qb.getSql();
    expect(text).not.toContain("LIMIT");
    expect(text).not.toContain("OFFSET");
  });
});

describe("SelectQueryBuilder.paginatePartial()", () => {
  it("returns plain projected rows with page metadata", async () => {
    const rows = [
      { id: 1, name: "user-1" },
      { id: 2, name: "user-2" },
    ];
    const em = createMockEm({ total: 7, rows });
    const result = await new SelectQueryBuilder(User, "u", em)
      .select(["id", "name"])
      .paginatePartial({ page: 1, pageSize: 2 });

    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(4);
    expect(result.hasNextPage).toBe(true);
    // Plain objects, not class instances.
    expect(result.data[0]).not.toBeInstanceOf(User);
    expect(result.data).toEqual(rows);
  });
});

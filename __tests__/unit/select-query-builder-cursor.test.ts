import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import {
  decodeCursorKey,
  encodeCursor,
  encodeCursorKey,
} from "../../src/core/CursorPagination";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { createMockEm as sharedMockEm } from "./helpers/mock-em";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  age!: number;
}

type RecordedCall = { sql: string; values: any[] };

/**
 * Mock EM whose `query()` records the generated SQL + bound values and
 * resolves to the configured rows. getCursor() issues a single SELECT
 * (no COUNT), so every call returns the page rows. This exercises the real
 * getMany() -> toSql() path (ORDER BY / WHERE / LIMIT) without a database.
 */
function createMockEm(rows: any[]) {
  const calls: RecordedCall[] = [];
  return sharedMockEm("mysql", {
    async query(built: any) {
      calls.push({
        sql: String(built?.sql ?? built?.text ?? ""),
        values: (built?.values ?? []) as any[],
      });
      return rows;
    },
    __calls: calls,
  });
}

function makeRows(n: number, startId = 1): any[] {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    name: `user-${startId + i}`,
    age: 20 + i,
  }));
}

describe("SelectQueryBuilder.getCursor()", () => {
  it("first page (no cursor): orders by PK ASC, over-fetches take+1, reports hasNextPage", async () => {
    // 3 rows returned for take=2 => one extra row was over-fetched.
    const em = createMockEm(makeRows(3));
    const result = await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
    });

    expect(result.data).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    // nextCursor encodes the last visible row's sort value and key (id = 2).
    expect(decodeCursorKey(result.nextCursor!)).toEqual({ order: 2, pk: 2, subKey: undefined });
    expect(result.data[0]).toBeInstanceOf(User);

    const { sql, values } = em.__calls[0];
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("`u`.`id`");
    expect(sql).toContain("ASC");
    expect(sql).toContain("LIMIT");
    // The over-fetch limit (take + 1) is the last bound value.
    expect(values[values.length - 1]).toBe(3);
    // No keyset predicate on the first page.
    expect(sql).not.toContain(">");
  });

  it("last page: fewer than take+1 rows => hasNextPage false and nextCursor null", async () => {
    // Only 2 rows for take=2 (no over-fetch) => this is the final page.
    const em = createMockEm(makeRows(2));
    const result = await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
    });

    expect(result.data).toHaveLength(2);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("defaults take to 20 when omitted", async () => {
    const em = createMockEm(makeRows(5));
    await new SelectQueryBuilder(User, "u", em).getCursor();
    // Over-fetch is 20 + 1 = 21.
    const { values } = em.__calls[0];
    expect(values[values.length - 1]).toBe(21);
  });

  it("with an incoming cursor (PK order): appends a `> ?` key compare", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      cursor: encodeCursorKey(5, 5),
    });

    const { sql, values } = em.__calls[0];
    expect(sql).toContain("`u`.`id` > ?");
    expect(sql).not.toContain("IS NULL");
    expect(values).toContain(5);
  });

  it("with a sort-value-only cursor from an earlier version: compares the value, NULL rows kept", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      cursor: encodeCursor(5),
    });

    const { sql, values } = em.__calls[0];
    expect(sql).toContain("(`u`.`id` > ? OR `u`.`id` IS NULL)");
    expect(values).toContain(5);
  });

  it("with an incoming cursor (DESC): appends a `< ?` keyset predicate and orders DESC", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      direction: "DESC",
      cursor: encodeCursorKey(5, 5),
    });

    const { sql, values } = em.__calls[0];
    expect(sql).toContain("`u`.`id` < ?");
    expect(sql).toContain("DESC");
    expect(values).toContain(5);
  });

  it("honors a custom orderBy column", async () => {
    const em = createMockEm(makeRows(3));
    const result = await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      orderBy: "age",
    });

    const { sql } = em.__calls[0];
    // The NULL region is ordered explicitly and the PK breaks ties.
    expect(sql).toContain("ORDER BY (`u`.`age` IS NULL) ASC, `u`.`age` ASC, `u`.`id` ASC");
    // nextCursor carries the last visible row's `age` (rows start at 20) and id.
    expect(decodeCursorKey(result.nextCursor!)).toEqual({ order: 21, pk: 2, subKey: undefined });
  });

  it("breaks ties of a repeated sort value by the primary key", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      orderBy: "age",
      cursor: encodeCursorKey(21, 2),
    });

    const { sql, values } = em.__calls[0];
    expect(sql).toContain(
      "(`u`.`age` > ? OR (`u`.`age` = ? AND `u`.`id` > ?) OR `u`.`age` IS NULL)",
    );
    expect(values.slice(0, 3)).toEqual([21, 21, 2]);
  });

  it("continues from a page that ended on a NULL sort value", async () => {
    const rows = makeRows(3).map((row) => ({ ...row, age: null }));
    const em = createMockEm(rows);
    const first = await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      orderBy: "age",
    });

    expect(decodeCursorKey(first.nextCursor!)).toEqual({ order: null, pk: 2, subKey: undefined });

    await new SelectQueryBuilder(User, "u", em).getCursor({
      take: 2,
      orderBy: "age",
      cursor: first.nextCursor!,
    });
    expect(em.__calls[1].sql).toContain("(`u`.`age` IS NULL AND `u`.`id` > ?)");
  });

  it("rejects a cursor that carries another key shape", async () => {
    const em = createMockEm(makeRows(1));
    await expect(
      new SelectQueryBuilder(User, "u", em).getCursor({ cursor: encodeCursorKey(1, [1, 2]) }),
    ).rejects.toThrow(InvalidQueryError);
  });

  it("preserves an existing .where() on the builder (ANDed with the keyset predicate)", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em)
      .where("age", ">=", 18)
      .getCursor({ take: 2, cursor: encodeCursorKey(5, 5) });

    const { sql, values } = em.__calls[0];
    // Both the user WHERE and the keyset predicate are present.
    expect(sql).toContain("`u`.`age` >= ?");
    expect(sql).toContain("`u`.`id` > ?");
    expect(values).toContain(18);
    expect(values).toContain(5);
  });

  it("keeps any pre-existing ORDER BY after the keyset keys", async () => {
    const em = createMockEm(makeRows(1));
    await new SelectQueryBuilder(User, "u", em)
      .orderBy({ name: "ASC" })
      .getCursor({ take: 2, orderBy: "id" });

    const { sql } = em.__calls[0];
    // Keyset column is primary; the prior ORDER BY follows it.
    const idPos = sql.indexOf("`u`.`id`");
    const namePos = sql.indexOf("`u`.`name`");
    expect(idPos).toBeGreaterThanOrEqual(0);
    expect(namePos).toBeGreaterThan(idPos);
  });

  it("throws on a malformed incoming cursor", async () => {
    const em = createMockEm(makeRows(1));
    await expect(
      new SelectQueryBuilder(User, "u", em).getCursor({
        cursor: "!!!not-base64-json!!!",
      }),
    ).rejects.toThrow(/cursor/i);
  });

  it("is side-effect-free on the source builder", async () => {
    const em = createMockEm(makeRows(3));
    const qb = new SelectQueryBuilder(User, "u", em).where("age", ">=", 18);

    await qb.getCursor({ take: 2, cursor: encodeCursorKey(5, 5) });

    // The original builder carries no LIMIT, no keyset predicate, and no
    // ORDER BY injected by getCursor() — only the user's own WHERE remains.
    const { text } = qb.getSql();
    expect(text).not.toContain("LIMIT");
    expect(text).not.toContain("ORDER BY");
    expect(text).not.toContain("`u`.`id` > ?");
    expect(text).toContain("`u`.`age` >= ?");

    // A subsequent getMany() still works and is unaffected.
    const again = await qb.getMany();
    expect(again).toHaveLength(3);
    expect(again[0]).toBeInstanceOf(User);
  });
});

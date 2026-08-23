/**
 * find() GROUP BY / HAVING through the FindOption path.
 *
 * Until now `findOption.groupBy` had no positive coverage anywhere — its only
 * test was the typo-rejection case in read-identifier-validation. These cases
 * pin the documented behavior (select + groupBy + having, docs
 * entity-manager-querying.md) and the two gaps the review surfaced:
 *
 *  1. ReadExecutor emits groupBy entries verbatim — unlike select/orderBy it
 *     never maps propertyKey → DB column, so any renamed column
 *     (`@Column({ name })` or a NamingStrategy) groups by a column that does
 *     not exist while SELECT uses the mapped name.
 *  2. findAndCount()/findWithPage() count with a where-only COUNT(*), so with
 *     groupBy the data rows are groups but `total` counts raw rows —
 *     totalPages/hasNextPage are wrong.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
} from "../../../src";
import { sql } from "../../../src/utils/sqlTag";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import type { Relation } from "../../../src/types/Relation";

function asArray<T>(result: T | T[] | null): T[] {
  return result == null ? [] : Array.isArray(result) ? result : [result];
}

const suffix = String(Date.now()).slice(-6);

// ─────────────────────────────────────────────────────────
// Part 1: default naming (property === column)
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: find() with groupBy (default naming)", () => {
  let conn: TestConnectionResult;
  let GbCustomer: any;
  let GbOrder: any;
  let GbTicket: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        @Entity({ name: `gb_customers_${suffix}` })
        class GbCustomerEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 50 }) name!: string;
        }

        @Entity({ name: `gb_orders_${suffix}` })
        class GbOrderEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 30 }) status!: string;
          @Column({ type: "int" }) amount!: number;
          @Column({ type: "int", nullable: true }) customerId?: number;

          @ManyToOne(() => GbCustomerEntity, (c: any) => c.id, {
            joinColumn: "customerId",
          })
          customer!: Relation<GbCustomerEntity>;
        }

        // Renamed column: propertyKey "ticketState" ≠ DB column "ticket_state".
        @Entity({ name: `gb_tickets_${suffix}` })
        class GbTicketEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 30, name: "ticket_state" })
          ticketState!: string;
          @Column({ type: "int" }) points!: number;
        }

        GbCustomer = GbCustomerEntity;
        GbOrder = GbOrderEntity;
        GbTicket = GbTicketEntity;
        return {
          entities: [GbCustomerEntity, GbOrderEntity, GbTicketEntity],
        };
      },
    );

    const { em } = conn;
    const alice: any = await em.save(GbCustomer, { name: "alice" } as any);
    const bob: any = await em.save(GbCustomer, { name: "bob" } as any);

    await em.save(GbOrder, { status: "pending", amount: 10, customerId: alice.id } as any);
    await em.save(GbOrder, { status: "pending", amount: 20, customerId: alice.id } as any);
    await em.save(GbOrder, { status: "paid", amount: 30, customerId: alice.id } as any);
    await em.save(GbOrder, { status: "paid", amount: 40, customerId: bob.id } as any);
    await em.save(GbOrder, { status: "paid", amount: 50, customerId: bob.id } as any);
    await em.save(GbOrder, { status: "cancelled", amount: 60, customerId: bob.id } as any);

    await em.save(GbTicket, { ticketState: "open", points: 1 } as any);
    await em.save(GbTicket, { ticketState: "open", points: 2 } as any);
    await em.save(GbTicket, { ticketState: "closed", points: 3 } as any);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("returns one row per group with select + groupBy", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        select: ["status"],
        groupBy: ["status"],
      } as any),
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r: any) => r.status))).toEqual(
      new Set(["pending", "paid", "cancelled"]),
    );
  });

  it("filters groups with having (docs example shape)", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        select: ["status"],
        groupBy: ["status"],
        having: [sql`COUNT(*) >= ${2}`],
      } as any),
    );

    expect(new Set(rows.map((r: any) => r.status))).toEqual(
      new Set(["pending", "paid"]),
    );
  });

  it("groups by multiple columns", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        select: ["status", "customerId"],
        groupBy: ["status", "customerId"],
      } as any),
    );

    // (pending, alice), (paid, alice), (paid, bob), (cancelled, bob)
    expect(rows).toHaveLength(4);
  });

  it("filters multi-column groups with having", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        select: ["status", "customerId"],
        groupBy: ["status", "customerId"],
        having: [sql`COUNT(*) >= ${2}`],
      } as any),
    );

    // (pending, alice) x2 and (paid, bob) x2 survive
    expect(rows).toHaveLength(2);
  });

  it("findAndCount with a multi-column groupBy counts group pairs", async () => {
    const [rows, total] = await conn.em.findAndCount(GbOrder, {
      select: ["status", "customerId"],
      groupBy: ["status", "customerId"],
    } as any);

    expect(rows).toHaveLength(4);
    expect(total).toBe(4);
  });

  it("combines where with groupBy", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        where: { status: "paid" },
        select: ["customerId"],
        groupBy: ["customerId"],
      } as any),
    );

    expect(rows).toHaveLength(2);
  });

  it("qualifies groupBy with the main table when an eager join is present", async () => {
    const rows = asArray(
      await conn.em.find(GbOrder, {
        select: ["status"],
        relations: ["customer"],
        groupBy: ["status"],
      } as any),
    );

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r: any) => r.status))).toEqual(
      new Set(["pending", "paid", "cancelled"]),
    );
  });

  it("maps a renamed @Column({ name }) property in groupBy like select does", async () => {
    // select maps ticketState → "ticket_state"; groupBy must resolve the same
    // property or the query dies with "no such column: ticketState".
    const rows = asArray(
      await conn.em.find(GbTicket, {
        select: ["ticketState"],
        groupBy: ["ticketState"],
      } as any),
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.ticketState))).toEqual(
      new Set(["open", "closed"]),
    );
  });

  it("findAndCount with groupBy counts groups, not raw rows", async () => {
    const [rows, total] = await conn.em.findAndCount(GbOrder, {
      select: ["status"],
      groupBy: ["status"],
    } as any);

    expect(rows).toHaveLength(3);
    expect(total).toBe(3);
  });

  it("findWithPage with groupBy paginates over groups", async () => {
    const page = await conn.em.findWithPage(GbOrder, {
      select: ["status"],
      groupBy: ["status"],
      orderBy: { status: "ASC" },
      page: 1,
      pageSize: 2,
    } as any);

    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(page.hasNextPage).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Part 2: SnakeNamingStrategy (property ≠ column for every camelCase field)
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: find() with groupBy under SnakeNamingStrategy", () => {
  let conn: TestConnectionResult;
  let GbEvent: any;

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
      },
      () => {
        @Entity({ name: `gb_events_${suffix}` })
        class GbEventEntity {
          @PrimaryGeneratedColumn() id!: number;
          // camelCase property → snake_case column "event_type"
          @Column({ type: "varchar", length: 30 }) eventType!: string;
          @Column({ type: "int" }) score!: number;
        }

        GbEvent = GbEventEntity;
        return { entities: [GbEventEntity] };
      },
    );

    const { em } = conn;
    await em.save(GbEvent, { eventType: "click", score: 1 } as any);
    await em.save(GbEvent, { eventType: "click", score: 2 } as any);
    await em.save(GbEvent, { eventType: "view", score: 3 } as any);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  it("resolves a camelCase property in groupBy to its snake_case column", async () => {
    const rows = asArray(
      await conn.em.find(GbEvent, {
        select: ["eventType"],
        groupBy: ["eventType"],
      } as any),
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.eventType))).toEqual(
      new Set(["click", "view"]),
    );
  });

  it("maps each entry of a multi-column groupBy independently", async () => {
    // "eventType" needs the snake_case mapping, "score" passes through —
    // per-entry resolution must not break the mixed case.
    const rows = asArray(
      await conn.em.find(GbEvent, {
        select: ["eventType", "score"],
        groupBy: ["eventType", "score"],
      } as any),
    );

    // (click, 1), (click, 2), (view, 3)
    expect(rows).toHaveLength(3);
  });

  it("keeps accepting the DB column name typed directly (fallback contract)", async () => {
    // where/orderBy fall back to the raw key when it is not in the property
    // map — groupBy must honor the same measured fallback.
    const rows = asArray(
      await conn.em.find(GbEvent, {
        select: ["eventType"],
        groupBy: ["event_type"],
      } as any),
    );

    expect(rows).toHaveLength(2);
  });
});

/**
 * SQLite In-Memory: WriteBuffer bulk DML (updateMany / deleteMany) against a
 * real database.
 *
 * Regression for the audited FlushExecutor bug: executeBulkUpdate /
 * executeBulkDelete hand-rolled `col = ?` SQL by iterating
 * `Object.entries(where)`. That path:
 *   1. bound an operator object (`{ gte: 18 }`) directly as a `?` parameter,
 *      producing broken SQL that matched nothing (or threw),
 *   2. used the entity PROPERTY name as the column name, ignoring the active
 *      NamingStrategy — so `displayName` emitted `"displayName" = ?` instead of
 *      `"display_name" = ?`, failing on a snake_cased schema.
 *
 * The fix delegates both to EntityManager.update / EntityManager.delete, the
 * single canonical write path that already understands operator WHERE clauses,
 * NamingStrategy column mapping, and tenant scoping.
 *
 * All assertions read back through `em.find` (which always hits the DB and
 * never the buffer's identity map) so we verify the real row state, not the
 * in-memory objects.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer bulk DML (updateMany / deleteMany)", () => {
  let conn: TestConnectionResult;
  let User: new () => any;

  beforeAll(async () => {
    const usersClassName = shortName("BulkUser");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        namingStrategy: new SnakeNamingStrategy(),
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const UC = class {} as any;
        Object.defineProperty(UC, "name", { value: usersClassName });
        Reflect.defineMetadata("design:type", Number, UC.prototype, "id");
        PrimaryGeneratedColumn()(UC.prototype, "id");
        Reflect.defineMetadata("design:type", Number, UC.prototype, "age");
        Column()(UC.prototype, "age");
        Reflect.defineMetadata("design:type", String, UC.prototype, "role");
        Column({ nullable: true })(UC.prototype, "role");
        // camelCase property → snake_case column (`display_name`) under
        // SnakeNamingStrategy. Exercises NamingStrategy mapping in bulk DML.
        Reflect.defineMetadata("design:type", String, UC.prototype, "displayName");
        Column({ nullable: true })(UC.prototype, "displayName");
        Entity()(UC);

        User = UC;
        return { entities: [UC] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    // Reset table between tests via the buffer-free EntityManager.
    await conn.em.clear(User);
    await conn.em.save(User, { age: 10, role: "minor", displayName: "Ten" } as any);
    await conn.em.save(User, { age: 18, role: "minor", displayName: "Eighteen" } as any);
    await conn.em.save(User, { age: 40, role: "minor", displayName: "Forty" } as any);
  });

  async function allByAge(): Promise<any[]> {
    const rows = await conn.em.find(User, { orderBy: { age: "ASC" } as any });
    return rows;
  }

  it("updateMany with an operator WHERE ({ gte }) updates only matching rows", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    buf.updateMany(User, { where: { age: { gte: 18 } }, set: { role: "adult" } });
    await buf.flush();

    const rows = await allByAge();
    const byAge = Object.fromEntries(rows.map((r) => [r.age, r.role]));
    expect(byAge[10]).toBe("minor"); // below 18 — untouched
    expect(byAge[18]).toBe("adult");
    expect(byAge[40]).toBe("adult");
  });

  it("deleteMany with an operator WHERE ({ lt }) deletes only matching rows", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    buf.deleteMany(User, { age: { lt: 18 } });
    await buf.flush();

    const rows = await allByAge();
    expect(rows.map((r) => r.age)).toEqual([18, 40]);
  });

  it("updateMany maps camelCase properties to snake_case columns (SET + WHERE)", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    // Both the SET target (displayName → display_name) and the WHERE key
    // (displayName) must be NamingStrategy-mapped, or SQLite raises
    // "no such column: displayName".
    buf.updateMany(User, {
      where: { displayName: "Forty" },
      set: { displayName: "Renamed" },
    });
    await buf.flush();

    const rows = await allByAge();
    const names = rows.map((r) => r.displayName).sort();
    expect(names).toEqual(["Eighteen", "Renamed", "Ten"]);
  });

  it("updateMany with an equality WHERE syncs the tracked in-memory instance", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    const rows = await buf.find(User, { orderBy: { age: "ASC" } as any });
    const forty = rows.find((r: any) => r.age === 40);

    buf.updateMany(User, { where: { age: 40 }, set: { role: "senior" } });
    await buf.flush();

    // Equality WHERE → precise in-memory sync.
    expect(forty.role).toBe("senior");
  });

  it("operator-WHERE updateMany does not leave a stale tracked instance behind", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();

    // Resolve the age=40 row's PK dynamically (autoincrement drifts across tests).
    const [forty] = await conn.em.find(User, { where: { age: 40 } as any });
    const id40 = forty.id;

    // Track it in the buffer's identity map via a PK lookup (cacheable).
    const tracked = await buf.findOne(User, { where: { id: id40 } as any });
    expect(tracked).not.toBeNull();
    expect((tracked as any).role).toBe("minor");

    buf.updateMany(User, { where: { age: { gte: 40 } }, set: { role: "adult" } });
    await buf.flush();

    // The DB row is now role="adult". A subsequent PK-cache probe must not
    // serve a stale identity-map hit still carrying role="minor".
    const reread = await buf.findOne(User, { where: { id: id40 } as any });
    expect(reread!.role).toBe("adult");
  });
});

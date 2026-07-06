/**
 * SQLite In-Memory: WriteBuffer identity-map read consistency.
 *
 * Regression for the audited cache-pollution bug: buf.findOne() / buf.find()
 * unconditionally tracked whatever em returned, so a NON-CANONICAL read would
 * poison the identity map for later canonical reads:
 *
 *   - Partial `select` — a row loaded with only some columns became the cached
 *     instance; a later full PK findOne() returned that partial (missing
 *     columns read back as undefined).
 *   - `withDeleted` — a soft-deleted row got tracked; a later normal PK
 *     findOne() (which must exclude trashed rows) returned the soft-deleted
 *     instance from cache instead of null.
 *
 * The fix: non-canonical reads (select / withDeleted / onlyDeleted /
 * withoutTenantScope) never create a NEW identity-map entry. They return the
 * requested row as-is (or the already-tracked canonical instance if one
 * exists), leaving the cache uncorrupted.
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
  DeletedAt,
} from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer read consistency (identity-map pollution)", () => {
  let conn: TestConnectionResult;
  let User: new () => any;

  beforeAll(async () => {
    const className = shortName("RcUser");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const UC = class {} as any;
        Object.defineProperty(UC, "name", { value: className });
        Reflect.defineMetadata("design:type", Number, UC.prototype, "id");
        PrimaryGeneratedColumn()(UC.prototype, "id");
        Reflect.defineMetadata("design:type", String, UC.prototype, "name");
        Column()(UC.prototype, "name");
        Reflect.defineMetadata("design:type", String, UC.prototype, "email");
        Column({ nullable: true })(UC.prototype, "email");
        Reflect.defineMetadata("design:type", Date, UC.prototype, "deletedAt");
        DeletedAt()(UC.prototype, "deletedAt");
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
    await conn.em.clear(User);
  });

  it("a partial-select read does not poison a later full PK read", async () => {
    const saved = await conn.em.save(User, {
      name: "Alice",
      email: "alice@example.com",
    } as any);
    const buf: WriteBuffer = (conn.em as any).buffer();

    // Non-canonical read: only id + name.
    const partial = await buf.findOne(User, {
      where: { id: saved.id } as any,
      select: ["id", "name"] as any,
    });
    expect(partial).not.toBeNull();
    expect((partial as any).email).toBeUndefined();

    // Canonical full PK read must return every column, not the cached partial.
    const full = await buf.findOne(User, { where: { id: saved.id } as any });
    expect(full).not.toBeNull();
    expect((full as any).email).toBe("alice@example.com");
  });

  it("a withDeleted read does not poison a later normal PK read", async () => {
    const saved = await conn.em.save(User, {
      name: "Bob",
      email: "bob@example.com",
    } as any);
    await conn.em.softDelete(User, { id: saved.id } as any);

    const buf: WriteBuffer = (conn.em as any).buffer();

    // Non-canonical read: includes the soft-deleted row.
    const trashed = await buf.findOne(User, {
      where: { id: saved.id } as any,
      withDeleted: true,
    });
    expect(trashed).not.toBeNull();

    // A normal PK read must exclude trashed rows → null, not the cached
    // soft-deleted instance.
    const normal = await buf.findOne(User, { where: { id: saved.id } as any });
    expect(normal).toBeNull();
  });

  it("an already-tracked full instance is returned by a later partial read (identity preserved)", async () => {
    const saved = await conn.em.save(User, {
      name: "Carol",
      email: "carol@example.com",
    } as any);
    const buf: WriteBuffer = (conn.em as any).buffer();

    // Canonical read first → tracked, full.
    const full = await buf.findOne(User, { where: { id: saved.id } as any });
    expect((full as any).email).toBe("carol@example.com");

    // A later partial read returns the SAME tracked instance (still full),
    // never a downgraded partial.
    const partial = await buf.findOne(User, {
      where: { id: saved.id } as any,
      select: ["id", "name"] as any,
    });
    expect(partial).toBe(full);
    expect((partial as any).email).toBe("carol@example.com");
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataContext } from "../../src/metadata/MetadataContext";

/**
 * Unit coverage for findByPKsMap() — the batch-load / data-loader helper that
 * returns a Map keyed by primary key for O(1) lookup. Each suite builds an
 * in-memory SQLite EM, seeds rows, and asserts the map's keys, values, size
 * and miss behaviour (the database does not guarantee result order, so the
 * map is how callers reliably reassemble and detect missing ids).
 */
describe("findByPKsMap()", () => {
  async function makeEm(entities: any[]) {
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
      },
      `t_${Math.random().toString(36).slice(2, 10)}`,
    );
    return em;
  }

  beforeEach(() => MetadataContext.reset());

  @Entity()
  class User {
    @PrimaryGeneratedColumn() id!: number;
    @Column() name!: string;
  }

  @Entity()
  class OrderItem {
    @PrimaryColumn({ type: "int" }) orderId!: number;
    @PrimaryColumn({ type: "int" }) productId!: number;
    @Column({ type: "int" }) quantity!: number;
  }

  // ── single-column PK ──────────────────────────────────────────────────────

  describe("single-column PK", () => {
    it("returns a Map keyed by raw PK value with the matching entity values", async () => {
      const em = await makeEm([User]);
      try {
        const a: any = await em.save(User, { name: "Alice" });
        const b: any = await em.save(User, { name: "Bob" });

        const map = await em.findByPKsMap(User, [a.id, b.id]);

        expect(map).toBeInstanceOf(Map);
        expect(map.get(a.id)).toMatchObject({ id: a.id, name: "Alice" });
        expect(map.get(b.id)).toMatchObject({ id: b.id, name: "Bob" });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("omits missing ids so callers detect misses via map.has(id)", async () => {
      const em = await makeEm([User]);
      try {
        const a: any = await em.save(User, { name: "Alice" });
        const missingId = a.id + 9999;

        const map = await em.findByPKsMap(User, [a.id, missingId]);

        expect(map.has(a.id)).toBe(true);
        expect(map.has(missingId)).toBe(false);
        expect(map.get(missingId)).toBeUndefined();
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("map size equals the number of rows found, not ids requested", async () => {
      const em = await makeEm([User]);
      try {
        const a: any = await em.save(User, { name: "Alice" });
        const b: any = await em.save(User, { name: "Bob" });

        // Three ids requested (one bogus, one duplicate) → two rows found.
        const map = await em.findByPKsMap(User, [a.id, b.id, a.id, 100000]);

        expect(map.size).toBe(2);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("returns an empty Map for an empty id list", async () => {
      const em = await makeEm([User]);
      try {
        const map = await em.findByPKsMap(User, []);
        expect(map.size).toBe(0);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });

    it("enables reassembly in input order with misses as null", async () => {
      const em = await makeEm([User]);
      try {
        const a: any = await em.save(User, { name: "Alice" });
        const b: any = await em.save(User, { name: "Bob" });
        const ids = [b.id, 77777, a.id];

        const map = await em.findByPKsMap(User, ids);
        const ordered = ids.map((id) => (map.get(id) as any)?.name ?? null);

        expect(ordered).toEqual(["Bob", null, "Alice"]);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── composite PK ──────────────────────────────────────────────────────────

  describe("composite PK", () => {
    it("keys the Map by a stable 'prop=value,prop=value' string in declared order", async () => {
      const em = await makeEm([OrderItem]);
      try {
        await em.save(OrderItem, { orderId: 1, productId: 10, quantity: 2 });
        await em.save(OrderItem, { orderId: 1, productId: 20, quantity: 3 });
        await em.save(OrderItem, { orderId: 2, productId: 10, quantity: 4 });

        const map = await em.findByPKsMap(OrderItem, [
          { orderId: 1, productId: 10 },
          { orderId: 1, productId: 20 },
          { orderId: 9, productId: 99 }, // missing
        ]);

        expect(map.size).toBe(2);
        expect(map.has("orderId=1,productId=10")).toBe(true);
        expect(map.has("orderId=1,productId=20")).toBe(true);
        expect(map.has("orderId=9,productId=99")).toBe(false);
        expect(map.get("orderId=1,productId=10")).toMatchObject({
          orderId: 1,
          productId: 10,
          quantity: 2,
        });
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });

  // ── BaseRepository delegation ─────────────────────────────────────────────

  describe("BaseRepository delegation", () => {
    it("repo.findByPKsMap returns the same Map as em.findByPKsMap", async () => {
      const em = await makeEm([User]);
      try {
        const a: any = await em.save(User, { name: "Alice" });
        const b: any = await em.save(User, { name: "Bob" });

        const repo = em.getRepository(User);
        const map = await repo.findByPKsMap([a.id, b.id, 424242]);

        expect(map).toBeInstanceOf(Map);
        expect(map.size).toBe(2);
        expect((map.get(a.id) as any)?.name).toBe("Alice");
        expect((map.get(b.id) as any)?.name).toBe("Bob");
        expect(map.has(424242)).toBe(false);
      } finally {
        await em.propagateShutdown({ closeConnections: true });
      }
    });
  });
});

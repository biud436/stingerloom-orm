/**
 * SQLite In-Memory: EntityManager entity-construction helpers.
 *
 * Exercises the new usability methods end-to-end against real SQL:
 *   - create()          builds a hydrated instance WITHOUT persisting
 *   - merge()           combines partial patches into an instance (in-memory)
 *   - preload()         loads a row by PK and merges a patch onto it
 *   - findOneByOrFail() filter-first "get or throw" read
 *
 * The audit lesson applies: mock-based unit tests hid real data bugs, so these
 * assertions go through a live better-sqlite3 database and re-read persisted
 * rows rather than trusting return values.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, EntityNotFoundError } from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { generateTableName } from "../helpers/create-test-entity";

describe("[Integration] SQLite: EntityManager construction helpers", () => {
  let conn: TestConnectionResult;
  let User: new () => any;

  beforeAll(async () => {
    const className = generateTableName("factory_user");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        const U = class {
          // Prototype method — proves create()/preload() return real instances,
          // not plain objects.
          greeting(): string {
            return `Hi ${(this as any).name}`;
          }
        } as any;
        Object.defineProperty(U, "name", { value: className, writable: false });

        Reflect.defineMetadata("design:type", Number, U.prototype, "id");
        PrimaryGeneratedColumn()(U.prototype, "id");

        Reflect.defineMetadata("design:type", String, U.prototype, "name");
        Column()(U.prototype, "name");

        Reflect.defineMetadata("design:type", String, U.prototype, "email");
        Column({ type: "varchar", nullable: true })(U.prototype, "email");

        Reflect.defineMetadata("design:type", String, U.prototype, "role");
        Column({ type: "varchar", nullable: true })(U.prototype, "role");

        Entity()(U);

        User = U;
        return { entities: [U] };
      },
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    await conn.em.clear(User);
  });

  // ── create ────────────────────────────────────────────────
  describe("create()", () => {
    it("builds a real instance without persisting it", async () => {
      const user = conn.em.create(User, { name: "Alice", email: "a@x.com" });

      expect(user).toBeInstanceOf(User);
      expect(user.name).toBe("Alice");
      expect(user.email).toBe("a@x.com");
      expect(user.greeting()).toBe("Hi Alice"); // prototype method survives

      // Nothing was written.
      expect(await conn.em.count(User)).toBe(0);
    });

    it("builds an empty instance when no data is given", () => {
      const user = conn.em.create(User);
      expect(user).toBeInstanceOf(User);
      expect(user.name).toBeUndefined();
    });

    it("builds an array of instances from an array of data", () => {
      const users = conn.em.create(User, [{ name: "A" }, { name: "B" }]);
      expect(Array.isArray(users)).toBe(true);
      expect(users).toHaveLength(2);
      expect(users[0]).toBeInstanceOf(User);
      expect(users.map((u: any) => u.name)).toEqual(["A", "B"]);
    });

    it("a created instance can be handed to save() and persists", async () => {
      const user = conn.em.create(User, { name: "Alice", email: "a@x.com" });
      const saved = await conn.em.save(User, user);

      expect(saved.id).toBeDefined();
      const row = await conn.em.findByPK(User, saved.id);
      expect(row?.name).toBe("Alice");
      expect(row?.email).toBe("a@x.com");
    });
  });

  // ── merge ─────────────────────────────────────────────────
  describe("merge()", () => {
    it("applies later patches over earlier ones and returns the target", () => {
      const user = conn.em.create(User, { name: "A", email: "a@x.com" });
      const result = conn.em.merge(user, { name: "B" }, { role: "admin" });

      expect(result).toBe(user); // same reference, mutated in place
      expect(user.name).toBe("B");
      expect(user.role).toBe("admin");
      expect(user.email).toBe("a@x.com"); // untouched key preserved
    });

    it("skips undefined source values but assigns explicit null", () => {
      const user = conn.em.create(User, { name: "A", email: "a@x.com" });
      conn.em.merge(user, { email: undefined as any, role: null as any });

      expect(user.email).toBe("a@x.com"); // undefined did not null it out
      expect(user.role).toBeNull(); // explicit null assigned
    });

    it("deep-merges nested plain objects instead of replacing them", () => {
      const target: any = { profile: { bio: "old", age: 30 } };
      conn.em.merge(target, { profile: { bio: "new" } } as any);

      expect(target.profile).toEqual({ bio: "new", age: 30 });
    });

    it("replaces arrays and Date values wholesale", () => {
      const d1 = new Date("2020-01-01");
      const d2 = new Date("2021-01-01");
      const target: any = { tags: ["a", "b"], at: d1 };
      conn.em.merge(target, { tags: ["c"], at: d2 } as any);

      expect(target.tags).toEqual(["c"]);
      expect(target.at).toBe(d2);
    });
  });

  // ── preload ───────────────────────────────────────────────
  describe("preload()", () => {
    it("loads the row by PK and merges the patch, preserving unspecified columns", async () => {
      const saved = await conn.em.save(User, {
        name: "Alice",
        email: "a@x.com",
        role: "user",
      });

      const preloaded = await conn.em.preload(User, {
        id: saved.id,
        name: "Renamed",
      });

      expect(preloaded).toBeInstanceOf(User);
      expect(preloaded!.id).toBe(saved.id);
      expect(preloaded!.name).toBe("Renamed"); // patched
      expect(preloaded!.email).toBe("a@x.com"); // preserved from DB
      expect(preloaded!.role).toBe("user"); // preserved from DB
    });

    it("the preloaded instance persists a partial update via save()", async () => {
      const saved = await conn.em.save(User, {
        name: "Alice",
        email: "a@x.com",
      });

      const preloaded = await conn.em.preload(User, {
        id: saved.id,
        name: "Renamed",
      });
      await conn.em.save(User, preloaded!);

      const row = await conn.em.findByPK(User, saved.id);
      expect(row?.name).toBe("Renamed");
      expect(row?.email).toBe("a@x.com"); // untouched column intact after update
    });

    it("returns undefined when no row matches the primary key", async () => {
      const result = await conn.em.preload(User, { id: 999999, name: "x" });
      expect(result).toBeUndefined();
    });

    it("returns undefined (no query) when the patch lacks a primary key", async () => {
      const result = await conn.em.preload(User, { name: "x" });
      expect(result).toBeUndefined();
    });
  });

  // ── findOneByOrFail ───────────────────────────────────────
  describe("findOneByOrFail()", () => {
    it("returns the matching row", async () => {
      await conn.em.save(User, { name: "Alice", email: "a@x.com" });
      const user = await conn.em.findOneByOrFail(User, { name: "Alice" });
      expect(user.name).toBe("Alice");
    });

    it("throws EntityNotFoundError when nothing matches", async () => {
      await expect(
        conn.em.findOneByOrFail(User, { name: "nobody" }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });

  // ── Repository parity ─────────────────────────────────────
  describe("BaseRepository parity", () => {
    it("exposes create/merge/preload/findOneByOrFail delegating to the EM", async () => {
      const repo = conn.em.getRepository(User);

      const built = repo.create({ name: "Repo", email: "r@x.com" });
      expect(built).toBeInstanceOf(User);
      expect(built.name).toBe("Repo");

      repo.merge(built, { role: "admin" });
      expect(built.role).toBe("admin");

      const saved = await repo.save(built);
      const preloaded = await repo.preload({ id: saved.id, name: "Repo2" });
      expect(preloaded!.name).toBe("Repo2");
      expect(preloaded!.email).toBe("r@x.com");

      const found = await repo.findOneByOrFail({ name: "Repo" });
      expect(found.id).toBe(saved.id);

      await expect(
        repo.findOneByOrFail({ name: "ghost" }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });
  });
});

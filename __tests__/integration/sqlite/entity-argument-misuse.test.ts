/**
 * Entity-argument misuse at the root entry points, on a live SQLite
 * EntityManager (V5-T2-3).
 *
 * Fail-before (main 187f3a3): `em.find(new User())` → `Entity metadata for
 * "undefined" does not exist`; `em.find(undefined)` → bare `TypeError` from
 * `Reflect.getMetadata`; `em.find(Plain)` on a scoped connection → "its
 * metadata exists, but the class is missing from that connection's
 * entities array" (false — it has no metadata); `em.getRepository(new
 * User())` and `em.createQueryBuilder(new User(), "u")` did not throw until
 * the first query.
 *
 * Runs only under INTEGRATION_TEST=true.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  defineEntity,
  t,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { EntityMetadataNotFoundError } from "../../../src/errors/EntityMetadataNotFoundError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "eam_users" })
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;
}

@Entity({ name: "eam_posts" })
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;
}

// Decorated and imported, but not in the scoped connection's entities.
@Entity({ name: "eam_outside" })
class Outside {
  @PrimaryGeneratedColumn()
  id!: number;
}

const Tag = defineEntity("eam_tags", {
  id: t.int().primary().generated(),
  label: t.varchar(40),
});

class Plain {
  id!: number;
}

async function capture(fn: () => unknown): Promise<EntityMetadataNotFoundError> {
  try {
    await fn();
  } catch (e) {
    return e as EntityMetadataNotFoundError;
  }
  throw new Error("expected the call to throw");
}

describe("entity-argument misuse on a live EntityManager", () => {
  let scoped: EntityManager;
  let unscoped: EntityManager;

  beforeAll(async () => {
    scoped = await createTestEntityManager({
      entities: [User, Post, Tag],
      connectionName: "eam_scoped",
    });
    unscoped = await createTestEntityManager({
      entities: [] as any,
      connectionName: "eam_unscoped",
    });
  });

  afterAll(async () => {
    await scoped.propagateShutdown();
    await unscoped.propagateShutdown();
  });

  describe("scoped connection", () => {
    it("(a) instance: find(new User()) names the instance and lists the registered entities", async () => {
      const err = await capture(() => scoped.find(new User() as any, {}));
      expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
      expect(err.code).toBe(OrmErrorCode.ENTITY_METADATA_NOT_FOUND);
      expect(err.message).toContain("find() received an instance of User where the entity class was expected.");
      expect(err.suggestion).toBe(
        "Pass the class itself as the first argument: em.find(User, ...). " +
          "An instance is persisted with em.save(User, instance). " +
          'Registered on connection "eam_scoped": User, Post, eam_tags.',
      );
    });

    it("(a) instance: save(user) without the class is the same diagnosis", async () => {
      const user = new User();
      user.name = "a";
      const err = await capture(() => (scoped as any).save(user));
      expect(err.message).toContain("save() received an instance of User where the entity class was expected.");
      expect(err.suggestion).toContain("em.save(User, instance)");
    });

    it("(b) undecorated class: no longer claims its metadata exists", async () => {
      const err = await capture(() => scoped.find(Plain as any, {}));
      expect(err.message).toContain('Entity metadata for "Plain" does not exist.');
      expect(err.message).toContain(
        "find() received the class Plain, which is not decorated with @Entity() and was not created by defineEntity() or EntitySchema.",
      );
      expect(err.message).not.toContain("its metadata exists");
      expect(err.suggestion).toContain("Decorate Plain with @Entity()");
      expect(err.suggestion).toContain('Registered on connection "eam_scoped": User, Post, eam_tags.');
    });

    it("(b) undecorated class with a near-miss name gets a closest-match hint", async () => {
      const err = await capture(() => scoped.find(class Users {} as any, {}));
      expect(err.suggestion).toContain('Did you mean "User"?');
    });

    it("(c) undefined / null: EntityMetadataNotFoundError instead of a TypeError", async () => {
      const u = await capture(() => scoped.find(undefined as any, {}));
      expect(u).toBeInstanceOf(EntityMetadataNotFoundError);
      expect(u.message).toContain("find() received undefined where an entity class was expected.");
      expect(u.suggestion).toContain("circular import or a missing export");

      const n = await capture(() => scoped.findOne(null as any, { where: { id: 1 } } as any));
      expect(n.message).toContain("findOne() received null where an entity class was expected.");
    });

    it("(d) thunk and uncalled factory: not a class", async () => {
      const thunk = await capture(() => scoped.find((() => User) as any, {}));
      expect(thunk.message).toContain("find() received an anonymous function which is not a class.");
      expect(thunk.suggestion).toContain("If it is a thunk such as () => User, pass the class it returns.");

      const factory = await capture(() => scoped.find(defineEntity as any, {}));
      expect(factory.message).toContain('Entity metadata for "defineEntity" does not exist.');
      expect(factory.suggestion).toContain("defineEntity is the factory itself");
    });

    it("string: entities are referenced by class, with a closest match", async () => {
      const err = await capture(() => scoped.find("user" as any, {}));
      expect(err.message).toContain('find() received the string "user" where an entity class was expected.');
      expect(err.suggestion).toContain('Did you mean "User"?');
      expect(err.suggestion).toContain('Registered on connection "eam_scoped"');
    });

    it("plain object: the object belongs in the payload argument", async () => {
      const err = await capture(() => (scoped as any).save({ name: "a" }));
      expect(err.message).toContain("save() received a plain object where an entity class was expected.");
      expect(err.suggestion).toContain("the object belongs in the payload or criteria argument");
    });

    it("out-of-scope entity keeps its message and now lists the registered entities", async () => {
      const err = await capture(() => scoped.find(Outside, {}));
      expect(err.message).toContain(
        'Entity "Outside" is not registered on connection "eam_scoped": its metadata exists, but the class is missing from that connection\'s "entities" array.',
      );
      expect(err.suggestion).toContain('Registered on connection "eam_scoped": User, Post, eam_tags.');
    });

    it("getRepository / createQueryBuilder / builders / ref reject at the call, not on the first query", () => {
      expect(() => scoped.getRepository(new User() as any)).toThrow(EntityMetadataNotFoundError);
      expect(() => scoped.getRepository(new User() as any)).toThrow(
        "getRepository() received an instance of User where the entity class was expected.",
      );
      expect(() => scoped.createQueryBuilder(new User() as any, "u")).toThrow(
        "createQueryBuilder() received an instance of User where the entity class was expected.",
      );
      expect(() => scoped.createUpdateBuilder(new User() as any)).toThrow(
        "createUpdateBuilder() received an instance of User where the entity class was expected.",
      );
      expect(() => scoped.createInsertBuilder(new User() as any)).toThrow(
        "createInsertBuilder() received an instance of User where the entity class was expected.",
      );
      expect(() => scoped.ref(new User() as any, "u")).toThrow(
        "ref() received an instance of User where the entity class was expected.",
      );
    });

    it("every read/write/aggregate entry point names itself", async () => {
      const anyScoped = scoped as any;
      const calls: Array<[string, () => unknown]> = [
        ["findBy", () => anyScoped.findBy(new User() as any, {} as any)],
        ["findAndCount", () => anyScoped.findAndCount(new User() as any)],
        ["findWithPage", () => anyScoped.findWithPage(new User() as any, { page: 1, pageSize: 10 } as any)],
        ["findWithCursor", () => anyScoped.findWithCursor(new User() as any, {} as any)],
        ["pluck", () => anyScoped.pluck(new User() as any, "id" as any)],
        ["exists", () => anyScoped.exists(new User() as any, {} as any)],
        ["findByPK", () => anyScoped.findByPK(new User() as any, 1)],
        ["count", () => anyScoped.count(new User() as any)],
        ["sum", () => anyScoped.sum(new User() as any, "id" as any)],
        ["explain", () => anyScoped.explain(new User() as any, {} as any)],
        ["saveMany", () => anyScoped.saveMany(new User() as any, [])],
        ["insertMany", () => anyScoped.insertMany(new User() as any, [])],
        ["update", () => anyScoped.update(new User() as any, { name: "b" } as any, { id: 1 } as any)],
        ["updateMany", () => anyScoped.updateMany(new User() as any, { name: "b" } as any, { where: { id: 1 } } as any)],
        ["delete", () => anyScoped.delete(new User() as any, { id: 1 } as any)],
        ["deleteMany", () => anyScoped.deleteMany(new User() as any, [1])],
        ["softDelete", () => anyScoped.softDelete(new User() as any, { id: 1 } as any)],
        ["restore", () => anyScoped.restore(new User() as any, { id: 1 } as any)],
        ["upsert", () => anyScoped.upsert(new User() as any, { name: "b" } as any, ["id"] as any)],
        ["clear", () => anyScoped.clear(new User() as any)],
      ];
      for (const [method, call] of calls) {
        const err = await capture(call);
        expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
        expect(err.message).toContain(`${method}() received an instance of User where the entity class was expected.`);
      }
    });

    it("a rejected argument does not poison the connection: valid calls keep working", async () => {
      await capture(() => scoped.find(new User() as any, {}));
      const saved = await scoped.save(User, { name: "ok" });
      expect(saved.id).toBeGreaterThan(0);
      expect(await scoped.count(User)).toBe(1);
      expect(await scoped.getRepository(User).find({})).toHaveLength(1);
      expect(await scoped.createQueryBuilder(User, "u").getMany()).toHaveLength(1);
      expect(await scoped.find(Tag, {})).toEqual([]);
      await scoped.delete(User, { id: saved.id });
    });
  });

  describe("unscoped connection (entities: [])", () => {
    it("diagnoses the same misuse and lists the entities the store knows", async () => {
      const inst = await capture(() => unscoped.find(new Post() as any, {}));
      expect(inst.message).toContain("find() received an instance of Post where the entity class was expected.");
      expect(inst.suggestion).toMatch(/Registered on connection "eam_unscoped": .*User.*Post/);

      const undef = await capture(() => unscoped.count(undefined as any));
      expect(undef).toBeInstanceOf(EntityMetadataNotFoundError);
      expect(undef.message).toContain("count() received undefined where an entity class was expected.");

      const plain = await capture(() => unscoped.find(Plain as any, {}));
      expect(plain.message).toContain('Entity metadata for "Plain" does not exist.');
      expect(plain.message).toContain("find() received the class Plain");

      const thunk = await capture(() => unscoped.delete((() => Post) as any, { id: 1 } as any));
      expect(thunk.message).toContain("delete() received an anonymous function which is not a class.");
    });

    it("still serves every decorated entity", async () => {
      expect(await unscoped.find(Outside, {})).toEqual([]);
      expect(await unscoped.find(User, {})).toEqual([]);
    });
  });
});

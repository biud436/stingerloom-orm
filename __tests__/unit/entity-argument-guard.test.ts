/**
 * Entity-argument guard (V5-T2-3).
 *
 * `em.find(new User())`, `em.find(Plain)`, `em.find(undefined)` and
 * `em.find(() => User)` all used to reach metadata resolution and die with
 * `Entity metadata for "undefined" does not exist` (or a bare TypeError from
 * `Reflect.getMetadata`). The guard classifies the first argument at the root
 * entry points and names the mistake, the registered entities and the
 * closest match. Error class and code are unchanged.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  defineEntity,
  t,
} from "../../src";
import { EntityManager } from "../../src/core/EntityManager";
import {
  assertEntityClassArgument,
  classifyEntityArgument,
  diagnoseEntityArgument,
  hasEntityMetadata,
  listKnownEntityNames,
} from "../../src/core/entity-manager/EntityArgumentGuard";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

@Entity({ name: "eag_users" })
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;
}

@Entity({ name: "eag_posts" })
class Post {
  @PrimaryGeneratedColumn()
  id!: number;
}

const Tag = defineEntity("eag_tags", {
  id: t.int().primary().generated(),
});

/** Not decorated: the metadata is inherited from User through the prototype chain. */
class UserSubclass extends User {}

class Plain {
  id!: number;
}

function legacyFunction() {
  return 1;
}

const REGISTERED = ["User", "Post", "Tag"];

async function capture(promise: Promise<unknown> | (() => unknown)): Promise<EntityMetadataNotFoundError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (e) {
    return e as EntityMetadataNotFoundError;
  }
  throw new Error("expected the call to throw");
}

describe("classifyEntityArgument", () => {
  it("accepts decorated, defineEntity and inherited classes as entities", () => {
    expect(classifyEntityArgument(User)).toEqual({ kind: "entity", name: "User" });
    expect(classifyEntityArgument(Tag).kind).toBe("entity");
    expect(classifyEntityArgument(UserSubclass)).toEqual({ kind: "entity", name: "UserSubclass" });
  });

  it("classifies undefined and null as nullish", () => {
    expect(classifyEntityArgument(undefined)).toEqual({ kind: "nullish", name: "undefined" });
    expect(classifyEntityArgument(null)).toEqual({ kind: "nullish", name: "null" });
  });

  it("classifies every primitive", () => {
    expect(classifyEntityArgument("User")).toEqual({ kind: "primitive", name: "User" });
    expect(classifyEntityArgument(42).kind).toBe("primitive");
    expect(classifyEntityArgument(true).kind).toBe("primitive");
    expect(classifyEntityArgument(Symbol("x")).kind).toBe("primitive");
    expect(classifyEntityArgument(10n).kind).toBe("primitive");
  });

  it("classifies instances by their constructor", () => {
    expect(classifyEntityArgument(new User())).toEqual({ kind: "instance", name: "User" });
    expect(classifyEntityArgument(new Plain())).toEqual({ kind: "instance", name: "Plain" });
  });

  it("classifies object literals, arrays and prototype-less objects as plain objects", () => {
    expect(classifyEntityArgument({ id: 1 })).toEqual({ kind: "plain-object", name: "Object" });
    expect(classifyEntityArgument([User])).toEqual({ kind: "plain-object", name: "Array" });
    expect(classifyEntityArgument(Object.create(null)).kind).toBe("plain-object");
  });

  it("classifies functions without a prototype as non-constructors", () => {
    expect(classifyEntityArgument(() => User)).toEqual({ kind: "non-constructor", name: "" });
    const thunk = () => User;
    expect(classifyEntityArgument(thunk)).toEqual({ kind: "non-constructor", name: "thunk" });
    expect(classifyEntityArgument(legacyFunction.bind(null)).kind).toBe("non-constructor");
    expect(classifyEntityArgument(async () => User).kind).toBe("non-constructor");
  });

  it("classifies undecorated classes and plain functions as unregistered classes", () => {
    expect(classifyEntityArgument(Plain)).toEqual({ kind: "unregistered-class", name: "Plain" });
    expect(classifyEntityArgument(legacyFunction)).toEqual({ kind: "unregistered-class", name: "legacyFunction" });
    expect(classifyEntityArgument(defineEntity)).toEqual({ kind: "unregistered-class", name: "defineEntity" });
  });
});

describe("hasEntityMetadata", () => {
  it("is true for decorated, defineEntity and inheriting classes only", () => {
    expect(hasEntityMetadata(User)).toBe(true);
    expect(hasEntityMetadata(Tag)).toBe(true);
    expect(hasEntityMetadata(UserSubclass)).toBe(true);
    expect(hasEntityMetadata(Plain)).toBe(false);
    expect(hasEntityMetadata(legacyFunction)).toBe(false);
    expect(hasEntityMetadata(() => User)).toBe(false);
  });
});

describe("diagnoseEntityArgument — the four misuse messages", () => {
  it("returns null for an entity class", () => {
    expect(diagnoseEntityArgument(User, "find", REGISTERED)).toBeNull();
    expect(diagnoseEntityArgument(Tag, "find", REGISTERED)).toBeNull();
  });

  it("(a) instance: names the class and how to persist the instance", () => {
    const d = diagnoseEntityArgument(new User(), "find", REGISTERED)!;
    expect(d.kind).toBe("instance");
    expect(d.message).toBe("find() received an instance of User where the entity class was expected.");
    expect(d.suggestion).toBe(
      "Pass the class itself as the first argument: em.find(User, ...). " +
        "An instance is persisted with em.save(User, instance).",
    );
  });

  it("(a') instance of an undecorated class: reports both mistakes", () => {
    const d = diagnoseEntityArgument(new Plain(), "save", REGISTERED)!;
    expect(d.kind).toBe("instance");
    expect(d.message).toBe("save() received an instance of Plain where the entity class was expected.");
    expect(d.suggestion).toContain("Pass the class itself as the first argument: em.save(Plain, ...).");
    expect(d.suggestion).toContain("Plain carries no entity metadata either: decorate it with @Entity() or define it with defineEntity().");
  });

  it("(b) undecorated class: keeps the historical lead sentence and names the class", () => {
    const d = diagnoseEntityArgument(Plain, "find", REGISTERED)!;
    expect(d.kind).toBe("unregistered-class");
    expect(d.message).toBe(
      'Entity metadata for "Plain" does not exist. ' +
        "find() received the class Plain, which is not decorated with @Entity() and was not created by defineEntity() or EntitySchema.",
    );
    expect(d.suggestion).toContain("Decorate Plain with @Entity()");
    expect(d.suggestion).toContain("make sure its module is imported before the EntityManager connects");
    expect(d.suggestion).toContain("or define it with defineEntity()");
  });

  it("(b') undecorated class with a near miss gets a closest-match suggestion", () => {
    const d = diagnoseEntityArgument(class Users {}, "find", REGISTERED)!;
    expect(d.message).toContain('Entity metadata for "Users" does not exist.');
    expect(d.suggestion).toContain('Did you mean "User"?');
  });

  it("(c) undefined / null: says what was received and hints at circular imports", () => {
    const u = diagnoseEntityArgument(undefined, "findOne", REGISTERED)!;
    expect(u.kind).toBe("nullish");
    expect(u.message).toBe("findOne() received undefined where an entity class was expected.");
    expect(u.suggestion).toContain("Pass the entity class as the first argument, e.g. em.findOne(User, ...).");
    expect(u.suggestion).toContain("circular import or a missing export");

    const n = diagnoseEntityArgument(null, "delete", REGISTERED)!;
    expect(n.message).toBe("delete() received null where an entity class was expected.");
  });

  it("(d) thunk / arrow function: not a class, call it or pass the class it returns", () => {
    const d = diagnoseEntityArgument(() => User, "find", REGISTERED)!;
    expect(d.kind).toBe("non-constructor");
    expect(d.message).toBe("find() received an anonymous function which is not a class.");
    expect(d.suggestion).toBe(
      "If it is a thunk such as () => User, pass the class it returns. " +
        "If it is a factory, call it — did you forget the parentheses? — and pass the class it returns.",
    );

    const loadUser = () => User;
    expect(diagnoseEntityArgument(loadUser, "find", REGISTERED)!.message).toBe(
      'find() received the function "loadUser" which is not a class.',
    );
  });

  it("(d') defineEntity itself: says it is the factory and shows the call", () => {
    const d = diagnoseEntityArgument(defineEntity, "find", REGISTERED)!;
    expect(d.kind).toBe("unregistered-class");
    expect(d.message).toContain('Entity metadata for "defineEntity" does not exist.');
    expect(d.message).toContain("find() received the function defineEntity");
    expect(d.suggestion).toContain("defineEntity is the factory itself — call it at module load");
    expect(d.suggestion).toContain('const User = defineEntity("users", { ... })');
  });

  it("(d'') plain function with a prototype: covers the factory and the class reading", () => {
    const d = diagnoseEntityArgument(legacyFunction, "find", REGISTERED)!;
    expect(d.message).toContain("find() received the function legacyFunction");
    expect(d.suggestion).toContain("If legacyFunction is a factory, call it — did you forget the parentheses?");
    expect(d.suggestion).toContain("if it is a class, decorate it with @Entity()");
  });

  it("string: entities are referenced by class, with a closest-match hint", () => {
    const d = diagnoseEntityArgument("user", "find", REGISTERED)!;
    expect(d.kind).toBe("primitive");
    expect(d.message).toBe('find() received the string "user" where an entity class was expected.');
    expect(d.suggestion).toBe(
      "Entities are referenced by class, not by name — import the class and pass it, e.g. em.find(User, ...). " +
        'Did you mean "User"?',
    );
    expect(diagnoseEntityArgument("zzz", "find", REGISTERED)!.suggestion).not.toContain("Did you mean");
  });

  it("other primitives are described by type", () => {
    expect(diagnoseEntityArgument(42, "count", REGISTERED)!.message).toBe(
      "count() received the number 42 where an entity class was expected.",
    );
    expect(diagnoseEntityArgument(true, "count", REGISTERED)!.message).toContain("the boolean true");
    expect(diagnoseEntityArgument(7n, "count", REGISTERED)!.message).toContain("the bigint 7n");
    expect(diagnoseEntityArgument(Symbol("s"), "count", REGISTERED)!.message).toContain("a symbol");
  });

  it("plain object / array: the object belongs in the payload argument", () => {
    const o = diagnoseEntityArgument({ id: 1 }, "save", REGISTERED)!;
    expect(o.message).toBe("save() received a plain object where an entity class was expected.");
    expect(o.suggestion).toBe(
      "Pass the entity class as the first argument, e.g. em.save(User, ...); " +
        "the object belongs in the payload or criteria argument.",
    );
    expect(diagnoseEntityArgument([], "saveMany", REGISTERED)!.message).toBe(
      "saveMany() received an array where an entity class was expected.",
    );
  });
});

describe("assertEntityClassArgument", () => {
  it("returns for entity classes without building the registered list", () => {
    const registeredEntities = jest.fn(() => REGISTERED);
    expect(() =>
      assertEntityClassArgument(User, "find", { registeredEntities }),
    ).not.toThrow();
    expect(() =>
      assertEntityClassArgument(UserSubclass, "find", { registeredEntities }),
    ).not.toThrow();
    expect(registeredEntities).not.toHaveBeenCalled();
  });

  it("accepts a class the hasMetadata fallback vouches for (mocked or store-only metadata)", () => {
    expect(() =>
      assertEntityClassArgument(Plain, "find", { hasMetadata: (cls) => cls === Plain }),
    ).not.toThrow();
    expect(classifyEntityArgument(Plain, (cls) => cls === Plain)).toEqual({ kind: "entity", name: "Plain" });
    expect(diagnoseEntityArgument(new Plain(), "find", REGISTERED, (cls) => cls === Plain)!.suggestion).toContain(
      "An instance is persisted with em.save(Plain, instance).",
    );
    expect(() => assertEntityClassArgument(Plain, "find", { hasMetadata: () => false })).toThrow(
      'Entity metadata for "Plain" does not exist.',
    );
  });

  it("throws EntityMetadataNotFoundError with the unchanged code", () => {
    const err = (() => {
      try {
        assertEntityClassArgument(new User(), "find");
      } catch (e) {
        return e as EntityMetadataNotFoundError;
      }
      throw new Error("expected throw");
    })();
    expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
    expect(err).toBeInstanceOf(OrmError);
    expect(err.code).toBe(OrmErrorCode.ENTITY_METADATA_NOT_FOUND);
    expect(err.name).toBe("EntityMetadataNotFoundError");
  });

  it("appends the registered entities with the connection name", () => {
    let caught: EntityMetadataNotFoundError | undefined;
    try {
      assertEntityClassArgument(undefined, "find", {
        connectionName: "primary",
        registeredEntities: () => REGISTERED,
      });
    } catch (e) {
      caught = e as EntityMetadataNotFoundError;
    }
    expect(caught!.suggestion).toMatch(/ Registered on connection "primary": User, Post, Tag\.$/);
    // OrmError merges the suggestion into message; the diagnosis leads.
    expect(caught!.message).toMatch(/^find\(\) received undefined where an entity class was expected\.\nSuggestion: /);
  });

  it("omits the list when nothing is registered and cuts long lists", () => {
    let none: EntityMetadataNotFoundError | undefined;
    try {
      assertEntityClassArgument(undefined, "find", { connectionName: "primary", registeredEntities: () => [] });
    } catch (e) {
      none = e as EntityMetadataNotFoundError;
    }
    expect(none!.suggestion).not.toContain("Registered");

    const many = Array.from({ length: 15 }, (_, i) => `E${i}`);
    let cut: EntityMetadataNotFoundError | undefined;
    try {
      assertEntityClassArgument(undefined, "find", { registeredEntities: () => many });
    } catch (e) {
      cut = e as EntityMetadataNotFoundError;
    }
    expect(cut!.suggestion).toMatch(/ Registered entities: E0, E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11 … \(\+3 more\)\.$/);
  });
});

describe("listKnownEntityNames", () => {
  it("uses the scoped entities array when present", () => {
    expect(listKnownEntityNames([Post, User])).toEqual(["Post", "User"]);
  });

  it("falls back to the metadata store for an unscoped EntityManager", () => {
    const names = listKnownEntityNames([]);
    expect(names).toEqual(expect.arrayContaining(["User", "Post"]));
    expect(names).not.toContain("Plain");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("EntityMetadataNotFoundError — existing contracts", () => {
  it("keeps the default message and suggestion", () => {
    const err = new EntityMetadataNotFoundError("Unknown");
    expect(err.message).toBe(
      'Entity metadata for "Unknown" does not exist.\n' +
        'Suggestion: Ensure the class is decorated with @Entity() and included in the "entities" array of your DatabaseClientOptions.',
    );
  });

  it("keeps the out-of-scope message and adds the registered list", () => {
    const err = new EntityMetadataNotFoundError("Log", {
      connectionName: "primary",
      registeredEntities: ["User", "Post"],
    });
    expect(err.message).toContain(
      'Entity "Log" is not registered on connection "primary": its metadata exists, but the class is missing from that connection\'s "entities" array.',
    );
    expect(err.suggestion).toBe(
      'Add Log to the "entities" array of the DatabaseClientOptions registered under "primary", ' +
        "or query it through the EntityManager that registered it. " +
        'Registered on connection "primary": User, Post.',
    );
  });

  it("uses the argument diagnosis verbatim when given", () => {
    const err = new EntityMetadataNotFoundError("User", {
      connectionName: "primary",
      argument: { message: "m.", suggestion: "s." },
    });
    expect(err.message).toBe("m.\nSuggestion: s.");
    expect(err.suggestion).toBe("s.");
  });
});

describe("EntityManager root entry points (no database needed)", () => {
  const em = new EntityManager();

  it("find(instance) names the instance instead of undefined", async () => {
    const err = await capture(em.find(new User() as any, {}));
    expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
    expect(err.message).toContain("find() received an instance of User where the entity class was expected.");
    expect(err.message).not.toContain('"undefined"');
  });

  it("save(instance) without the class shows the em.save(User, instance) form", async () => {
    const err = await capture((em as any).save(new User()));
    expect(err.message).toContain("save() received an instance of User where the entity class was expected.");
    expect(err.suggestion).toContain("em.save(User, instance)");
  });

  it("findOne(undefined) is an EntityMetadataNotFoundError, not a TypeError", async () => {
    const err = await capture(em.findOne(undefined as any, { where: { id: 1 } } as any));
    expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
    expect(err.message).toContain("findOne() received undefined where an entity class was expected.");
  });

  it("delete(thunk) is reported as a non-class function", async () => {
    const err = await capture(em.delete((() => User) as any, { id: 1 } as any));
    expect(err.message).toContain("delete() received an anonymous function which is not a class.");
  });

  it("count(undecorated class) keeps the historical lead sentence", async () => {
    const err = await capture(em.count(class Unknown {} as any));
    expect(err.message).toContain('Entity metadata for "Unknown" does not exist.');
    expect(err.message).toContain("count() received the class Unknown");
  });

  it("getRepository / createQueryBuilder / createUpdateBuilder / createInsertBuilder / ref reject at the call", () => {
    expect(() => em.getRepository(new User() as any)).toThrow(
      "getRepository() received an instance of User where the entity class was expected.",
    );
    expect(() => em.createQueryBuilder("User" as any, "u")).toThrow(
      'createQueryBuilder() received the string "User" where an entity class was expected.',
    );
    expect(() => em.createUpdateBuilder(undefined as any)).toThrow(
      "createUpdateBuilder() received undefined where an entity class was expected.",
    );
    expect(() => em.createInsertBuilder({ id: 1 } as any)).toThrow(
      "createInsertBuilder() received a plain object where an entity class was expected.",
    );
    expect(() => em.ref(new User() as any, "u")).toThrow(
      "ref() received an instance of User where the entity class was expected.",
    );
  });

  it("names the calling method for every entry point", async () => {
    const anyEm = em as any;
      const calls: Array<[string, () => unknown]> = [
      ["findBy", () => anyEm.findBy(undefined as any, {} as any)],
      ["pluck", () => anyEm.pluck(undefined as any, "id" as any)],
      ["findWithCursor", () => anyEm.findWithCursor(undefined as any, {} as any)],
      ["findAndCount", () => anyEm.findAndCount(undefined as any)],
      ["findWithPage", () => anyEm.findWithPage(undefined as any, {} as any)],
      ["preload", () => anyEm.preload(undefined as any, {} as any)],
      ["saveMany", () => anyEm.saveMany(undefined as any, [])],
      ["insertMany", () => anyEm.insertMany(undefined as any, [])],
      ["insertManyAndReturn", () => anyEm.insertManyAndReturn(undefined as any, [])],
      ["deleteMany", () => anyEm.deleteMany(undefined as any, [1])],
      ["clear", () => anyEm.clear(undefined as any)],
      ["update", () => anyEm.update(undefined as any, {} as any, {} as any)],
      ["updateMany", () => anyEm.updateMany(undefined as any, {} as any, {} as any)],
      ["increment", () => anyEm.increment(undefined as any, {} as any, "n" as any, 1)],
      ["decrement", () => anyEm.decrement(undefined as any, {} as any, "n" as any, 1)],
      ["softDelete", () => anyEm.softDelete(undefined as any, {} as any)],
      ["restore", () => anyEm.restore(undefined as any, {} as any)],
      ["upsert", () => anyEm.upsert(undefined as any, {} as any, ["id"] as any)],
      ["insertIgnore", () => anyEm.insertIgnore(undefined as any, {} as any)],
      ["batchUpsert", () => anyEm.batchUpsert(undefined as any, [], ["id"] as any)],
      ["attachRelation", () => anyEm.attachRelation(undefined as any, 1, "tags" as any, [1])],
      ["detachRelation", () => anyEm.detachRelation(undefined as any, 1, "tags" as any, [1])],
      ["exists", () => anyEm.exists(undefined as any, {} as any)],
      ["findByPK", () => anyEm.findByPK(undefined as any, 1)],
      ["findByPKs", () => anyEm.findByPKs(undefined as any, [1])],
      ["findByPKsMap", () => anyEm.findByPKsMap(undefined as any, [1])],
      ["sum", () => anyEm.sum(undefined as any, "id" as any)],
      ["avg", () => anyEm.avg(undefined as any, "id" as any)],
      ["min", () => anyEm.min(undefined as any, "id" as any)],
      ["max", () => anyEm.max(undefined as any, "id" as any)],
      ["explain", () => anyEm.explain(undefined as any, {} as any)],
    ];
    for (const [method, call] of calls) {
      const err = await capture(call);
      expect(err).toBeInstanceOf(EntityMetadataNotFoundError);
      expect(err.message).toContain(`${method}() received undefined where an entity class was expected.`);
    }
  });

  it("streamBatch rejects on the first pull", async () => {
    const err = await capture(async () => {
      for await (const _ of em.streamBatch(new User() as any)) {
        void _;
      }
    });
    expect(err.message).toContain("streamBatch() received an instance of User where the entity class was expected.");
  });
});

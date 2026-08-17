/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { CascadeHandler } from "../../src/core/CascadeHandler";
import { HOOK_TOKEN, HookMetadata, HookEvent } from "../../src/decorators/Hooks";
import {
  ONE_TO_MANY_TOKEN,
  OneToManyMetadata,
} from "../../src/decorators/OneToMany";
import {
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../../src/decorators/ManyToOne";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityMetadataNotFoundError } from "../../src/errors/EntityMetadataNotFoundError";

// ---------------------------------------------------------------------------
// Helpers: mock EntityManagerInternals & RelationMetadataResolver
// ---------------------------------------------------------------------------
function createMockCtx(
  overrides?: Partial<EntityManagerInternals>,
): EntityManagerInternals {
  return {
    wrap: jest.fn((col: string) => `\`${col}\``),
    wrapTable: jest.fn((t: string) => `\`${t}\``),
    isMySqlFamily: jest.fn().mockReturnValue(true),
    isPostgres: jest.fn().mockReturnValue(false),
    getDriver: jest.fn().mockReturnValue(undefined),
    getSynchronize: jest.fn().mockReturnValue(false),
    getDialect: jest.fn().mockReturnValue("mysql"),
    getSchema: jest.fn().mockReturnValue(undefined),
    getConnection: jest.fn().mockReturnValue(undefined),
    executeInTransaction: jest.fn(),
    executeReadOnly: jest.fn(),
    beginTrackQuery: jest.fn(),
    trackQuery: jest.fn(),
    getReadNode: jest.fn().mockReturnValue(null),
    getEntities: jest.fn().mockReturnValue([]),
    getNameStrategy: jest.fn().mockReturnValue(""),
    resolveSelectColumns: jest.fn().mockReturnValue([]),
    markDirty: jest.fn(),
    findInternal: jest.fn(),
    findOneInternal: jest.fn(),
    save: jest.fn().mockImplementation((_e: any, item: any) =>
      Promise.resolve({ id: 99, ...item }),
    ),
    saveWithSession: jest.fn().mockImplementation((_e: any, item: any) =>
      Promise.resolve({ id: 99, ...item }),
    ),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  } as unknown as EntityManagerInternals;
}

function createMockResolver(
  overrides?: Partial<Record<keyof RelationMetadataResolver, any>>,
): RelationMetadataResolver {
  return {
    resolveEntityMetadata: jest.fn().mockReturnValue(null),
    resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
    resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyMetadata: jest.fn().mockReturnValue([]),
    resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    getDeletedAtColumn: jest.fn().mockReturnValue(null),
    getCreateTimestampColumn: jest.fn().mockReturnValue(null),
    getUpdateTimestampColumn: jest.fn().mockReturnValue(null),
    getVersionColumn: jest.fn().mockReturnValue(null),
    resolveJoinColumnsFromColumnMeta: jest.fn((_, rels) => rels),
    resolveJoinColumnsFromColumnMetaForOneToOne: jest.fn((_, rels) => rels),
    resolveManyToManyJoinTable: jest.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as RelationMetadataResolver;
}

// ---------------------------------------------------------------------------
// Test entity classes
// ---------------------------------------------------------------------------
class Parent {
  id!: number;
  name!: string;
}

class Child {
  id!: number;
  parentId!: number;
}

class Comment {
  id!: number;
  postId!: number;
}

// ==========================================================================
// describe: runHooks()
// ==========================================================================
describe("CascadeHandler.runHooks()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: CascadeHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new CascadeHandler(resolver, ctx);
  });

  afterEach(() => {
    // Clean up metadata
    Reflect.deleteMetadata(HOOK_TOKEN, Parent);
    Reflect.deleteMetadata(HOOK_TOKEN, Child);
  });

  it("should call hooks matching the event", async () => {
    const beforeInsertFn = jest.fn();
    class HookedEntity {
      id!: number;
      beforeInsert = beforeInsertFn;
    }

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [{ methodName: "beforeInsert", event: "beforeInsert" }] as HookMetadata[],
      HookedEntity,
    );

    const item = new HookedEntity();
    await handler.runHooks(HookedEntity, item, "beforeInsert");

    expect(beforeInsertFn).toHaveBeenCalledTimes(1);
  });

  it("should skip hooks for non-matching events", async () => {
    const beforeInsertFn = jest.fn();
    class HookedEntity {
      id!: number;
      beforeInsert = beforeInsertFn;
    }

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [{ methodName: "beforeInsert", event: "beforeInsert" }] as HookMetadata[],
      HookedEntity,
    );

    const item = new HookedEntity();
    await handler.runHooks(HookedEntity, item, "afterInsert");

    expect(beforeInsertFn).not.toHaveBeenCalled();
  });

  it("should handle empty HOOK_TOKEN metadata gracefully", async () => {
    Reflect.defineMetadata(HOOK_TOKEN, [], Parent);

    const item = { id: 1, name: "test" };
    // Should not throw
    await expect(handler.runHooks(Parent, item, "beforeInsert")).resolves.toBeUndefined();
  });

  it("should handle missing HOOK_TOKEN metadata gracefully", async () => {
    // No metadata defined at all for this class
    class NoHooksEntity {
      id!: number;
    }

    const item = new NoHooksEntity();
    await expect(handler.runHooks(NoHooksEntity, item, "beforeInsert")).resolves.toBeUndefined();
  });

  it("should await async hook methods", async () => {
    const callOrder: string[] = [];

    class AsyncHookedEntity {
      id!: number;
      async beforeInsert() {
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("hook-done");
      }
    }

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [{ methodName: "beforeInsert", event: "beforeInsert" }] as HookMetadata[],
      AsyncHookedEntity,
    );

    const item = new AsyncHookedEntity();
    await handler.runHooks(AsyncHookedEntity, item, "beforeInsert");
    callOrder.push("after-runHooks");

    // "hook-done" must come before "after-runHooks" because we await
    expect(callOrder).toEqual(["hook-done", "after-runHooks"]);
  });

  it("should call multiple matching hooks in order", async () => {
    const callOrder: string[] = [];

    class MultiHookEntity {
      id!: number;
      hookA() {
        callOrder.push("A");
      }
      hookB() {
        callOrder.push("B");
      }
      hookC() {
        callOrder.push("C");
      }
    }

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [
        { methodName: "hookA", event: "beforeInsert" },
        { methodName: "hookB", event: "beforeInsert" },
        { methodName: "hookC", event: "afterInsert" },
      ] as HookMetadata[],
      MultiHookEntity,
    );

    const item = new MultiHookEntity();
    await handler.runHooks(MultiHookEntity, item, "beforeInsert");

    // hookA and hookB called, hookC skipped (wrong event)
    expect(callOrder).toEqual(["A", "B"]);
  });

  it("should skip if methodName is not a function on the item", async () => {
    class BadHookEntity {
      id!: number;
      // notAFunction is not defined as a method
    }

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [{ methodName: "nonExistent", event: "beforeInsert" }] as HookMetadata[],
      BadHookEntity,
    );

    const item = new BadHookEntity();
    // Should not throw even though the method doesn't exist
    await expect(handler.runHooks(BadHookEntity, item, "beforeInsert")).resolves.toBeUndefined();
  });
});

// ==========================================================================
// describe: createProxy()
// ==========================================================================
describe("CascadeHandler.createProxy()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: CascadeHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new CascadeHandler(resolver, ctx);
  });

  it("should call markDirty on property assignment", () => {
    const original = { id: 1, name: "original" };
    const proxy = handler.createProxy(original);

    proxy.name = "changed";

    expect(ctx.markDirty).toHaveBeenCalledTimes(1);
    expect(ctx.markDirty).toHaveBeenCalledWith(original);
  });

  it("should read properties transparently", () => {
    const original = { id: 42, name: "hello" };
    const proxy = handler.createProxy(original);

    expect(proxy.id).toBe(42);
    expect(proxy.name).toBe("hello");
  });

  it("should actually set the value on the target", () => {
    const original = { id: 1, name: "old" };
    const proxy = handler.createProxy(original);

    proxy.name = "new";

    expect(original.name).toBe("new");
    expect(proxy.name).toBe("new");
  });

  it("should call markDirty on each property assignment", () => {
    const original = { id: 1, name: "a", email: "b" };
    const proxy = handler.createProxy(original);

    proxy.name = "x";
    proxy.email = "y";
    proxy.id = 2;

    expect(ctx.markDirty).toHaveBeenCalledTimes(3);
  });
});

// ==========================================================================
// describe: cascadeSaveOneToMany()
// ==========================================================================
describe("CascadeHandler.cascadeSaveOneToMany()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: CascadeHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new CascadeHandler(resolver, ctx);
  });

  it('should save children with FK set when cascade includes "insert"', async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["insert"],
      },
    ];

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
      },
    ] as any as ManyToOneMetadata<Parent>[];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);

    const child1 = { name: "child1" } as any;
    const child2 = { name: "child2" } as any;
    const parentItem = { id: 10, name: "parent", children: [child1, child2] } as any;

    await handler.cascadeSaveOneToMany(Parent, parentItem, 10);

    expect(ctx.save).toHaveBeenCalledTimes(2);
    // FK should have been set on children
    expect(child1.parentId).toBe(10);
    expect(child2.parentId).toBe(10);
  });

  it("should skip when no cascade is set", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        // no cascade
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);

    const parentItem = { id: 10, children: [{ name: "child1" }] } as any;
    await handler.cascadeSaveOneToMany(Parent, parentItem, 10);

    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should skip with empty children array", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["insert"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue([]);

    const parentItem = { id: 10, children: [] } as any;
    await handler.cascadeSaveOneToMany(Parent, parentItem, 10);

    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should skip when children property is undefined", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["insert"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);

    const parentItem = { id: 10 } as any; // no children property
    await handler.cascadeSaveOneToMany(Parent, parentItem, 10);

    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should use saveWithSession when session is provided", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["insert"],
      },
    ];

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);

    const fakeSession = {} as any;
    const parentItem = { id: 5, children: [{ name: "child1" }] } as any;

    await handler.cascadeSaveOneToMany(Parent, parentItem, 5, fakeSession);

    expect(ctx.saveWithSession).toHaveBeenCalledTimes(1);
    // The session must actually reach the child save (3rd argument), not just
    // select the saveWithSession branch — passing a different/undefined session
    // would run the child INSERT in its own transaction (#414's save-direction
    // twin). Covered end-to-end in
    // __tests__/integration/sqlite/core-cascade-write-path.test.ts.
    expect(ctx.saveWithSession).toHaveBeenCalledWith(
      Child,
      parentItem.children[0],
      fakeSession,
    );
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should fallback to mappedBy as FK column when no matching ManyToOne", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parentId",
        cascade: ["update"],
      },
    ];

    // No matching ManyToOne relation
    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue([]);

    const child = { name: "child1" } as any;
    const parentItem = { id: 7, children: [child] } as any;

    await handler.cascadeSaveOneToMany(Parent, parentItem, 7);

    // Uses mappedBy directly as FK column
    expect(child.parentId).toBe(7);
    expect(ctx.save).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// describe: cascadeSaveManyToOne()
// ==========================================================================
describe("CascadeHandler.cascadeSaveManyToOne()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: CascadeHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new CascadeHandler(resolver, ctx);
  });

  it("should save parent entity and set FK from parent PK", async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        option: { cascade: ["insert"] },
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    (ctx.save as jest.Mock).mockResolvedValue({ id: 42, name: "saved-parent" });

    const childItem = { parent: { name: "my-parent" }, parentId: undefined } as any;
    await handler.cascadeSaveManyToOne(Child, childItem);

    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.save).toHaveBeenCalledWith(Parent, { name: "my-parent" });
    // FK should be set from saved parent's PK
    expect(childItem.parentId).toBe(42);
  });

  it("should skip when relation value is not an object", async () => {
    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        option: { cascade: ["insert"] },
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);

    // parent is a plain number (already a FK ID), not an object
    const childItem = { parent: 5 } as any;
    await handler.cascadeSaveManyToOne(Child, childItem);

    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should skip when no cascade is set", async () => {
    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        // no cascade
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);

    const childItem = { parent: { name: "p" } } as any;
    await handler.cascadeSaveManyToOne(Child, childItem);

    expect(ctx.save).not.toHaveBeenCalled();
  });

  it("should throw EntityMetadataNotFoundError when parent metadata is missing", async () => {
    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        option: { cascade: ["insert"] },
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(null);
    (ctx.save as jest.Mock).mockResolvedValue({ id: 1 });

    const childItem = { parent: { name: "p" } } as any;
    await expect(handler.cascadeSaveManyToOne(Child, childItem)).rejects.toThrow(
      EntityMetadataNotFoundError,
    );
  });

  it("should skip FK assignment when no PK column found", async () => {
    const noPkMetadata = {
      name: "Parent",
      target: Parent,
      columns: [{ name: "name", options: {} }],
    };

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        option: { cascade: ["insert"] },
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(noPkMetadata);
    (ctx.save as jest.Mock).mockResolvedValue({ name: "saved" });

    const childItem = { parent: { name: "p" }, parentId: undefined } as any;
    await handler.cascadeSaveManyToOne(Child, childItem);

    // save should still be called
    expect(ctx.save).toHaveBeenCalledTimes(1);
    // but FK should NOT be set since there's no PK column
    expect(childItem.parentId).toBeUndefined();
  });

  it("should handle null relation value", async () => {
    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
        option: { cascade: ["insert"] },
      },
    ];

    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);

    const childItem = { parent: null } as any;
    await handler.cascadeSaveManyToOne(Child, childItem);

    expect(ctx.save).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// describe: cascadeDeleteOneToMany()
// ==========================================================================
describe("CascadeHandler.cascadeDeleteOneToMany()", () => {
  let ctx: EntityManagerInternals;
  let resolver: RelationMetadataResolver;
  let handler: CascadeHandler;

  beforeEach(() => {
    ctx = createMockCtx();
    resolver = createMockResolver();
    handler = new CascadeHandler(resolver, ctx);
  });

  it("should batch delete children via FK criteria (single parent)", async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["delete"],
      },
    ];

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (ctx.find as jest.Mock).mockResolvedValue([{ id: 10 }]);

    await handler.cascadeDeleteOneToMany(Parent, { id: 10 } as any);

    expect(ctx.delete).toHaveBeenCalledTimes(1);
    // single parent ID → direct equality
    expect(ctx.delete).toHaveBeenCalledWith(Child, { parentId: 10 });
  });

  it("should batch delete children via IN clause (multiple parents)", async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["delete"],
      },
    ];

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (ctx.find as jest.Mock).mockResolvedValue([{ id: 10 }, { id: 20 }]);

    await handler.cascadeDeleteOneToMany(Parent, { name: "any" } as any);

    expect(ctx.delete).toHaveBeenCalledTimes(1);
    // multiple parent IDs → array (IN clause)
    expect(ctx.delete).toHaveBeenCalledWith(Child, { parentId: [10, 20] });
  });

  it("should skip when cascade does not include delete", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["insert"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);

    await handler.cascadeDeleteOneToMany(Parent, { id: 1 } as any);

    expect(ctx.find).not.toHaveBeenCalled();
    expect(ctx.delete).not.toHaveBeenCalled();
  });

  it("should skip when no parent entities found", async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [{ name: "id", options: { primary: true } }],
    };

    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["delete"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue([]);
    // find returns empty → no parent PKs
    (ctx.find as jest.Mock).mockResolvedValue([]);

    await handler.cascadeDeleteOneToMany(Parent, { id: 999 } as any);

    expect(ctx.delete).not.toHaveBeenCalled();
  });

  it("should skip when entity metadata is missing", async () => {
    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["delete"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(null);

    await handler.cascadeDeleteOneToMany(Parent, { id: 1 } as any);

    expect(ctx.find).not.toHaveBeenCalled();
    expect(ctx.delete).not.toHaveBeenCalled();
  });

  it("should skip when no PK column found in parent metadata", async () => {
    const noPkMetadata = {
      name: "Parent",
      target: Parent,
      columns: [{ name: "name", options: {} }],
    };

    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["delete"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(noPkMetadata);

    await handler.cascadeDeleteOneToMany(Parent, { name: "any" } as any);

    expect(ctx.find).not.toHaveBeenCalled();
    expect(ctx.delete).not.toHaveBeenCalled();
  });

  it("should use mappedBy as FK fallback when no matching ManyToOne", async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [{ name: "id", options: { primary: true } }],
    };

    const oneToManyMeta: OneToManyMetadata<Comment>[] = [
      {
        target: Parent,
        propertyKey: "comments",
        getRelatedEntity: () => Comment,
        mappedBy: "postId",
        cascade: ["delete"],
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    // No matching ManyToOne found
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue([]);
    (ctx.find as jest.Mock).mockResolvedValue([{ id: 1 }]);

    await handler.cascadeDeleteOneToMany(Parent, { id: 1 } as any);

    // Falls back to mappedBy ("postId") as FK column
    expect(ctx.delete).toHaveBeenCalledWith(Comment, { postId: 1 });
  });

  it('should handle cascade: "remove" alias for "delete"', async () => {
    const parentMetadata = {
      name: "Parent",
      target: Parent,
      columns: [{ name: "id", options: { primary: true } }],
    };

    const oneToManyMeta: OneToManyMetadata<Child>[] = [
      {
        target: Parent,
        propertyKey: "children",
        getRelatedEntity: () => Child,
        mappedBy: "parent",
        cascade: ["remove"],
      },
    ];

    const manyToOneMeta = [
      {
        target: Child,
        type: Parent,
        columnName: "parent",
        joinColumn: "parentId",
        getMappingEntity: () => Parent,
        getMappingProperty: () => {},
      },
    ];

    (resolver.resolveOneToManyMetadata as jest.Mock).mockReturnValue(oneToManyMeta);
    (resolver.resolveEntityMetadata as jest.Mock).mockReturnValue(parentMetadata);
    (resolver.resolveManyToOneMetadata as jest.Mock).mockReturnValue(manyToOneMeta);
    (ctx.find as jest.Mock).mockResolvedValue([{ id: 5 }]);

    await handler.cascadeDeleteOneToMany(Parent, { id: 5 } as any);

    expect(ctx.delete).toHaveBeenCalledTimes(1);
  });
});

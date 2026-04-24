import "reflect-metadata";
import { RelationLoader } from "../../src/core/RelationLoader";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { EntityManagerInternals } from "../../src/core/EntityManagerInternals";

// Mock RawQueryBuilderFactory / ResultTransformerFactory
jest.mock("../../src/core/RawQueryBuilderFactory", () => ({
  RawQueryBuilderFactory: {
    create: jest.fn(() => {
      const qb: any = {
        _select: [],
        _from: null,
        _where: [],
        _join: [],
        select(cols: any) { qb._select = cols; return qb; },
        from(t: any) { qb._from = t; return qb; },
        where(w: any) { qb._where = w; return qb; },
        innerJoin(table: any, alias: any, cond: any) {
          qb._join.push({ table, alias, cond });
          return qb;
        },
        build() { return { text: "SELECT ...", values: [] }; },
      };
      return qb;
    }),
  },
}));

jest.mock("../../src/core/ResultTransformerFactory", () => ({
  ResultTransformerFactory: {
    create: jest.fn(() => ({
      toEntities: jest.fn((Entity: any, queryResult: any) => {
        return (queryResult.results || []).map((row: any) => {
          const entity = new Entity();
          Object.assign(entity, row);
          return entity;
        });
      }),
    })),
  },
}));

// ── Test Entity Stubs ──────────────────────────────────────────
class Parent {
  id!: number;
  name!: string;
  children?: Child[];
  tags?: Tag[];
  profile?: Profile;
}

class Child {
  id!: number;
  parentId!: number;
}

class Tag {
  id!: number;
  name!: string;
  __m2m_fk?: number;
}

class Profile {
  id!: number;
  userId!: number;
}

// ── Helpers ────────────────────────────────────────────────────
function createMockResolver(): jest.Mocked<RelationMetadataResolver> {
  return {
    resolveEntityMetadata: jest.fn(),
    resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
    resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyMetadata: jest.fn().mockReturnValue([]),
    resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    resolveManyToManyJoinTable: jest.fn(),
    getDeletedAtColumn: jest.fn().mockReturnValue(null),
    getCreateTimestampColumn: jest.fn().mockReturnValue(null),
    getUpdateTimestampColumn: jest.fn().mockReturnValue(null),
    getVersionColumn: jest.fn().mockReturnValue(null),
    resolveJoinColumnsFromColumnMeta: jest.fn(),
    resolveJoinColumnsFromColumnMetaForOneToOne: jest.fn(),
  } as any;
}

function createMockCtx(): jest.Mocked<EntityManagerInternals> {
  return {
    wrap: jest.fn((col: string) => `"${col}"`),
    wrapTable: jest.fn((t: string) => `"${t}"`),
    isMySqlFamily: jest.fn().mockReturnValue(false),
    isPostgres: jest.fn().mockReturnValue(true),
    getDriver: jest.fn(),
    getSynchronize: jest.fn(),
    getDialect: jest.fn(),
    getSchema: jest.fn(),
    getConnection: jest.fn(),
    executeInTransaction: jest.fn(async (fn: any, session?: any) => {
      const mockSession = session || { query: jest.fn() };
      return fn(mockSession);
    }),
    executeReadOnly: jest.fn(),
    beginTrackQuery: jest.fn(),
    trackQuery: jest.fn(),
    getReadNode: jest.fn(),
    getEntities: jest.fn(),
    getNameStrategy: jest.fn(),
    resolveSelectColumns: jest.fn(),
    markDirty: jest.fn(),
    findInternal: jest.fn(),
    findOneInternal: jest.fn(),
    save: jest.fn(),
    saveWithSession: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
    getTenantColumnConfig: jest.fn().mockReturnValue(null),
    buildTenantWhereClause: jest.fn().mockReturnValue(null),
  } as any;
}

const parentMetadata = {
  name: "parents",
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true } },
    { name: "name", propertyKey: "name", options: {} },
  ],
};

const childMetadata = {
  name: "children",
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true } },
    { name: "parentId", propertyKey: "parentId", options: {} },
  ],
};

const tagMetadata = {
  name: "tags",
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true } },
    { name: "name", propertyKey: "name", options: {} },
  ],
};

const profileMetadata = {
  name: "profiles",
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true } },
    { name: "userId", propertyKey: "userId", options: {} },
  ],
};

// ─── OneToMany Tests ───────────────────────────────────────────

describe("RelationLoader", () => {
  let loader: RelationLoader;
  let resolver: jest.Mocked<RelationMetadataResolver>;
  let ctx: jest.Mocked<EntityManagerInternals>;

  beforeEach(() => {
    jest.clearAllMocks();
    resolver = createMockResolver();
    ctx = createMockCtx();
    loader = new RelationLoader(resolver, ctx);
  });

  describe("loadOneToManyRelations", () => {
    it("should skip if no OneToMany metadata", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([]);
      const parent = { id: 1, name: "Alice" } as Parent;

      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if parent metadata is not found", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(null);

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if no primary key found", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue({
        name: "parents",
        columns: [{ name: "name", propertyKey: "name", options: {} }],
      } as any);

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip relation not in relations list", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(parentMetadata as any);

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["otherRelation"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should assign empty array when parent IDs are all null/undefined", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([]);

      const parent = { id: undefined, name: "Alice" } as any;
      await loader.loadOneToManyRelations(Parent, [parent], ["children"]);

      expect(parent.children).toEqual([]);
    });

    it("should load children and assign to single parent", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any) // parent
        .mockReturnValueOnce(childMetadata as any); // related
      resolver.resolveManyToOneMetadata.mockReturnValue([]);

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [
            { id: 10, parentId: 1 },
            { id: 11, parentId: 1 },
          ],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(parent.children).toHaveLength(2);
      expect(parent.children![0].id).toBe(10);
      expect(parent.children![1].id).toBe(11);
    });

    it("should distribute children to multiple parents", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([]);

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [
            { id: 10, parentId: 1 },
            { id: 11, parentId: 2 },
            { id: 12, parentId: 1 },
          ],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent1 = { id: 1, name: "Alice" } as Parent;
      const parent2 = { id: 2, name: "Bob" } as Parent;
      await loader.loadOneToManyRelations(Parent, [parent1, parent2], ["children"]);

      expect(parent1.children).toHaveLength(2);
      expect(parent2.children).toHaveLength(1);
    });

    it("should assign empty array to parent with no children", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([]);

      const mockSession = {
        query: jest.fn().mockResolvedValue({ results: [] }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(parent.children).toEqual([]);
    });

    it("should use matching ManyToOne joinColumn when available", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parent" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([
        { columnName: "parent", joinColumn: "parent_id" },
      ] as any);

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 10, parent_id: 1 }],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      expect(parent.children).toBeDefined();
    });

    it("should handle deletedAt column in related entity", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([]);
      resolver.getDeletedAtColumn.mockReturnValue("deletedAt");

      const mockSession = {
        query: jest.fn().mockResolvedValue({ results: [] }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1, name: "Alice" } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"]);

      // Query should have been built with deletedAt IS NULL condition
      expect(resolver.getDeletedAtColumn).toHaveBeenCalledWith(Child);
    });

    it("should use existing session when provided", async () => {
      resolver.resolveOneToManyMetadata.mockReturnValue([
        { propertyKey: "children", getRelatedEntity: () => Child, mappedBy: "parentId" },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(childMetadata as any);
      resolver.resolveManyToOneMetadata.mockReturnValue([]);

      const existingSession = { query: jest.fn().mockResolvedValue({ results: [] }) };
      ctx.executeInTransaction.mockImplementation(async (fn: any, session?: any) => fn(session));

      const parent = { id: 1 } as Parent;
      await loader.loadOneToManyRelations(Parent, parent, ["children"], existingSession as any);

      expect(ctx.executeInTransaction).toHaveBeenCalledWith(expect.any(Function), existingSession);
    });
  });

  // ─── ManyToMany Tests ──────────────────────────────────────────

  describe("loadManyToManyRelations", () => {
    it("should skip if no ManyToMany metadata", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([]);
      const parent = { id: 1 } as Parent;

      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if parent metadata not found", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(null);

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if no PK found", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue({
        name: "parents",
        columns: [{ name: "name", options: {} }],
      } as any);

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip relation not in relations list", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(parentMetadata as any);

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["other"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if joinTable not found", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(parentMetadata as any);
      resolver.resolveManyToManyJoinTable.mockReturnValue(null);

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should assign empty array when parent IDs are all null", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(tagMetadata as any);
      resolver.resolveManyToManyJoinTable.mockReturnValue({
        joinTableName: "parent_tags",
        joinColumn: "parent_id",
        inverseJoinColumn: "tag_id",
      });

      const parent = { id: null } as any;
      await loader.loadManyToManyRelations(Parent, [parent], ["tags"]);

      expect(parent.tags).toEqual([]);
    });

    it("should load M2M relations and assign to parents", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(tagMetadata as any);
      resolver.resolveManyToManyJoinTable.mockReturnValue({
        joinTableName: "parent_tags",
        joinColumn: "parent_id",
        inverseJoinColumn: "tag_id",
      });

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [
            { id: 100, name: "TypeScript", __m2m_fk: 1 },
            { id: 101, name: "ORM", __m2m_fk: 1 },
            { id: 102, name: "DB", __m2m_fk: 2 },
          ],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent1 = { id: 1 } as Parent;
      const parent2 = { id: 2 } as Parent;
      await loader.loadManyToManyRelations(Parent, [parent1, parent2], ["tags"]);

      expect(parent1.tags).toHaveLength(2);
      expect(parent2.tags).toHaveLength(1);
    });

    it("should handle empty M2M result", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(tagMetadata as any);
      resolver.resolveManyToManyJoinTable.mockReturnValue({
        joinTableName: "parent_tags",
        joinColumn: "parent_id",
        inverseJoinColumn: "tag_id",
      });

      const mockSession = {
        query: jest.fn().mockResolvedValue({ results: [] }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(parent.tags).toEqual([]);
    });

    it("should handle single parent (not array)", async () => {
      resolver.resolveManyToManyMetadata.mockReturnValue([
        { propertyKey: "tags", getRelatedEntity: () => Tag },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(tagMetadata as any);
      resolver.resolveManyToManyJoinTable.mockReturnValue({
        joinTableName: "parent_tags",
        joinColumn: "parent_id",
        inverseJoinColumn: "tag_id",
      });

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 100, name: "Tag1", __m2m_fk: 1 }],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1 } as Parent;
      await loader.loadManyToManyRelations(Parent, parent, ["tags"]);

      expect(parent.tags).toHaveLength(1);
    });
  });

  // ─── OneToOne Tests ────────────────────────────────────────────

  describe("loadOneToOneRelations", () => {
    it("should skip if no OneToOne metadata", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([]);
      const parent = { id: 1 } as Parent;

      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if parent metadata not found", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([
        { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: null, inverseSide: "user" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(null);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip if no PK found", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([
        { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: null, inverseSide: "user" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue({
        name: "parents",
        columns: [{ name: "name", options: {} }],
      } as any);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should skip owner-side (joinColumn) relations", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([
        { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: "profile_id" },
      ] as any);
      resolver.resolveEntityMetadata.mockReturnValue(parentMetadata as any);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      // Owner-side should be skipped (handled by eager JOIN)
      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });

    it("should set null for non-inverseSide non-joinColumn relations", async () => {
      resolver.resolveOneToOneMetadata.mockReturnValue([
        { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: undefined },
      ] as any);
      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(parent.profile).toBeNull();
    });

    it("should set null when inverseSide owner has no joinColumn", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([] as any); // related entity OneToOne metadata

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(parent.profile).toBeNull();
    });

    it("should load inverseSide OneToOne relation via batch query", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 50, userId: 1 }],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(parent.profile).toBeDefined();
      expect((parent.profile as any).id).toBe(50);
    });

    it("should set null when no matching inverseSide result", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const mockSession = {
        query: jest.fn().mockResolvedValue({ results: [] }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(parent.profile).toBeNull();
    });

    it("should assign null when all parent IDs are null (inverseSide)", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const parent = { id: undefined } as any;
      await loader.loadOneToOneRelations(Parent, [parent], ["profile"]);

      expect(parent.profile).toBeNull();
    });

    it("should distribute OneToOne results to multiple parents", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);

      const mockSession = {
        query: jest.fn().mockResolvedValue({
          results: [
            { id: 50, userId: 1 },
            { id: 51, userId: 2 },
          ],
        }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent1 = { id: 1 } as Parent;
      const parent2 = { id: 2 } as Parent;
      const parent3 = { id: 3 } as Parent;
      await loader.loadOneToOneRelations(Parent, [parent1, parent2, parent3], ["profile"]);

      expect((parent1.profile as any).id).toBe(50);
      expect((parent2.profile as any).id).toBe(51);
      expect(parent3.profile).toBeNull();
    });

    it("should handle deletedAt in inverseSide queries", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce(profileMetadata as any);
      resolver.getDeletedAtColumn.mockReturnValue("deletedAt");

      const mockSession = {
        query: jest.fn().mockResolvedValue({ results: [] }),
      };
      ctx.executeInTransaction.mockImplementation(async (fn: any) => fn(mockSession));

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      expect(resolver.getDeletedAtColumn).toHaveBeenCalledWith(Profile);
    });

    it("should skip related entity with no PK (inverseSide)", async () => {
      resolver.resolveOneToOneMetadata
        .mockReturnValueOnce([
          { propertyKey: "profile", getRelatedEntity: () => Profile, joinColumn: undefined, inverseSide: "user" },
        ] as any)
        .mockReturnValueOnce([
          { propertyKey: "user", joinColumn: "userId" },
        ] as any);

      resolver.resolveEntityMetadata
        .mockReturnValueOnce(parentMetadata as any)
        .mockReturnValueOnce({
          name: "profiles",
          columns: [{ name: "userId", propertyKey: "userId", options: {} }],
        } as any);

      const parent = { id: 1 } as Parent;
      await loader.loadOneToOneRelations(Parent, parent, ["profile"]);

      // No PK in related entity → no query executed
      expect(ctx.executeInTransaction).not.toHaveBeenCalled();
    });
  });
});

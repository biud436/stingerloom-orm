/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import {
  EntitySchema,
  EntitySchemaOptions,
  ColumnSchemaDef,
  RelationSchemaDef,
} from "../../src/schema";
import { ENTITY_TOKEN, EntityMetadata } from "../../src/decorators/Entity";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../src/decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { INDEX_TOKEN } from "../../src/decorators/Indexer";
import { UNIQUE_INDEX_TOKEN } from "../../src/decorators/UniqueIndex";
import { VERSION_TOKEN } from "../../src/decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../src/decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../src/decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../../src/decorators/DeletedAt";
import { HOOK_TOKEN } from "../../src/decorators/Hooks";
import { VALIDATION_TOKEN } from "../../src/decorators/Validation";
import { ReflectManager } from "../../src/utils/ReflectManager";
import {
  EntityScanner,
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
} from "../../src/scanner";
import { OneToOneScanner } from "../../src/scanner/OneToOneScanner";
import { ColumnMetadata } from "../../src/scanner/ColumnScanner";

// ─── Helper: clear all scanners between tests ────────────────────────────────
function clearScanners() {
  getScannerInstance(EntityScanner).clear();
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
}

// ─── Helper: create a fresh class for each test ──────────────────────────────
let counter = 0;
function freshClass(name?: string): any {
  counter++;
  const cls = class {} as any;
  Object.defineProperty(cls, "name", {
    value: name || `TestEntity${counter}`,
    writable: false,
  });
  return cls;
}

beforeEach(() => {
  clearScanners();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Basic column registration
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Column Registration", () => {
  it("should register columns via Reflect and Scanner", () => {
    const User = freshClass("User");
    new EntitySchema<any>({
      target: User,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: { type: "varchar" },
        age: { type: "int", nullable: true },
      },
    });

    // Reflect.getMetadata(COLUMN_TOKEN, proto) should have 3 entries
    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      User.prototype,
    );
    expect(columns).toHaveLength(3);
    expect(columns.map((c) => c.propertyKey)).toEqual(
      expect.arrayContaining(["id", "name", "age"]),
    );

    // Primary column
    const idCol = columns.find((c) => c.propertyKey === "id")!;
    expect(idCol.options?.primary).toBe(true);
    expect(idCol.options?.autoIncrement).toBe(true);

    // Nullable
    const ageCol = columns.find((c) => c.propertyKey === "age")!;
    expect(ageCol.options?.nullable).toBe(true);
  });

  it("should set design:type from ColumnType", () => {
    const Post = freshClass("Post");
    new EntitySchema<any>({
      target: Post,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        title: { type: "varchar" },
        active: { type: "boolean" },
        createdAt: { type: "datetime" },
        data: { type: "blob" },
      },
    });

    expect(Reflect.getMetadata("design:type", Post.prototype, "id")).toBe(
      Number,
    );
    expect(Reflect.getMetadata("design:type", Post.prototype, "title")).toBe(
      String,
    );
    expect(Reflect.getMetadata("design:type", Post.prototype, "active")).toBe(
      Boolean,
    );
    expect(
      Reflect.getMetadata("design:type", Post.prototype, "createdAt"),
    ).toBe(Date);
    expect(Reflect.getMetadata("design:type", Post.prototype, "data")).toBe(
      Buffer,
    );
  });

  it("should apply default lengths based on type", () => {
    const Item = freshClass("Item");
    new EntitySchema<any>({
      target: Item,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        label: { type: "varchar" },
        flag: { type: "boolean" },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Item.prototype,
    );
    const labelCol = columns.find((c) => c.propertyKey === "label")!;
    expect(labelCol.options?.length).toBe(255); // varchar default

    const idCol = columns.find((c) => c.propertyKey === "id")!;
    expect(idCol.options?.length).toBe(11); // int default

    const flagCol = columns.find((c) => c.propertyKey === "flag")!;
    expect(flagCol.options?.length).toBe(1); // boolean default
  });

  it("should allow explicit length override", () => {
    const Foo = freshClass("Foo");
    new EntitySchema<any>({
      target: Foo,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        code: { type: "varchar", length: 10 },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Foo.prototype,
    );
    const codeCol = columns.find((c) => c.propertyKey === "code")!;
    expect(codeCol.options?.length).toBe(10);
  });

  it("should support column name override", () => {
    const Bar = freshClass("Bar");
    new EntitySchema<any>({
      target: Bar,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        firstName: { type: "varchar", name: "first_name" },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Bar.prototype,
    );
    const col = columns.find((c) => c.propertyKey === "firstName")!;
    expect(col.name).toBe("first_name");
    expect(col.options?.name).toBe("first_name");
  });

  it("should support default values", () => {
    const Cfg = freshClass("Cfg");
    new EntitySchema<any>({
      target: Cfg,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        status: { type: "varchar", default: "active" },
        count: { type: "int", default: 0 },
        enabled: { type: "boolean", default: true },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Cfg.prototype,
    );
    expect(columns.find((c) => c.propertyKey === "status")!.options?.default).toBe("active");
    expect(columns.find((c) => c.propertyKey === "count")!.options?.default).toBe(0);
    expect(columns.find((c) => c.propertyKey === "enabled")!.options?.default).toBe(true);
  });

  it("should support enum columns", () => {
    const Role = freshClass("Role");
    new EntitySchema<any>({
      target: Role,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        role: { type: "enum", enumValues: ["admin", "user", "guest"], enumName: "user_role" },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Role.prototype,
    );
    const roleCol = columns.find((c) => c.propertyKey === "role")!;
    expect(roleCol.options?.enumValues).toEqual(["admin", "user", "guest"]);
    expect(roleCol.options?.enumName).toBe("user_role");
  });

  it("should support precision and scale", () => {
    const Price = freshClass("Price");
    new EntitySchema<any>({
      target: Price,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        amount: { type: "float", precision: 10, scale: 2 },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Price.prototype,
    );
    const amountCol = columns.find((c) => c.propertyKey === "amount")!;
    expect(amountCol.options?.precision).toBe(10);
    expect(amountCol.options?.scale).toBe(2);
  });

  it("should support transform function", () => {
    const Transformed = freshClass("Transformed");
    const transformer = (raw: unknown) => String(raw).toUpperCase();
    new EntitySchema<any>({
      target: Transformed,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        code: { type: "varchar", transform: transformer },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Transformed.prototype,
    );
    const codeCol = columns.find((c) => c.propertyKey === "code")!;
    expect(codeCol.transform).toBe(transformer);
    expect(codeCol.transform!("hello")).toBe("HELLO");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Entity registration (ENTITY_TOKEN + EntityScanner)
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Entity Registration", () => {
  it("should register ENTITY_TOKEN on class", () => {
    const User = freshClass("SchemaUser");
    new EntitySchema<any>({
      target: User,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, User);
    expect(meta).toBeDefined();
    expect(meta.target).toBe(User);
    expect(meta.columns).toHaveLength(1);
  });

  it("should derive snake_case table name from class name", () => {
    const MyFancyEntity = freshClass("MyFancyEntity");
    new EntitySchema<any>({
      target: MyFancyEntity,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const meta: EntityMetadata = Reflect.getMetadata(
      ENTITY_TOKEN,
      MyFancyEntity,
    );
    expect(meta.name).toBe("my_fancy_entity");
  });

  it("should use explicit tableName when provided", () => {
    const Tbl = freshClass("SomeClass");
    new EntitySchema<any>({
      target: Tbl,
      tableName: "custom_table",
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Tbl);
    expect(meta.name).toBe("custom_table");
    expect(meta.options?.name).toBe("custom_table");
  });

  it("should be recognized by ReflectManager.isEntity()", () => {
    const Ent = freshClass("SchemaEntity");
    new EntitySchema<any>({
      target: Ent,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    expect(ReflectManager.isEntity(Ent)).toBe(true);
  });

  it("should register in EntityScanner", () => {
    const Scanned = freshClass("ScannedEntity");
    new EntitySchema<any>({
      target: Scanned,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const scanner = getScannerInstance(EntityScanner);
    const found = scanner.scan(Scanned);
    expect(found).toBeDefined();
    expect(found!.target).toBe(Scanned);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Special tokens (Version, CreateTimestamp, UpdateTimestamp, DeletedAt)
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Special Tokens", () => {
  it("should register VERSION_TOKEN", () => {
    const Ver = freshClass("Versioned");
    new EntitySchema<any>({
      target: Ver,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        version: { type: "int", version: true },
      },
    });

    expect(Reflect.getMetadata(VERSION_TOKEN, Ver)).toBe("version");
  });

  it("should register CREATE_TIMESTAMP_TOKEN", () => {
    const Ts = freshClass("Timestamped");
    new EntitySchema<any>({
      target: Ts,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        createdAt: { type: "datetime", createTimestamp: true },
      },
    });

    expect(Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, Ts)).toBe("createdAt");
  });

  it("should register UPDATE_TIMESTAMP_TOKEN", () => {
    const Ts = freshClass("UpdateTs");
    new EntitySchema<any>({
      target: Ts,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        updatedAt: { type: "datetime", updateTimestamp: true },
      },
    });

    expect(Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, Ts)).toBe("updatedAt");
  });

  it("should register DELETED_AT_TOKEN", () => {
    const Sd = freshClass("SoftDel");
    new EntitySchema<any>({
      target: Sd,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        deletedAt: { type: "datetime", nullable: true, deletedAt: true },
      },
    });

    expect(Reflect.getMetadata(DELETED_AT_TOKEN, Sd)).toBe("deletedAt");
  });

  it("should support multiple special tokens on one entity", () => {
    const Full = freshClass("FullEntity");
    new EntitySchema<any>({
      target: Full,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        version: { type: "int", version: true },
        createdAt: { type: "datetime", createTimestamp: true },
        updatedAt: { type: "datetime", updateTimestamp: true },
        deletedAt: { type: "datetime", nullable: true, deletedAt: true },
      },
    });

    expect(Reflect.getMetadata(VERSION_TOKEN, Full)).toBe("version");
    expect(Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, Full)).toBe("createdAt");
    expect(Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, Full)).toBe("updatedAt");
    expect(Reflect.getMetadata(DELETED_AT_TOKEN, Full)).toBe("deletedAt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Relations
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Relations", () => {
  it("should register ManyToOne relation", () => {
    const Author = freshClass("Author");
    const Post = freshClass("Post");

    // Author (parent) - minimal
    new EntitySchema<any>({
      target: Author,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: { type: "varchar" },
      },
    });

    clearScanners(); // Avoid cross-contamination

    // Rebuild Author after clear for EntityScanner
    new EntitySchema<any>({
      target: Author,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: { type: "varchar" },
      },
    });

    new EntitySchema<any>({
      target: Post,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        title: { type: "varchar" },
      },
      relations: {
        author: {
          kind: "manyToOne",
          target: () => Author,
          joinColumn: "author_id",
        },
      },
    });

    const m2o = Reflect.getMetadata(MANY_TO_ONE_TOKEN, Post);
    expect(m2o).toHaveLength(1);
    expect(m2o[0].columnName).toBe("author");
    expect(m2o[0].joinColumn).toBe("author_id");
    expect(m2o[0].target).toBe(Post);
  });

  it("should register OneToMany relation", () => {
    const Parent = freshClass("Parent");
    new EntitySchema<any>({
      target: Parent,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        children: {
          kind: "oneToMany",
          target: () => freshClass("Child"),
          mappedBy: "parent",
        },
      },
    });

    const o2m = Reflect.getMetadata(ONE_TO_MANY_TOKEN, Parent);
    expect(o2m).toHaveLength(1);
    expect(o2m[0].propertyKey).toBe("children");
    expect(o2m[0].mappedBy).toBe("parent");
  });

  it("should register OneToOne relation", () => {
    const Profile = freshClass("Profile");
    const UserOTO = freshClass("UserOTO");
    new EntitySchema<any>({
      target: UserOTO,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        profile: {
          kind: "oneToOne",
          target: () => Profile,
          joinColumn: "profile_id",
          eager: true,
        },
      },
    });

    const o2o = Reflect.getMetadata(ONE_TO_ONE_TOKEN, UserOTO);
    expect(o2o).toHaveLength(1);
    expect(o2o[0].propertyKey).toBe("profile");
    expect(o2o[0].joinColumn).toBe("profile_id");
    expect(o2o[0].option?.eager).toBe(true);
  });

  it("should register ManyToMany relation", () => {
    const Tag = freshClass("Tag");
    const Article = freshClass("Article");
    new EntitySchema<any>({
      target: Article,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        tags: {
          kind: "manyToMany",
          target: () => Tag,
          joinTable: {
            name: "article_tags",
            joinColumn: "article_id",
            inverseJoinColumn: "tag_id",
          },
        },
      },
    });

    const m2m = Reflect.getMetadata(MANY_TO_MANY_TOKEN, Article);
    expect(m2m).toHaveLength(1);
    expect(m2m[0].propertyKey).toBe("tags");
    expect(m2m[0].joinTable?.name).toBe("article_tags");
  });

  it("should register ManyToMany inverse side", () => {
    const PostM2M = freshClass("PostM2M");
    const TagInverse = freshClass("TagInverse");
    new EntitySchema<any>({
      target: TagInverse,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        posts: {
          kind: "manyToMany",
          target: () => PostM2M,
          mappedBy: "tags",
        },
      },
    });

    const m2m = Reflect.getMetadata(MANY_TO_MANY_TOKEN, TagInverse);
    expect(m2m).toHaveLength(1);
    expect(m2m[0].mappedBy).toBe("tags");
  });

  it("should register relation in scanner", () => {
    const A = freshClass("RelA");
    const B = freshClass("RelB");
    new EntitySchema<any>({
      target: A,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        b: { kind: "manyToOne", target: () => B, joinColumn: "b_id" },
      },
    });

    const scanner = getScannerInstance(ManyToOneScanner);
    const allRels = scanner
      .allMetadata<any>()
      .filter((r: any) => r.target === A);
    expect(allRels.length).toBeGreaterThanOrEqual(1);
    expect(allRels[0].columnName).toBe("b");
  });

  it("should support cascade option on ManyToOne", () => {
    const ParentCas = freshClass("ParentCas");
    const ChildCas = freshClass("ChildCas");
    new EntitySchema<any>({
      target: ChildCas,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        parent: {
          kind: "manyToOne",
          target: () => ParentCas,
          joinColumn: "parent_id",
          cascade: ["insert", "update"],
        },
      },
    });

    const m2o = Reflect.getMetadata(MANY_TO_ONE_TOKEN, ChildCas);
    expect(m2o[0].option?.cascade).toEqual(["insert", "update"]);
  });

  it("should support lazy option on ManyToOne", () => {
    const LazyParent = freshClass("LazyParent");
    const LazyChild = freshClass("LazyChild");
    new EntitySchema<any>({
      target: LazyChild,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      relations: {
        parent: {
          kind: "manyToOne",
          target: () => LazyParent,
          joinColumn: "parent_id",
          lazy: true,
        },
      },
    });

    const m2o = Reflect.getMetadata(MANY_TO_ONE_TOKEN, LazyChild);
    expect(m2o[0].option?.lazy).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Indexes
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Indexes", () => {
  it("should register per-column index via index:true", () => {
    const Indexed = freshClass("Indexed");
    new EntitySchema<any>({
      target: Indexed,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar", index: true },
      },
    });

    const indexes = Reflect.getMetadata(INDEX_TOKEN, Indexed.prototype);
    expect(indexes).toHaveLength(1);
    expect(indexes[0].name).toBe("email");
  });

  it("should register composite unique index", () => {
    const Unique = freshClass("UniqueEntity");
    new EntitySchema<any>({
      target: Unique,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar" },
        tenantId: { type: "int" },
      },
      uniqueIndexes: [{ columns: ["email", "tenantId"] }],
    });

    const uix = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, Unique);
    expect(uix).toHaveLength(1);
    expect(uix[0].columns).toEqual(["email", "tenantId"]);
  });

  it("should register multiple unique indexes", () => {
    const Multi = freshClass("MultiUnique");
    new EntitySchema<any>({
      target: Multi,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar" },
        code: { type: "varchar" },
      },
      uniqueIndexes: [
        { columns: ["email"], name: "uix_email" },
        { columns: ["code"], name: "uix_code" },
      ],
    });

    const uix = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, Multi);
    expect(uix).toHaveLength(2);
    expect(uix[0].name).toBe("uix_email");
    expect(uix[1].name).toBe("uix_code");
  });

  it("should support both per-column index and unique index", () => {
    const Both = freshClass("BothIndexes");
    new EntitySchema<any>({
      target: Both,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar", index: true },
        name: { type: "varchar" },
      },
      uniqueIndexes: [{ columns: ["email", "name"] }],
    });

    const idx = Reflect.getMetadata(INDEX_TOKEN, Both.prototype);
    expect(idx).toHaveLength(1);

    const uix = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, Both);
    expect(uix).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Hooks
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Hooks", () => {
  it("should register lifecycle hooks", () => {
    const Hooked = freshClass("Hooked");
    Hooked.prototype.onBeforeInsert = function () {};
    Hooked.prototype.onAfterInsert = function () {};

    new EntitySchema<any>({
      target: Hooked,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      hooks: {
        beforeInsert: "onBeforeInsert",
        afterInsert: "onAfterInsert",
      },
    });

    const hooks = Reflect.getMetadata(HOOK_TOKEN, Hooked);
    expect(hooks).toHaveLength(2);
    expect(hooks).toEqual(
      expect.arrayContaining([
        { methodName: "onBeforeInsert", event: "beforeInsert" },
        { methodName: "onAfterInsert", event: "afterInsert" },
      ]),
    );
  });

  it("should register all 6 hook events", () => {
    const AllHooks = freshClass("AllHooks");
    AllHooks.prototype.bi = function () {};
    AllHooks.prototype.ai = function () {};
    AllHooks.prototype.bu = function () {};
    AllHooks.prototype.au = function () {};
    AllHooks.prototype.bd = function () {};
    AllHooks.prototype.ad = function () {};

    new EntitySchema<any>({
      target: AllHooks,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
      hooks: {
        beforeInsert: "bi",
        afterInsert: "ai",
        beforeUpdate: "bu",
        afterUpdate: "au",
        beforeDelete: "bd",
        afterDelete: "ad",
      },
    });

    const hooks = Reflect.getMetadata(HOOK_TOKEN, AllHooks);
    expect(hooks).toHaveLength(6);
  });

  it("should not register hooks when none provided", () => {
    const NoHook = freshClass("NoHook");
    new EntitySchema<any>({
      target: NoHook,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const hooks = Reflect.getMetadata(HOOK_TOKEN, NoHook);
    expect(hooks).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Validation
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Validation", () => {
  it("should register validation constraints", () => {
    const Validated = freshClass("Validated");
    new EntitySchema<any>({
      target: Validated,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: {
          type: "varchar",
          validation: [
            { constraint: "notNull" },
            { constraint: "minLength", value: 2 },
            { constraint: "maxLength", value: 100 },
          ],
        },
        age: {
          type: "int",
          validation: [
            { constraint: "min", value: 0 },
            { constraint: "max", value: 150 },
          ],
        },
      },
    });

    const validations = Reflect.getMetadata(VALIDATION_TOKEN, Validated);
    expect(validations).toHaveLength(5);

    const nameValidations = validations.filter(
      (v: any) => v.propertyKey === "name",
    );
    expect(nameValidations).toHaveLength(3);

    const ageValidations = validations.filter(
      (v: any) => v.propertyKey === "age",
    );
    expect(ageValidations).toHaveLength(2);
  });

  it("should use custom messages when provided", () => {
    const CustomMsg = freshClass("CustomMsg");
    new EntitySchema<any>({
      target: CustomMsg,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: {
          type: "varchar",
          validation: [
            { constraint: "notNull", message: "Email is required" },
          ],
        },
      },
    });

    const validations = Reflect.getMetadata(VALIDATION_TOKEN, CustomMsg);
    expect(validations[0].message).toBe("Email is required");
  });

  it("should generate default messages when not provided", () => {
    const DefaultMsg = freshClass("DefaultMsg");
    new EntitySchema<any>({
      target: DefaultMsg,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        code: {
          type: "varchar",
          validation: [{ constraint: "notNull" }],
        },
      },
    });

    const validations = Reflect.getMetadata(VALIDATION_TOKEN, DefaultMsg);
    expect(validations[0].message).toContain("code");
    expect(validations[0].message).toContain("notNull");
  });

  it("should not register validation when none defined", () => {
    const NoVal = freshClass("NoVal");
    new EntitySchema<any>({
      target: NoVal,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    });

    const validations = Reflect.getMetadata(VALIDATION_TOKEN, NoVal);
    expect(validations).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Comprehensive entity (all features combined)
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Comprehensive", () => {
  it("should register a full-featured entity", () => {
    const Category = freshClass("Category");
    const Comment = freshClass("Comment");
    const Tag = freshClass("Tag");

    // Register related entities first
    new EntitySchema<any>({
      target: Category,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
    });

    clearScanners();

    new EntitySchema<any>({
      target: Category,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
    });

    new EntitySchema<any>({
      target: Tag,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
    });

    const FullPost = freshClass("FullPost");
    FullPost.prototype.trimTitle = function () {
      this.title = this.title?.trim();
    };

    new EntitySchema<any>({
      target: FullPost,
      tableName: "posts",
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        title: {
          type: "varchar",
          length: 500,
          validation: [
            { constraint: "notNull" },
            { constraint: "minLength", value: 1 },
          ],
        },
        content: { type: "text", nullable: true },
        version: { type: "int", version: true },
        createdAt: { type: "datetime", createTimestamp: true },
        updatedAt: { type: "datetime", updateTimestamp: true },
        deletedAt: { type: "datetime", nullable: true, deletedAt: true },
      },
      relations: {
        category: {
          kind: "manyToOne",
          target: () => Category,
          joinColumn: "category_id",
          eager: true,
        },
        comments: {
          kind: "oneToMany",
          target: () => Comment,
          mappedBy: "post",
        },
        tags: {
          kind: "manyToMany",
          target: () => Tag,
          joinTable: {
            name: "post_tags",
            joinColumn: "post_id",
            inverseJoinColumn: "tag_id",
          },
        },
      },
      uniqueIndexes: [{ columns: ["title"], name: "uix_post_title" }],
      hooks: {
        beforeInsert: "trimTitle",
      },
    });

    // Verify Entity
    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, FullPost);
    expect(meta).toBeDefined();
    expect(meta.name).toBe("posts");
    expect(meta.target).toBe(FullPost);

    // Verify Columns
    expect(meta.columns.length).toBe(7);

    // Verify Special Tokens
    expect(Reflect.getMetadata(VERSION_TOKEN, FullPost)).toBe("version");
    expect(Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, FullPost)).toBe(
      "createdAt",
    );
    expect(Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, FullPost)).toBe(
      "updatedAt",
    );
    expect(Reflect.getMetadata(DELETED_AT_TOKEN, FullPost)).toBe("deletedAt");

    // Verify Relations
    expect(meta.manyToOnes).toHaveLength(1);
    expect(meta.oneToManys).toHaveLength(1);
    expect(meta.manyToManys).toHaveLength(1);

    // Verify Unique Index
    const uix = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, FullPost);
    expect(uix).toHaveLength(1);

    // Verify Hooks
    const hooks = Reflect.getMetadata(HOOK_TOKEN, FullPost);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].methodName).toBe("trimTitle");

    // Verify Validation
    const validations = Reflect.getMetadata(VALIDATION_TOKEN, FullPost);
    expect(validations).toHaveLength(2);

    // Verify ReflectManager
    expect(ReflectManager.isEntity(FullPost)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. No relations / minimal entity
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Minimal Entity", () => {
  it("should work with columns-only entity (no relations/hooks/validation)", () => {
    const Simple = freshClass("SimpleEntity");
    new EntitySchema<any>({
      target: Simple,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: { type: "varchar" },
      },
    });

    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Simple);
    expect(meta).toBeDefined();
    expect(meta.columns).toHaveLength(2);
    expect(meta.manyToOnes).toHaveLength(0);
    expect(meta.oneToManys).toHaveLength(0);
    expect(meta.oneToOnes).toHaveLength(0);
    expect(meta.manyToManys).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. EntitySchema options property
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Instance", () => {
  it("should expose options on the instance", () => {
    const Target = freshClass("OptionsTarget");
    const opts: EntitySchemaOptions<any> = {
      target: Target,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
      },
    };

    const schema = new EntitySchema(opts);
    expect(schema.options).toBe(opts);
    expect(schema.options.target).toBe(Target);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Scanner compatibility — columns from Scanner match Reflect
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Scanner ↔ Reflect consistency", () => {
  it("should have matching column counts in Scanner and Reflect", () => {
    const Dual = freshClass("DualCheck");
    new EntitySchema<any>({
      target: Dual,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        a: { type: "varchar" },
        b: { type: "int" },
      },
    });

    const reflectCols: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Dual.prototype,
    );
    const scannerCols = getScannerInstance(ColumnScanner)
      .allMetadata<ColumnMetadata>()
      .filter((c) => c.target === Dual.prototype);

    expect(reflectCols).toHaveLength(3);
    expect(scannerCols).toHaveLength(3);

    // Same property keys
    const reflectKeys = reflectCols.map((c) => c.propertyKey).sort();
    const scannerKeys = scannerCols.map((c) => c.propertyKey).sort();
    expect(reflectKeys).toEqual(scannerKeys);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Multiple EntitySchema registrations in sequence
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — Multiple Entities", () => {
  it("should register multiple entities without cross-contamination", () => {
    const A = freshClass("EntityA");
    const B = freshClass("EntityB");

    new EntitySchema<any>({
      target: A,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: { type: "varchar" },
      },
    });

    new EntitySchema<any>({
      target: B,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar" },
        age: { type: "int" },
      },
    });

    const metaA: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, A);
    const metaB: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, B);

    expect(metaA.columns).toHaveLength(2);
    expect(metaB.columns).toHaveLength(3);

    // A should not contain B's columns
    expect(metaA.columns.map((c: any) => c.propertyKey)).not.toContain("email");
    expect(metaA.columns.map((c: any) => c.propertyKey)).not.toContain("age");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Type mapping coverage for all ColumnTypes
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — ColumnType → design:type mapping", () => {
  const typeMappings: [string, any][] = [
    ["int", Number],
    ["number", Number],
    ["float", Number],
    ["double", Number],
    ["bigint", Number],
    ["boolean", Boolean],
    ["datetime", Date],
    ["timestamp", Date],
    ["timestamptz", Date],
    ["date", Date],
    ["blob", Buffer],
    ["varchar", String],
    ["char", String],
    ["text", String],
    ["longtext", String],
    ["enum", String],
    ["json", String],
    ["jsonb", String],
    ["array", String],
  ];

  it.each(typeMappings)(
    "ColumnType '%s' should map to %p",
    (colType, expectedDesignType) => {
      const Cls = freshClass();
      new EntitySchema<any>({
        target: Cls,
        columns: {
          id: { type: "int", primary: true, autoIncrement: true },
          col: { type: colType as any },
        },
      });

      expect(
        Reflect.getMetadata("design:type", Cls.prototype, "col"),
      ).toBe(expectedDesignType);
    },
  );
});

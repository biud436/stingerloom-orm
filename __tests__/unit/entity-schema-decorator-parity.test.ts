/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { EntitySchema } from "../../src/schema";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ColumnMetadata } from "../../src/scanner/ColumnScanner";
import {
  COMPUTED_COLUMN_TOKEN,
  ComputedColumnMetadata,
  ComputedColumn,
} from "../../src/decorators/ComputedColumn";
import {
  FULLTEXT_INDEX_TOKEN,
  FullTextIndexMetadata,
} from "../../src/decorators/FullTextIndex";
import {
  JSON_INDEX_TOKEN,
  JsonIndexMetadata,
} from "../../src/decorators/JsonIndex";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
  RelationColumn,
} from "../../src/decorators/RelationColumn";
import {
  TENANT_COLUMN_TOKEN,
  NON_TENANT_ENTITY_TOKEN,
  getTenantColumnMetadata,
  isNonTenantEntity,
} from "../../src/decorators/TenantColumn";
import {
  COMPOSITE_INDEX_TOKEN,
  CompositeIndexMetadata,
  INDEX_TOKEN,
  IndexMetadata,
  Index,
} from "../../src/decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
  UniqueIndex,
} from "../../src/decorators/UniqueIndex";
import { VERSION_TOKEN, Version } from "../../src/decorators/Version";
import {
  CREATE_TIMESTAMP_TOKEN,
  CreateTimestamp,
} from "../../src/decorators/CreateTimestamp";
import {
  UPDATE_TIMESTAMP_TOKEN,
  UpdateTimestamp,
} from "../../src/decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN, DeletedAt } from "../../src/decorators/DeletedAt";
import {
  HOOK_TOKEN,
  HookMetadata,
  BeforeInsert,
  AfterUpdate,
} from "../../src/decorators/Hooks";
import {
  VALIDATION_TOKEN,
  ValidationMetadata,
  NotNull,
  MinLength,
} from "../../src/decorators/Validation";
import {
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  ManyToMany,
} from "../../src/decorators/ManyToMany";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import {
  EntityScanner,
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
} from "../../src/scanner";
import { OneToOneScanner } from "../../src/scanner/OneToOneScanner";

// ─── Helpers (mirror entity-schema.test.ts) ──────────────────────────────────
function clearScanners() {
  getScannerInstance(EntityScanner).clear();
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
}

let counter = 0;
function freshClass(name?: string): any {
  counter++;
  const cls = class {} as any;
  Object.defineProperty(cls, "name", {
    value: name || `ParityEntity${counter}`,
    writable: false,
  });
  return cls;
}

beforeEach(() => {
  clearScanners();
});

// ═══════════════════════════════════════════════════════════════════════════════
// @ComputedColumn  →  computedColumns
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — computedColumns (decorator-free @ComputedColumn)", () => {
  it("registers COMPUTED_COLUMN_TOKEN on the prototype (same location as the decorator)", () => {
    const User = freshClass("User");
    new EntitySchema<any>({
      target: User,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        firstName: { type: "varchar", name: "first_name" },
        lastName: { type: "varchar", name: "last_name" },
      },
      computedColumns: {
        fullName: {
          expression: "first_name || ' ' || last_name",
          stored: true,
          type: "varchar",
        },
      },
    });

    const computed: ComputedColumnMetadata[] = Reflect.getMetadata(
      COMPUTED_COLUMN_TOKEN,
      User.prototype,
    );
    expect(computed).toHaveLength(1);
    expect(computed[0].propertyKey).toBe("fullName");
    expect(computed[0].name).toBe("fullName");
    expect(computed[0].options.expression).toBe(
      "first_name || ' ' || last_name",
    );
    expect(computed[0].options.stored).toBe(true);
    expect(computed[0].options.type).toBe("varchar");

    // Computed columns must NOT leak into the regular column list.
    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      User.prototype,
    );
    expect(columns.map((c) => c.propertyKey)).not.toContain("fullName");
  });

  it("produces metadata identical to @ComputedColumn", () => {
    // Decorator reference
    const Decorated = freshClass("DecoratedComputed");
    ComputedColumn({ expression: "a + b", stored: false, type: "int" })(
      Decorated.prototype,
      "sum",
    );
    const ref: ComputedColumnMetadata[] = Reflect.getMetadata(
      COMPUTED_COLUMN_TOKEN,
      Decorated.prototype,
    );

    // EntitySchema equivalent
    const SchemaBased = freshClass("SchemaComputed");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
      computedColumns: { sum: { expression: "a + b", stored: false, type: "int" } },
    });
    const got: ComputedColumnMetadata[] = Reflect.getMetadata(
      COMPUTED_COLUMN_TOKEN,
      SchemaBased.prototype,
    );

    expect(got).toEqual(ref);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @FullTextIndex  →  fullTextIndexes
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — fullTextIndexes (decorator-free @FullTextIndex)", () => {
  it("registers FULLTEXT_INDEX_TOKEN on the class", () => {
    const Post = freshClass("Post");
    new EntitySchema<any>({
      target: Post,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        title: { type: "varchar" },
        content: { type: "text" },
      },
      fullTextIndexes: [
        { columns: ["title", "content"], name: "ft_post", language: "english" },
      ],
    });

    const ft: FullTextIndexMetadata[] = Reflect.getMetadata(
      FULLTEXT_INDEX_TOKEN,
      Post,
    );
    expect(ft).toHaveLength(1);
    expect(ft[0].columns).toEqual(["title", "content"]);
    expect(ft[0].name).toBe("ft_post");
    expect(ft[0].language).toBe("english");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @JsonIndex  →  columns[x].jsonIndex
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — jsonIndex (decorator-free @JsonIndex)", () => {
  it("registers JSON_INDEX_TOKEN on the class with parsed path segments", () => {
    const Profile = freshClass("Profile");
    new EntitySchema<any>({
      target: Profile,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        data: {
          type: "jsonb",
          jsonIndex: {
            path: "contact.email",
            using: "btree",
          },
        },
      },
    });

    const idx: JsonIndexMetadata[] = Reflect.getMetadata(
      JSON_INDEX_TOKEN,
      Profile,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].propertyKey).toBe("data");
    expect(idx[0].options.using).toBe("btree");
    expect(idx[0].pathSegments).toEqual(["contact", "email"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @RelationColumn  →  relations[x].relationColumn
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — relationColumn (decorator-free @RelationColumn)", () => {
  it("registers RELATION_COLUMN_TOKEN on a manyToOne relation", () => {
    const User = freshClass("User");
    const Post = freshClass("Post");
    new EntitySchema<any>({
      target: Post,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
      relations: {
        author: {
          kind: "manyToOne",
          target: () => User,
          relationColumn: {
            name: "author_id",
            type: "int",
            nullable: false,
            referencedColumn: "id",
          },
        },
      },
    });

    const rc: RelationColumnMetadata[] = Reflect.getMetadata(
      RELATION_COLUMN_TOKEN,
      Post,
    );
    expect(rc).toHaveLength(1);
    expect(rc[0].propertyKey).toBe("author");
    expect(rc[0].name).toBe("author_id");
    expect(rc[0].type).toBe("int");
    expect(rc[0].nullable).toBe(false);
    expect(rc[0].referencedColumn).toBe("id");
  });

  it("matches @RelationColumn output", () => {
    const Target = freshClass("RcTarget");

    const Decorated = freshClass("RcDecorated");
    RelationColumn({ name: "owner_id", type: "bigint" })(
      Decorated.prototype,
      "owner",
    );
    const ref: RelationColumnMetadata[] = Reflect.getMetadata(
      RELATION_COLUMN_TOKEN,
      Decorated,
    );

    const SchemaBased = freshClass("RcSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
      relations: {
        owner: {
          kind: "manyToOne",
          target: () => Target,
          relationColumn: { name: "owner_id", type: "bigint" },
        },
      },
    });
    const got: RelationColumnMetadata[] = Reflect.getMetadata(
      RELATION_COLUMN_TOKEN,
      SchemaBased,
    );

    expect(got[0].name).toBe(ref[0].name);
    expect(got[0].type).toBe(ref[0].type);
    expect(got[0].propertyKey).toBe("owner");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @TenantColumn / @NonTenantEntity  →  columns[x].tenant / nonTenant
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — tenant column (decorator-free @TenantColumn / @NonTenantEntity)", () => {
  it("registers TENANT_COLUMN_TOKEN from a column marked tenant: true", () => {
    const AuditLog = freshClass("AuditLog");
    new EntitySchema<any>({
      target: AuditLog,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        action: { type: "varchar" },
        tenantId: { type: "varchar", name: "tenant_id", length: 64, tenant: true },
      },
    });

    const meta = getTenantColumnMetadata(AuditLog);
    expect(meta).toBeDefined();
    expect(meta!.propertyKey).toBe("tenantId");
    expect(meta!.name).toBe("tenant_id");
    expect(meta!.type).toBe("varchar");
    expect(meta!.length).toBe(64);
    expect(Reflect.getMetadata(TENANT_COLUMN_TOKEN, AuditLog)).toBeDefined();
  });

  it("registers NON_TENANT_ENTITY_TOKEN when nonTenant: true", () => {
    const Tenant = freshClass("Tenant");
    new EntitySchema<any>({
      target: Tenant,
      nonTenant: true,
      columns: {
        id: { type: "varchar", primary: true },
        name: { type: "varchar" },
      },
    });

    expect(isNonTenantEntity(Tenant)).toBe(true);
    expect(Reflect.getMetadata(NON_TENANT_ENTITY_TOKEN, Tenant)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @Column({ transformer }) and generationStrategy
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — column transformer & generationStrategy", () => {
  it("threads a bidirectional transformer onto the column metadata", () => {
    const User = freshClass("User");
    const to = (v: string) => v.toLowerCase();
    const from = (v: string) => v.toUpperCase();
    new EntitySchema<any>({
      target: User,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar", transformer: { to, from } },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      User.prototype,
    );
    const email = columns.find((c) => c.propertyKey === "email")!;
    expect(email.transformer).toBeDefined();
    expect(email.transformer!.to!("ABC")).toBe("abc");
    expect(email.transformer!.from!("abc")).toBe("ABC");
    expect(email.options?.transformer).toBeDefined();
  });

  it("carries generationStrategy through to column options", () => {
    const Token = freshClass("Token");
    new EntitySchema<any>({
      target: Token,
      columns: {
        id: { type: "uuid", primary: true, generationStrategy: "uuid-v7" },
      },
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Token.prototype,
    );
    const id = columns.find((c) => c.propertyKey === "id")!;
    expect(id.options?.generationStrategy).toBe("uuid-v7");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Composite index advanced options
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — composite index advanced options", () => {
  it("preserves advanced index options (where/using/include)", () => {
    const Order = freshClass("Order");
    new EntitySchema<any>({
      target: Order,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar" },
        active: { type: "boolean" },
      },
      indexes: [
        {
          columns: ["email"],
          options: {
            name: "idx_active_email",
            where: "active = true",
            using: "btree",
            include: ["id"],
          },
        },
      ],
    });

    const idx: CompositeIndexMetadata[] = Reflect.getMetadata(
      COMPOSITE_INDEX_TOKEN,
      Order,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].columns).toEqual(["email"]);
    expect(idx[0].name).toBe("idx_active_email");
    expect(idx[0].options).toBeDefined();
    expect(idx[0].options!.where).toBe("active = true");
    expect(idx[0].options!.using).toBe("btree");
    expect(idx[0].options!.include).toEqual(["id"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @Version  →  columns[x].version
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — version (decorator-free @Version)", () => {
  it("registers VERSION_TOKEN at the same location as @Version", () => {
    // Decorator reference
    const Decorated = freshClass("VersionDecorated");
    Reflect.defineMetadata("design:type", Number, Decorated.prototype, "version");
    Version()(Decorated.prototype, "version");
    const ref = Reflect.getMetadata(VERSION_TOKEN, Decorated);

    // EntitySchema equivalent
    const SchemaBased = freshClass("VersionSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        version: { type: "int", version: true },
      },
    });
    const got = Reflect.getMetadata(VERSION_TOKEN, SchemaBased);

    expect(ref).toBe("version");
    expect(got).toBe(ref);

    // The version column itself remains a regular column on both sides.
    const cols: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      SchemaBased.prototype,
    );
    expect(cols.map((c) => c.propertyKey)).toContain("version");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @CreateTimestamp / @UpdateTimestamp / @DeletedAt  →  column flags
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — timestamp & soft-delete flags", () => {
  it("createTimestamp flag matches @CreateTimestamp (CREATE_TIMESTAMP_TOKEN)", () => {
    const Decorated = freshClass("CtDecorated");
    Reflect.defineMetadata("design:type", Date, Decorated.prototype, "createdAt");
    CreateTimestamp()(Decorated.prototype, "createdAt");
    const ref = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, Decorated);

    const SchemaBased = freshClass("CtSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        createdAt: { type: "datetime", createTimestamp: true },
      },
    });
    const got = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, SchemaBased);

    expect(ref).toBe("createdAt");
    expect(got).toBe(ref);
  });

  it("updateTimestamp flag matches @UpdateTimestamp (UPDATE_TIMESTAMP_TOKEN)", () => {
    const Decorated = freshClass("UtDecorated");
    Reflect.defineMetadata("design:type", Date, Decorated.prototype, "updatedAt");
    UpdateTimestamp()(Decorated.prototype, "updatedAt");
    const ref = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, Decorated);

    const SchemaBased = freshClass("UtSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        updatedAt: { type: "datetime", updateTimestamp: true },
      },
    });
    const got = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, SchemaBased);

    expect(ref).toBe("updatedAt");
    expect(got).toBe(ref);
  });

  it("deletedAt flag matches @DeletedAt (DELETED_AT_TOKEN)", () => {
    const Decorated = freshClass("DaDecorated");
    Reflect.defineMetadata("design:type", Date, Decorated.prototype, "deletedAt");
    DeletedAt()(Decorated.prototype, "deletedAt");
    const ref = Reflect.getMetadata(DELETED_AT_TOKEN, Decorated);

    const SchemaBased = freshClass("DaSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        deletedAt: { type: "datetime", nullable: true, deletedAt: true },
      },
    });
    const got = Reflect.getMetadata(DELETED_AT_TOKEN, SchemaBased);

    expect(ref).toBe("deletedAt");
    expect(got).toBe(ref);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @Index (property-level)  →  columns[x].index
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — index flag (decorator-free @Index)", () => {
  it("registers INDEX_TOKEN on the prototype like @Index", () => {
    const Decorated = freshClass("IdxDecorated");
    Reflect.defineMetadata("design:type", String, Decorated.prototype, "email");
    Index()(Decorated.prototype, "email");
    const ref: IndexMetadata[] = Reflect.getMetadata(
      INDEX_TOKEN,
      Decorated.prototype,
    );

    const SchemaBased = freshClass("IdxSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar", index: true },
      },
    });
    const got: IndexMetadata[] = Reflect.getMetadata(
      INDEX_TOKEN,
      SchemaBased.prototype,
    );

    expect(ref).toHaveLength(1);
    expect(ref[0].name).toBe("email");
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe(ref[0].name);
    expect(got[0].type).toBe(ref[0].type);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @UniqueIndex  →  uniqueIndexes
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — uniqueIndexes (decorator-free @UniqueIndex)", () => {
  it("registers UNIQUE_INDEX_TOKEN identically to @UniqueIndex", () => {
    const Decorated = freshClass("UqDecorated");
    UniqueIndex(["email", "tenantId"], "uq_email_tenant")(Decorated as any);
    const ref: UniqueIndexMetadata[] = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      Decorated,
    );

    const SchemaBased = freshClass("UqSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar" },
        tenantId: { type: "varchar" },
      },
      uniqueIndexes: [
        { columns: ["email", "tenantId"], name: "uq_email_tenant" },
      ],
    });
    const got: UniqueIndexMetadata[] = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      SchemaBased,
    );

    expect(got).toEqual(ref);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @Hooks (lifecycle)  →  hooks
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — hooks (decorator-free @BeforeInsert/@AfterUpdate)", () => {
  it("registers HOOK_TOKEN entries matching the lifecycle decorators", () => {
    const Decorated = freshClass("HookDecorated");
    (BeforeInsert() as any)(Decorated.prototype, "onCreate");
    (AfterUpdate() as any)(Decorated.prototype, "onChange");
    const ref: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Decorated);

    const SchemaBased = freshClass("HookSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
      hooks: { beforeInsert: "onCreate", afterUpdate: "onChange" },
    });
    const got: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, SchemaBased);

    // Compare as sets — decorator order vs object key order may differ.
    const sortByEvent = (a: HookMetadata, b: HookMetadata) =>
      a.event.localeCompare(b.event);
    expect([...got].sort(sortByEvent)).toEqual([...ref].sort(sortByEvent));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @Validation  →  columns[x].validation
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — validation (decorator-free @NotNull/@MinLength)", () => {
  it("registers VALIDATION_TOKEN with the same constraints/values", () => {
    const Decorated = freshClass("ValDecorated");
    NotNull()(Decorated.prototype, "name");
    MinLength(3)(Decorated.prototype, "name");
    const ref: ValidationMetadata[] = Reflect.getMetadata(
      VALIDATION_TOKEN,
      Decorated,
    );

    const SchemaBased = freshClass("ValSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        name: {
          type: "varchar",
          validation: [{ constraint: "notNull" }, { constraint: "minLength", value: 3 }],
        },
      },
    });
    const got: ValidationMetadata[] = Reflect.getMetadata(
      VALIDATION_TOKEN,
      SchemaBased,
    );

    // Compare the runtime-visible shape (propertyKey/constraint/value). The
    // auto-generated `message` text is intentionally decorator-vs-schema
    // specific and not part of the enforced behavior.
    const shape = (v: ValidationMetadata) => ({
      propertyKey: v.propertyKey,
      constraint: v.constraint,
      value: v.value,
    });
    expect(got.map(shape)).toEqual(ref.map(shape));
    // Each entry still carries a non-empty message on both sides.
    expect(got.every((v) => typeof v.message === "string" && v.message.length > 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @PrimaryColumn (composite)  →  multiple primary columns
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — composite primary key (decorator-free @PrimaryColumn pair)", () => {
  it("marks multiple columns primary like a @PrimaryColumn pair", () => {
    const Decorated = freshClass("PkDecorated");
    Reflect.defineMetadata("design:type", Number, Decorated.prototype, "orderId");
    Reflect.defineMetadata("design:type", Number, Decorated.prototype, "productId");
    PrimaryColumn()(Decorated.prototype, "orderId");
    PrimaryColumn()(Decorated.prototype, "productId");
    const refCols: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Decorated.prototype,
    );
    const refPrimary = refCols
      .filter((c) => c.options?.primary)
      .map((c) => c.propertyKey)
      .sort();

    const SchemaBased = freshClass("PkSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: {
        orderId: { type: "int", primary: true },
        productId: { type: "int", primary: true },
      },
    });
    const gotCols: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      SchemaBased.prototype,
    );
    const gotPrimary = gotCols
      .filter((c) => c.options?.primary)
      .map((c) => c.propertyKey)
      .sort();

    expect(refPrimary).toEqual(["orderId", "productId"]);
    expect(gotPrimary).toEqual(refPrimary);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// @ManyToMany with custom joinTable  →  relations[x] manyToMany
// ═══════════════════════════════════════════════════════════════════════════════
describe("EntitySchema — manyToMany with custom joinTable", () => {
  it("registers MANY_TO_MANY_TOKEN with the same joinTable option", () => {
    const Tag = freshClass("Tag");
    const joinTable = {
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    };

    const Decorated = freshClass("M2mDecorated");
    ManyToMany(() => Tag, { joinTable })(Decorated.prototype, "tags");
    const ref: ManyToManyMetadata<any>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      Decorated,
    );

    const SchemaBased = freshClass("M2mSchema");
    new EntitySchema<any>({
      target: SchemaBased,
      columns: { id: { type: "int", primary: true, autoIncrement: true } },
      relations: {
        tags: { kind: "manyToMany", target: () => Tag, joinTable },
      },
    });
    const got: ManyToManyMetadata<any>[] = Reflect.getMetadata(
      MANY_TO_MANY_TOKEN,
      SchemaBased,
    );

    expect(ref).toHaveLength(1);
    expect(got).toHaveLength(1);
    expect(got[0].propertyKey).toBe(ref[0].propertyKey);
    expect(got[0].joinTable).toEqual(ref[0].joinTable);
    expect(got[0].joinTable).toEqual(joinTable);
    expect(got[0].getRelatedEntity()).toBe(Tag);
  });
});

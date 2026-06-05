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
} from "../../src/decorators/Indexer";
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

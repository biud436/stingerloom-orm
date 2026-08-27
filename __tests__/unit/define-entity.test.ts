/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { defineEntity, t, InferEntity, EntitySchema } from "../../src/schema";
import { ENTITY_TOKEN, EntityMetadata } from "../../src/decorators/Entity";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { ONE_TO_MANY_TOKEN } from "../../src/decorators/OneToMany";
import { ONE_TO_ONE_TOKEN } from "../../src/decorators/OneToOne";
import { MANY_TO_MANY_TOKEN } from "../../src/decorators/ManyToMany";
import { UNIQUE_INDEX_TOKEN } from "../../src/decorators/UniqueIndex";
import { VERSION_TOKEN } from "../../src/decorators/Version";
import { CREATE_TIMESTAMP_TOKEN } from "../../src/decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../src/decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../../src/decorators/DeletedAt";
import { HOOK_TOKEN, HookMetadata } from "../../src/decorators/Hooks";
import {
  COMPUTED_COLUMN_TOKEN,
  ComputedColumnMetadata,
} from "../../src/decorators/ComputedColumn";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
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

function clearScanners() {
  getScannerInstance(EntityScanner).clear();
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
}

beforeEach(() => {
  clearScanners();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Column registration + builder → ColumnSchemaDef conversion
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — columns", () => {
  it("registers columns with the same metadata as EntitySchema", () => {
    const User = defineEntity("de_user_basic", {
      id: t.int().primary().generated(),
      name: t.varchar(120),
      age: t.int().nullable(),
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      User.prototype,
    );
    expect(columns).toHaveLength(3);
    expect(columns.map((c) => c.propertyKey)).toEqual(
      expect.arrayContaining(["id", "name", "age"]),
    );

    const id = columns.find((c) => c.propertyKey === "id")!;
    expect(id.options?.type).toBe("int");
    expect(id.options?.primary).toBe(true);
    expect(id.options?.autoIncrement).toBe(true);

    const name = columns.find((c) => c.propertyKey === "name")!;
    expect(name.options?.type).toBe("varchar");
    expect(name.options?.length).toBe(120);

    const age = columns.find((c) => c.propertyKey === "age")!;
    expect(age.options?.nullable).toBe(true);
  });

  it("registers the entity (ENTITY_TOKEN) and is recognized by the scanner", () => {
    const Product = defineEntity("de_products", {
      id: t.int().primary().generated(),
      sku: t.varchar(64),
    });

    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Product);
    expect(meta).toBeDefined();
    expect(ReflectManager.isEntity(Product)).toBe(true);
  });

  it("uses the first argument as the table name by default", () => {
    const Order = defineEntity("de_orders", {
      id: t.int().primary().generated(),
    });
    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Order);
    expect(meta.name).toBe("de_orders");
  });

  it("supports an explicit tableName override", () => {
    const Account = defineEntity(
      "de_account",
      { id: t.int().primary().generated() },
      { tableName: "accounts_v2" },
    );
    const meta: EntityMetadata = Reflect.getMetadata(ENTITY_TOKEN, Account);
    expect(meta.name).toBe("accounts_v2");
  });

  it("mints a real, named class usable as an ORM target", () => {
    const Customer = defineEntity("de_customer", {
      id: t.int().primary().generated(),
    });
    expect(typeof Customer).toBe("function");
    expect(Customer.name).toBe("de_customer");
    expect(new Customer()).toBeInstanceOf(Customer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Parity with the equivalent EntitySchema definition
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — parity with EntitySchema", () => {
  it("produces identical column metadata to a hand-written EntitySchema", () => {
    const ViaBuilder = defineEntity("de_parity_a", {
      id: t.int().primary().generated(),
      email: t.varchar(255),
      bio: t.text().nullable(),
    });

    clearScanners();

    class ParityB {}
    Object.defineProperty(ParityB, "name", { value: "de_parity_b" });
    new EntitySchema<any>({
      target: ParityB,
      tableName: "de_parity_b",
      columns: {
        id: { type: "int", primary: true, autoIncrement: true },
        email: { type: "varchar", length: 255 },
        bio: { type: "text", nullable: true },
      },
    });

    const a: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      ViaBuilder.prototype,
    );
    const b: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      ParityB.prototype,
    );

    const normalize = (cols: ColumnMetadata[]) =>
      cols
        .map((c) => ({
          propertyKey: c.propertyKey,
          type: c.options?.type,
          primary: c.options?.primary ?? false,
          autoIncrement: c.options?.autoIncrement ?? false,
          length: c.options?.length,
          nullable: c.options?.nullable ?? false,
        }))
        .sort((x, y) => String(x.propertyKey).localeCompare(String(y.propertyKey)));

    expect(normalize(a)).toEqual(normalize(b));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Special columns
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — special columns", () => {
  it("registers version / timestamps / soft-delete tokens", () => {
    const Audited = defineEntity("de_audited", {
      id: t.int().primary().generated(),
      version: t.int().version(),
      createdAt: t.datetime().createTimestamp(),
      updatedAt: t.datetime().updateTimestamp(),
      deletedAt: t.datetime().deletedAt(),
    });

    expect(Reflect.getMetadata(VERSION_TOKEN, Audited)).toBe("version");
    expect(Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, Audited)).toBe(
      "createdAt",
    );
    expect(Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, Audited)).toBe(
      "updatedAt",
    );
    expect(Reflect.getMetadata(DELETED_AT_TOKEN, Audited)).toBe("deletedAt");
  });

  it("lifts .unique() into a single-column unique index", () => {
    const Member = defineEntity("de_members", {
      id: t.int().primary().generated(),
      email: t.varchar(255).unique(),
    });

    const uniques = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, Member);
    expect(uniques).toBeDefined();
    const flat = JSON.stringify(uniques);
    expect(flat).toContain("email");
  });

  it("marks explicit column names so the naming strategy preserves them (#name-drift)", () => {
    const Doc = defineEntity("de_docs", {
      id: t.int().primary().generated(),
      fullName: t.varchar(120).name("full_name"),
      title: t.varchar(120),
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Doc.prototype,
    );
    const full = columns.find((c) => c.propertyKey === "fullName")!;
    const title = columns.find((c) => c.propertyKey === "title")!;

    // Explicit name → nameExplicit true (kept verbatim by applyNamingStrategy).
    expect(full.name).toBe("full_name");
    expect(full.nameExplicit).toBe(true);
    // No explicit name → nameExplicit falsy (naming strategy may re-derive it).
    expect(title.nameExplicit).toBeFalsy();
  });

  it("maps enum values and infers the literal union", () => {
    const Task = defineEntity("de_tasks", {
      id: t.int().primary().generated(),
      status: t.enum(["open", "closed"]).default("open"),
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Task.prototype,
    );
    const status = columns.find((c) => c.propertyKey === "status")!;
    expect(status.options?.type).toBe("enum");
    expect(status.options?.enumValues).toEqual(["open", "closed"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Relations
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — relations", () => {
  it("registers manyToOne", () => {
    const Author = defineEntity("de_rel_author", {
      id: t.int().primary().generated(),
      name: t.varchar(120),
    });
    const Post = defineEntity("de_rel_post", {
      id: t.int().primary().generated(),
      title: t.varchar(200),
      author: t.manyToOne(() => Author, { joinColumn: "author_id" }),
    });

    const m2o = Reflect.getMetadata(MANY_TO_ONE_TOKEN, Post);
    expect(m2o).toHaveLength(1);
    expect(m2o[0].columnName).toBe("author");
    expect(m2o[0].joinColumn).toBe("author_id");
  });

  it("registers oneToMany", () => {
    const Child = defineEntity("de_rel_child", {
      id: t.int().primary().generated(),
    });
    const Parent = defineEntity("de_rel_parent", {
      id: t.int().primary().generated(),
      children: t.oneToMany(() => Child, "parent"),
    });

    const o2m = Reflect.getMetadata(ONE_TO_MANY_TOKEN, Parent);
    expect(o2m).toHaveLength(1);
    expect(o2m[0].propertyKey).toBe("children");
    expect(o2m[0].mappedBy).toBe("parent");
  });

  it("registers oneToOne", () => {
    const Profile = defineEntity("de_rel_profile", {
      id: t.int().primary().generated(),
    });
    const Acc = defineEntity("de_rel_acc", {
      id: t.int().primary().generated(),
      profile: t.oneToOne(() => Profile, { joinColumn: "profile_id", eager: true }),
    });

    const o2o = Reflect.getMetadata(ONE_TO_ONE_TOKEN, Acc);
    expect(o2o).toHaveLength(1);
    expect(o2o[0].propertyKey).toBe("profile");
    expect(o2o[0].joinColumn).toBe("profile_id");
  });

  it("registers manyToMany", () => {
    const Tag = defineEntity("de_rel_tag", {
      id: t.int().primary().generated(),
    });
    const Article = defineEntity("de_rel_article", {
      id: t.int().primary().generated(),
      tags: t.manyToMany(() => Tag, {
        joinTable: {
          name: "de_article_tags",
          joinColumn: "article_id",
          inverseJoinColumn: "tag_id",
        },
      }),
    });

    const m2m = Reflect.getMetadata(MANY_TO_MANY_TOKEN, Article);
    expect(m2m).toHaveLength(1);
    expect(m2m[0].propertyKey).toBe("tags");
    expect(m2m[0].joinTable?.name).toBe("de_article_tags");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Computed columns
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — computed columns", () => {
  it("routes t.computed into computedColumns (excluded from regular columns)", () => {
    const Person = defineEntity("de_person", {
      id: t.int().primary().generated(),
      firstName: t.varchar(80),
      lastName: t.varchar(80),
      fullName: t.computed("first_name || ' ' || last_name", {
        stored: false,
        type: "varchar",
      }),
    });

    const columns: ColumnMetadata[] = Reflect.getMetadata(
      COLUMN_TOKEN,
      Person.prototype,
    );
    // fullName must NOT be a regular stored column.
    expect(columns.map((c) => c.propertyKey)).not.toContain("fullName");
    expect(columns.map((c) => c.propertyKey)).toEqual(
      expect.arrayContaining(["id", "firstName", "lastName"]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5b. Lifecycle hooks (decorator-free)
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — lifecycle hooks", () => {
  it("attaches an inline hook function and registers HOOK_TOKEN", () => {
    const Article = defineEntity(
      "de_hook_article",
      {
        id: t.int().primary().generated(),
        title: t.varchar(200),
        slug: t.varchar(200).nullable(),
      },
      {
        hooks: {
          beforeInsert(e) {
            if (!e.slug) {
              e.slug = e.title.toLowerCase().replace(/\s+/g, "-");
            }
          },
        },
      },
    );

    const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Article);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].event).toBe("beforeInsert");

    // The resolved hook is a real, callable method on the prototype.
    const method = (Article.prototype as any)[hooks[0].methodName];
    expect(typeof method).toBe("function");
  });

  it("fires the hook (as runHooks does) on an instance built from the constructor", () => {
    const Article = defineEntity(
      "de_hook_fire",
      {
        id: t.int().primary().generated(),
        title: t.varchar(200),
        slug: t.varchar(200).nullable(),
      },
      {
        hooks: {
          beforeInsert(e) {
            e.slug = e.title.toLowerCase().replace(/\s+/g, "-");
          },
        },
      },
    );

    const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Article);
    const instance: any = new Article({ title: "Hello World" });
    // Mirror CascadeHandler.runHooks: method.call(item, item).
    instance[hooks[0].methodName].call(instance, instance);
    expect(instance.slug).toBe("hello-world");
  });

  it("supports a string handler naming a prototype method", () => {
    const Base = defineEntity(
      "de_hook_string",
      { id: t.int().primary().generated() },
      { hooks: { afterInsert: "log" } },
    );
    (Base.prototype as any).log = function log() {
      return "ok";
    };

    const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Base);
    expect(hooks).toEqual([{ methodName: "log", event: "afterInsert" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5c. Constructor initializer
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — constructor initializer", () => {
  it("copies a partial initializer onto the instance", () => {
    const User = defineEntity("de_ctor_user", {
      id: t.int().primary().generated(),
      name: t.varchar(120),
    });

    const u: any = new User({ id: 7, name: "Ada" });
    expect(u.id).toBe(7);
    expect(u.name).toBe("Ada");
    expect(u).toBeInstanceOf(User);
  });

  it("still constructs with no arguments", () => {
    const User = defineEntity("de_ctor_empty", {
      id: t.int().primary().generated(),
    });
    expect(() => new User()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5d. Computed column options pass-through
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — computed column options", () => {
  it("forwards stored / type / length / nullable to the computed metadata", () => {
    const Person = defineEntity("de_computed_opts", {
      id: t.int().primary().generated(),
      firstName: t.varchar(80).name("first_name"),
      lastName: t.varchar(80).name("last_name"),
      fullName: t.computed<string>("first_name || ' ' || last_name", {
        stored: true,
        type: "varchar",
        length: 511,
        nullable: true,
      }),
    });

    const computed: ComputedColumnMetadata[] = Reflect.getMetadata(
      COMPUTED_COLUMN_TOKEN,
      Person.prototype,
    );
    const full = computed.find((c) => c.propertyKey === "fullName")!;
    expect(full.options.stored).toBe(true);
    expect(full.options.type).toBe("varchar");
    expect(full.options.length).toBe(511);
    expect(full.options.nullable).toBe(true);
  });

  it("renders the same GENERATED ALWAYS AS DDL the decorator produces", () => {
    const Person = defineEntity("de_computed_ddl", {
      id: t.int().primary().generated(),
      firstName: t.varchar(80).name("first_name"),
      lastName: t.varchar(80).name("last_name"),
      fullName: t.computed<string>("first_name || ' ' || last_name", {
        stored: true,
        type: "varchar",
        length: 511,
      }),
    });

    const ddl = new SchemaGenerator({ dialect: "postgres" }).generateCreateTableDDL(
      Person,
    );
    expect(ddl).toContain("GENERATED ALWAYS AS");
    expect(ddl).toContain("first_name || ' ' || last_name");
    expect(ddl).toContain("STORED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Type inference (compile-time assertions — fail the build if wrong)
// ═══════════════════════════════════════════════════════════════════════════
describe("defineEntity — type inference", () => {
  it("infers the row type from builders, with relations optional", () => {
    const Author = defineEntity("de_ti_author", {
      id: t.int().primary().generated(),
      name: t.varchar(120),
    });
    const Post = defineEntity("de_ti_post", {
      id: t.int().primary().generated(),
      title: t.varchar(200),
      body: t.text().nullable(),
      published: t.boolean().default(false),
      status: t.enum(["draft", "live"]).default("draft"),
      meta: t.json<{ views: number }>(),
      createdAt: t.datetime().createTimestamp(),
      author: t.manyToOne(() => Author),
    });

    type AuthorRow = InferEntity<typeof Author>;
    type PostRow = InferEntity<typeof Post>;

    // Exact assignability: columns required, relation optional.
    const post: PostRow = {
      id: 1,
      title: "hi",
      body: null,
      published: true,
      status: "live",
      meta: { views: 3 },
      createdAt: new Date(),
      // `author` omitted on purpose — relations are optional.
    };
    expect(post.id).toBe(1);

    // Inferred field types.
    const _id: number = post.id;
    const _title: string = post.title;
    const _body: string | null = post.body;
    const _published: boolean = post.published;
    const _status: "draft" | "live" = post.status;
    const _views: number | undefined = post.meta?.views;
    const _created: Date = post.createdAt;
    const _author: AuthorRow | undefined = post.author;
    void [_id, _title, _body, _published, _status, _views, _created, _author];

    // @ts-expect-error — `status` only accepts the enum literal union.
    const _bad: PostRow["status"] = "archived";
    void _bad;

    // @ts-expect-error — `id` is a number, not a string.
    const _badId: PostRow = { ...post, id: "1" };
    void _badId;
  });
});

describe("defineEntity — unrecognized field values fail fast (V4-T2-4)", () => {
  beforeEach(clearScanners);

  it("throws on an uncalled builder factory with the field name and a parentheses hint", () => {
    expect(() =>
      defineEntity("de_uncalled", {
        id: t.int().primary().generated(),
        email: t.varchar as any,
      }),
    ).toThrow(/field "email".*uncalled builder factory.*t\.varchar\(\)/s);
  });

  it("throws on an undefined field value with an import-cycle hint", () => {
    expect(() =>
      defineEntity("de_undef", {
        id: t.int().primary().generated(),
        author: undefined as any,
      }),
    ).toThrow(/field "author".*got undefined.*import cycle/s);
  });

  it("throws on a plain non-builder value", () => {
    expect(() =>
      defineEntity("de_plain", {
        id: t.int().primary().generated(),
        flags: 123 as any,
      }),
    ).toThrow(/field "flags".*got number/s);
  });

  it("names the entity in the error", () => {
    expect(() =>
      defineEntity("de_named", { broken: t.varchar as any }),
    ).toThrow(/defineEntity\("de_named"\)/);
  });
});

describe("defineEntity — class-name sanitization (V4-T2-4)", () => {
  beforeEach(clearScanners);

  it("keeps identifier table names as the class name", () => {
    const Users = defineEntity("users", { id: t.int().primary() });
    expect(Users.name).toBe("users");
  });

  it("sanitizes non-identifier characters instead of anonymizing", () => {
    const UserAccounts = defineEntity("user-accounts", {
      id: t.int().primary(),
    });
    expect(UserAccounts.name).toBe("user_accounts");
  });

  it("prefixes a leading digit", () => {
    const TwoFa = defineEntity("2fa_codes", { id: t.int().primary() });
    expect(TwoFa.name).toBe("_2fa_codes");
  });

  it("keeps the raw name as the table name after sanitizing the class name", () => {
    const UserAccounts = defineEntity("user.accounts", {
      id: t.int().primary(),
    });
    const meta = Reflect.getMetadata(ENTITY_TOKEN, UserAccounts) as EntityMetadata;
    expect(UserAccounts.name).toBe("user_accounts");
    expect((meta as any).name).toBe("user.accounts");
  });
});

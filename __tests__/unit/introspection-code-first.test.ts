import {
  DbColumn,
  DbForeignKey,
  DbIndex,
  EntityCodeBuilder,
} from "../../src/introspection/EntityCodeBuilder";
import { buildEntityModel } from "../../src/introspection/EntityModel";

/**
 * Code-first (`defineEntity`) output from introspection, plus the fidelity
 * rules both emitters share.
 *
 * The two styles are generated from one model, so every rule pinned here
 * (FK nullability, unbounded varchar, decimal precision, …) holds for the
 * decorator output too — the style only changes the spelling.
 */
describe("EntityCodeBuilder — code-first style", () => {
  const codeFirst = new EntityCodeBuilder({ style: "code-first" });
  const decorator = new EntityCodeBuilder();

  const userColumns: DbColumn[] = [
    {
      column_name: "id",
      data_type: "integer",
      is_nullable: "NO",
      column_default: "nextval('users_id_seq'::regclass)",
    },
    {
      column_name: "email",
      data_type: "character varying",
      is_nullable: "NO",
      character_maximum_length: 255,
    },
    {
      column_name: "display_name",
      data_type: "character varying",
      is_nullable: "YES",
      character_maximum_length: 80,
    },
    {
      column_name: "role",
      data_type: "USER-DEFINED",
      is_nullable: "NO",
      enum_values: ["admin", "member"],
      column_default: "'member'::user_role",
    },
    { column_name: "is_active", data_type: "boolean", is_nullable: "NO", column_default: "true" },
    { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    { column_name: "deleted_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  ];

  it("emits defineEntity with t.* builders instead of decorators", () => {
    const code = codeFirst.build("users", userColumns, ["id"], [], "postgres");

    expect(code).toContain(
      'import { defineEntity, t, type InferEntity } from "@stingerloom/orm";',
    );
    expect(code).toContain('export const User = defineEntity(');
    expect(code).toContain('"users",');
    expect(code).toContain("id: t.int().primary().generated(),");
    expect(code).toContain("email: t.varchar(255),");
    expect(code).toContain('displayName: t.varchar(80).name("display_name").nullable(),');
    expect(code).toContain('role: t.enum(["admin", "member"]).default("member"),');
    expect(code).toContain('isActive: t.boolean().name("is_active").default(true),');
    expect(code).toContain(
      'createdAt: t.timestamptz().name("created_at").createTimestamp(),',
    );
    expect(code).toContain(
      'updatedAt: t.timestamptz().name("updated_at").updateTimestamp(),',
    );
    expect(code).toContain(
      'deletedAt: t.timestamptz().name("deleted_at").deletedAt(),',
    );
    expect(code).toContain(
      "export interface User extends InferEntity<typeof User> {}",
    );
    // No decorator is emitted in this style.
    expect(code).not.toContain("@Entity");
    expect(code).not.toContain("@Column");
  });

  it("defaults to the decorator style", () => {
    const code = new EntityCodeBuilder().build(
      "users",
      userColumns,
      ["id"],
      [],
      "postgres",
    );
    expect(code).toContain("@Entity({ name: \"users\" })");
    expect(code).not.toContain("defineEntity");
  });

  it("emits class-level indexes as defineEntity options", () => {
    const indexes: DbIndex[] = [
      { name: "uq_users_email", column_names: ["email"], is_unique: true },
      {
        name: "idx_users_active_created",
        column_names: ["is_active", "created_at"],
        is_unique: false,
      },
    ];
    const code = codeFirst.build("users", userColumns, ["id"], [], "postgres", indexes);

    expect(code).toContain('uniqueIndexes: [');
    expect(code).toContain('{ columns: ["email"], name: "uq_users_email" },');
    expect(code).toContain("indexes: [");
    expect(code).toContain(
      '{ columns: ["isActive", "createdAt"], name: "idx_users_active_created" },',
    );
  });

  describe("relations", () => {
    const postColumns: DbColumn[] = [
      { column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" },
      { column_name: "author_id", data_type: "bigint", is_nullable: "NO" },
    ];
    const fks: DbForeignKey[] = [
      { column_name: "author_id", referenced_table: "users", referenced_column: "id" },
    ];

    it("annotates the target thunk and imports the target module", () => {
      const code = codeFirst.build("posts", postColumns, ["id"], fks, "postgres");

      expect(code).toContain('import { User } from "./user.entity.js";');
      expect(code).toContain("type AnyEntityClass");
      expect(code).toContain(
        "author: t.manyToOne<User>((): AnyEntityClass => User, {",
      );
      expect(code).toContain(
        'relationColumn: { name: "author_id", type: "bigint", nullable: false, referencedColumn: "id" },',
      );
    });

    it("omits the shape parameter on a self-reference", () => {
      const columns: DbColumn[] = [
        { column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" },
        { column_name: "parent_id", data_type: "integer", is_nullable: "YES" },
      ];
      const selfFk: DbForeignKey[] = [
        { column_name: "parent_id", referenced_table: "departments", referenced_column: "id" },
      ];
      const code = codeFirst.build("departments", columns, ["id"], selfFk, "postgres");

      // `t.manyToOne<Department>` here would make the entity's own row type
      // circular; the annotated thunk alone breaks the cycle.
      expect(code).toContain(
        "parent: t.manyToOne((): AnyEntityClass => Department, {",
      );
      expect(code).not.toMatch(/import\s*\{\s*Department\s*\}\s*from/);
    });
  });
});

describe("buildEntityModel — round-trip fidelity", () => {
  it("pins the FK column's own type and NOT NULL", () => {
    const model = buildEntityModel(
      "posts",
      [
        { column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" },
        { column_name: "author_id", data_type: "uuid", is_nullable: "NO" },
      ],
      ["id"],
      [{ column_name: "author_id", referenced_table: "users", referenced_column: "id" }],
      "postgres",
    );

    const relation = model.fields.find((f) => f.kind === "manyToOne");
    expect(relation).toMatchObject({
      fkColumn: "author_id",
      fkNullable: false,
      referencedColumn: "id",
    });
  });

  it("never marks a primary key nullable, even when the catalog does", () => {
    // SQLite reports notnull = 0 for an INTEGER PRIMARY KEY rowid alias.
    const model = buildEntityModel(
      "users",
      [{ column_name: "id", data_type: "INTEGER", is_nullable: "YES" }],
      ["id"],
      [],
      "sqlite",
    );
    expect(model.fields[0]).toMatchObject({ primary: true, nullable: false });
  });

  it("maps an unbounded varchar to text rather than silently capping it at 255", () => {
    const model = buildEntityModel(
      "notes",
      [
        {
          column_name: "body",
          data_type: "character varying",
          is_nullable: "YES",
          character_maximum_length: null,
        },
      ],
      [],
      [],
      "postgres",
    );
    expect(model.fields[0]).toMatchObject({ columnType: "text" });
  });

  it("keeps precision only for genuinely decimal source types", () => {
    const model = buildEntityModel(
      "measurements",
      [
        {
          column_name: "amount",
          data_type: "numeric",
          is_nullable: "NO",
          numeric_precision: 12,
          numeric_scale: 4,
        },
        {
          // information_schema reports binary precision 53 here; carrying it
          // over produced NUMERIC(53, …) on the way back out.
          column_name: "ratio",
          data_type: "double precision",
          is_nullable: "NO",
          numeric_precision: 53,
        },
      ],
      [],
      [],
      "postgres",
    );

    expect(model.fields[0]).toMatchObject({ precision: 12, scale: 4 });
    expect(model.fields[1]).not.toHaveProperty("precision");
    expect(model.fields[1].kind === "column" && model.fields[1].warnings?.[0]).toContain(
      "no exact ORM column type",
    );
  });

  it("flags a type the mapper does not recognize", () => {
    const model = buildEntityModel(
      "hosts",
      [{ column_name: "addr", data_type: "inet", is_nullable: "NO" }],
      [],
      [],
      "postgres",
    );
    const field = model.fields[0];
    expect(field.kind === "column" && field.warnings?.[0]).toContain(
      "Unrecognized database type",
    );
  });

  it("flags a foreign key that does not reference the target's primary key", () => {
    const model = buildEntityModel(
      "orders",
      [
        { column_name: "id", data_type: "integer", is_nullable: "NO", is_identity: "YES" },
        { column_name: "user_email", data_type: "character varying", is_nullable: "NO", character_maximum_length: 255 },
      ],
      ["id"],
      [
        {
          column_name: "user_email",
          referenced_table: "users",
          referenced_column: "email",
        },
      ],
      "postgres",
      [],
      { primaryKeysByTable: { users: ["id"], orders: ["id"] } },
    );

    const relation = model.fields.find((f) => f.kind === "manyToOne");
    expect(relation?.warnings?.[0]).toContain("is not");
    expect(relation?.warnings?.[0]).toContain("primary key");
  });
});

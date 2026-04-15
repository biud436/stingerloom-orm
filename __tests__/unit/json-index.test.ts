/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Column } from "../../src/decorators/Column";
import { Entity } from "../../src/decorators/Entity";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import {
  JSON_INDEX_TOKEN,
  JsonIndex,
  JsonIndexMetadata,
} from "../../src/decorators/JsonIndex";
import {
  SchemaGenerator,
  SchemaDialect,
} from "../../src/core/generators/SchemaGenerator";

function buildEntity(decorate: (Cls: any) => void) {
  @Entity()
  class User {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "jsonb", nullable: true })
    profile!: Record<string, unknown>;
  }
  decorate(User);
  return User;
}

function gen(dialect: SchemaDialect): SchemaGenerator {
  return new SchemaGenerator({ dialect });
}

describe("@JsonIndex — metadata", () => {
  it("stores metadata under JSON_INDEX_TOKEN on the class", () => {
    @Entity()
    class E {
      @Column({ type: "jsonb" })
      @JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })
      profile!: Record<string, unknown>;
    }
    const meta = Reflect.getMetadata(JSON_INDEX_TOKEN, E) as JsonIndexMetadata[];
    expect(meta).toHaveLength(1);
    expect(meta[0].propertyKey).toBe("profile");
    expect(meta[0].pathSegments).toEqual(["tags"]);
    expect(meta[0].options.using).toBe("gin");
    expect(meta[0].options.opclass).toBe("jsonb_path_ops");
  });

  it("parses nested dot-bracket path into segments", () => {
    @Entity()
    class E {
      @Column({ type: "jsonb" })
      @JsonIndex({ path: "contact.addresses[0].city" })
      profile!: Record<string, unknown>;
    }
    const meta = Reflect.getMetadata(JSON_INDEX_TOKEN, E) as JsonIndexMetadata[];
    expect(meta[0].pathSegments).toEqual(["contact", "addresses", 0, "city"]);
  });

  it("empty path (whole-column index) yields no segments", () => {
    @Entity()
    class E {
      @Column({ type: "jsonb" })
      @JsonIndex({ using: "gin" })
      profile!: Record<string, unknown>;
    }
    const meta = Reflect.getMetadata(JSON_INDEX_TOKEN, E) as JsonIndexMetadata[];
    expect(meta[0].pathSegments).toEqual([]);
  });

  it("multiple @JsonIndex declarations on the same column are all stored", () => {
    @Entity()
    class E {
      @Column({ type: "jsonb" })
      @JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })
      @JsonIndex({ path: "contact.email", using: "btree" })
      profile!: Record<string, unknown>;
    }
    const meta = Reflect.getMetadata(JSON_INDEX_TOKEN, E) as JsonIndexMetadata[];
    expect(meta).toHaveLength(2);
    expect(meta.map((m) => m.options.path).sort()).toEqual([
      "contact.email",
      "tags",
    ]);
  });
});

describe("SchemaGenerator.generateJsonIndexDDL() — PostgreSQL", () => {
  const g = gen("postgres");

  it("whole-column GIN without opclass", () => {
    const U = buildEntity((Cls) => JsonIndex({ using: "gin" })(Cls.prototype, "profile"));
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toMatch(/CREATE INDEX IF NOT EXISTS ".+" ON ".+" USING gin \("profile"\)/);
    expect(ddls[0]).not.toContain("jsonb_ops");
  });

  it("whole-column GIN with jsonb_path_ops opclass", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ using: "gin", opclass: "jsonb_path_ops" })(Cls.prototype, "profile"),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain("USING gin");
    expect(ddls[0]).toContain('("profile" jsonb_path_ops)');
  });

  it("single-segment path GIN uses chained -> expression", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })(
        Cls.prototype,
        "profile",
      ),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain("USING gin");
    expect(ddls[0]).toContain(`(("profile" -> 'tags') jsonb_path_ops)`);
  });

  it("multi-segment path GIN chains -> for each segment", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "contact.addresses[0].city", using: "gin" })(
        Cls.prototype,
        "profile",
      ),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain(
      `(("profile" -> 'contact' -> 'addresses' -> 0 -> 'city'))`,
    );
  });

  it("btree leaf uses #>> text extraction (for ordering / equality scans)", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "contact.email", using: "btree" })(Cls.prototype, "profile"),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain("USING btree");
    expect(ddls[0]).toContain(`("profile" #>> '{contact,email}'::text[])`);
    // opclass is ignored on btree
    expect(ddls[0]).not.toContain("jsonb");
  });

  it("honors a custom `name` option", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin", name: "my_custom_idx" })(
        Cls.prototype,
        "profile",
      ),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain(`"my_custom_idx"`);
  });

  it("auto-generated name encodes column + path + using", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin" })(Cls.prototype, "profile"),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toMatch(/"idx_user_profile_tags_gin"/);
  });

  it("appends WHERE for partial indexes", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin", where: `"active" = true` })(
        Cls.prototype,
        "profile",
      ),
    );
    const ddls = g.generateJsonIndexDDL(U);
    expect(ddls[0]).toContain(`WHERE "active" = true`);
  });

  it("no @JsonIndex declarations → empty DDL array", () => {
    @Entity()
    class Plain {
      @PrimaryGeneratedColumn() id!: number;
      @Column({ type: "jsonb" }) profile!: Record<string, unknown>;
    }
    expect(g.generateJsonIndexDDL(Plain)).toEqual([]);
  });

  it("includes JSON-index DDL inside generateSchemaDDL() output", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })(
        Cls.prototype,
        "profile",
      ),
    );
    const all = g.generateSchemaDDL([U]);
    const matches = all.filter((d) => d.includes(`-> 'tags'`));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SchemaGenerator.generateJsonIndexDDL() — MySQL / SQLite", () => {
  it("MySQL emits nothing (functional indexes require virtual columns)", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin" })(Cls.prototype, "profile"),
    );
    expect(gen("mysql").generateJsonIndexDDL(U)).toEqual([]);
  });

  it("SQLite emits nothing (no GIN equivalent)", () => {
    const U = buildEntity((Cls) =>
      JsonIndex({ path: "tags", using: "gin" })(Cls.prototype, "profile"),
    );
    expect(gen("sqlite").generateJsonIndexDDL(U)).toEqual([]);
  });
});

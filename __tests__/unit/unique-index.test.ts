import "reflect-metadata";
import Container from "typedi";
import {
  UniqueIndex,
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../../src/decorators/UniqueIndex";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

// ─────────────────────────────────────────────
// @UniqueIndex decorator metadata tests
// ─────────────────────────────────────────────
describe("@UniqueIndex decorator", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  it("should store unique index metadata on the class", () => {
    @Entity()
    @UniqueIndex(["email", "tenantId"])
    class UqTest1 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      email!: string;

      @Column({ type: "int" })
      tenantId!: number;
    }

    const metadata: UniqueIndexMetadata[] = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      UqTest1,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].columns).toEqual(["email", "tenantId"]);
    expect(metadata[0].name).toBeUndefined();
  });

  it("should allow custom index name", () => {
    @Entity()
    @UniqueIndex(["email", "tenantId"], "idx_email_tenant")
    class UqTest2 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      email!: string;

      @Column({ type: "int" })
      tenantId!: number;
    }

    const metadata: UniqueIndexMetadata[] = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      UqTest2,
    );

    expect(metadata).toBeDefined();
    expect(metadata[0].name).toBe("idx_email_tenant");
  });

  it("should support multiple @UniqueIndex decorators", () => {
    // TS decorators apply bottom-up, so the first decorator in array is the last one applied
    @Entity()
    @UniqueIndex(["email", "tenantId"])
    @UniqueIndex(["name", "tenantId"], "idx_name_tenant")
    class UqTest3 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      email!: string;

      @Column()
      name!: string;

      @Column({ type: "int" })
      tenantId!: number;
    }

    const metadata: UniqueIndexMetadata[] = Reflect.getMetadata(
      UNIQUE_INDEX_TOKEN,
      UqTest3,
    );

    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(2);
    // Bottom-up: @UniqueIndex(["name", "tenantId"]) is applied first
    expect(metadata[0].columns).toEqual(["name", "tenantId"]);
    expect(metadata[0].name).toBe("idx_name_tenant");
    expect(metadata[1].columns).toEqual(["email", "tenantId"]);
  });

  it("should not have metadata on classes without @UniqueIndex", () => {
    @Entity()
    class UqTestPlain {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;
    }

    const metadata = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, UqTestPlain);
    expect(metadata).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Driver addCompositeUniqueIndex DDL tests
// ─────────────────────────────────────────────
describe("Driver.addCompositeUniqueIndex()", () => {
  let mockQuery: jest.Mock;
  let connector: any;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue(undefined);
    connector = { query: mockQuery };
  });

  describe("MySqlDriver", () => {
    it("should generate CREATE UNIQUE INDEX DDL", async () => {
      const driver = new MySqlDriver(connector);
      await driver.addCompositeUniqueIndex("User", ["email", "tenantId"], "uq_User_email_tenantId");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain("CREATE UNIQUE INDEX");
      expect(sql).toContain("`uq_User_email_tenantId`");
      expect(sql).toContain("`User`");
      expect(sql).toContain("`email`");
      expect(sql).toContain("`tenantId`");
    });
  });

  describe("PostgresDriver", () => {
    it("should generate CREATE UNIQUE INDEX IF NOT EXISTS DDL with schema-qualified table", async () => {
      const driver = new PostgresDriver(connector, "postgres", "public");
      await driver.addCompositeUniqueIndex("User", ["email", "tenantId"], "uq_User_email_tenantId");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
      expect(sql).toContain('"uq_User_email_tenantId"');
      expect(sql).toContain('"public"."User"');
      expect(sql).toContain('"email"');
      expect(sql).toContain('"tenantId"');
    });
  });

  describe("SqliteDriver", () => {
    it("should generate CREATE UNIQUE INDEX IF NOT EXISTS DDL", async () => {
      const driver = new SqliteDriver(connector);
      await driver.addCompositeUniqueIndex("User", ["email", "tenantId"], "uq_User_email_tenantId");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
      expect(sql).toContain('"uq_User_email_tenantId"');
      expect(sql).toContain('"User"');
      expect(sql).toContain('"email"');
      expect(sql).toContain('"tenantId"');
    });
  });

});

// ─────────────────────────────────────────────
// SchemaGenerator unique index DDL tests
// ─────────────────────────────────────────────
describe("SchemaGenerator.generateUniqueIndexDDL()", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  describe("MySQL dialect", () => {
    it("should generate CREATE UNIQUE INDEX DDL for composite columns", () => {
      @Entity()
      @UniqueIndex(["email", "tenant_id"])
      @UniqueIndex(["username"], "idx_unique_username")
      class UqUser {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column()
        email!: string;

        @Column()
        username!: string;

        @Column({ type: "int" })
        tenant_id!: number;
      }

      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddls = gen.generateUniqueIndexDDL(UqUser);

      expect(ddls).toHaveLength(2);
      // Bottom-up order: idx_unique_username first, then email+tenant_id
      const emailIdx = ddls.find((d) => d.includes("`email`"));
      const usernameIdx = ddls.find((d) => d.includes("`username`"));
      expect(emailIdx).toBeDefined();
      expect(usernameIdx).toBeDefined();
      expect(emailIdx).toContain("CREATE UNIQUE INDEX");
      expect(emailIdx).toContain("`email`");
      expect(emailIdx).toContain("`tenant_id`");
      expect(usernameIdx).toContain("`idx_unique_username`");
    });
  });

  describe("PostgreSQL dialect", () => {
    it("should generate CREATE UNIQUE INDEX IF NOT EXISTS DDL with schema", () => {
      @Entity()
      @UniqueIndex(["email", "tenant_id"])
      class UqPgUser {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column()
        email!: string;

        @Column({ type: "int" })
        tenant_id!: number;
      }

      const gen = new SchemaGenerator({ dialect: "postgres", schema: "myschema" });
      const ddls = gen.generateUniqueIndexDDL(UqPgUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
      expect(ddls[0]).toContain('"email"');
      expect(ddls[0]).toContain('"tenant_id"');
    });
  });

  it("should return empty array for entities without @UniqueIndex", () => {
    @Entity()
    class UqPlain {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;
    }

    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateUniqueIndexDDL(UqPlain);
    expect(ddls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// SchemaGenerator.generateSchemaDDL() includes unique indexes
// ─────────────────────────────────────────────
describe("SchemaGenerator.generateSchemaDDL() with @UniqueIndex", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
  });

  it("should include unique index DDL in schema generation", () => {
    @Entity()
    @UniqueIndex(["sku", "warehouse_id"])
    class UqProduct {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      sku!: string;

      @Column({ type: "int" })
      warehouse_id!: number;

      @Column()
      name!: string;
    }

    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateSchemaDDL([UqProduct]);

    // Should contain CREATE TABLE and CREATE UNIQUE INDEX
    const createTable = ddls.find((d) => d.includes("CREATE TABLE"));
    const createUniqueIndex = ddls.find((d) => d.includes("CREATE UNIQUE INDEX"));

    expect(createTable).toBeDefined();
    expect(createUniqueIndex).toBeDefined();
    expect(createUniqueIndex).toContain("`sku`");
    expect(createUniqueIndex).toContain("`warehouse_id`");
  });

  it("should place unique index DDL after CREATE TABLE and normal INDEX", () => {
    @Entity()
    @UniqueIndex(["sku", "warehouse_id"])
    class UqProduct2 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      sku!: string;

      @Column({ type: "int" })
      warehouse_id!: number;
    }

    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateSchemaDDL([UqProduct2]);

    const createTableIdx = ddls.findIndex((d) => d.includes("CREATE TABLE"));
    const uniqueIndexIdx = ddls.findIndex((d) => d.includes("CREATE UNIQUE INDEX"));

    expect(createTableIdx).toBeGreaterThanOrEqual(0);
    expect(uniqueIndexIdx).toBeGreaterThan(createTableIdx);
  });
});

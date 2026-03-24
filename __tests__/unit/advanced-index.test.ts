/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Index, COMPOSITE_INDEX_TOKEN, CompositeIndexMetadata } from "../../src/decorators/Indexer";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
@Index(["email"], { where: "active = true" })
class PartialIndexUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "boolean" })
  active!: boolean;
}

@Entity()
@Index(["email"], { expression: "LOWER(email)" })
class ExpressionIndexUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

@Entity()
@Index(["tags"], { using: "gin" })
class GinIndexArticle {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "jsonb" })
  tags!: string;
}

@Entity()
@Index(["email"], { using: "brin" })
class BrinIndexLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

@Entity()
@Index(["data"], { using: "gist" })
class GistIndexEntry {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  data!: string;
}

@Entity()
@Index(["email"], { using: "hash" })
class HashIndexUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

@Entity()
@Index(["userId", "status"], { include: ["createdAt", "amount"], name: "idx_orders_covering" })
class CoveringIndexOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  userId!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "datetime" })
  createdAt!: Date;

  @Column({ type: "double" })
  amount!: number;
}

@Entity()
@Index(["email"], {
  where: "deleted_at IS NULL",
  using: "btree",
  include: ["name"],
  name: "idx_active_users_email",
})
class CombinedOptionsUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "datetime", nullable: true })
  deleted_at!: Date | null;
}

@Entity()
@Index(["tenantId", "status"])
class BasicCompositeOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  tenantId!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;
}

@Entity()
@Index(["email"], { using: "gin" })
class MysqlGinAttempt {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

@Entity()
@Index(["email"], { using: "btree" })
class MysqlBtreeUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  email!: string;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("Advanced Index Types", () => {
  describe("Partial index (WHERE clause)", () => {
    it("should generate partial index DDL for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(PartialIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("WHERE active = true");
      expect(ddls[0]).toContain("CREATE INDEX IF NOT EXISTS");
      expect(ddls[0]).toContain('"email"');
    });

    it("should generate partial index DDL for SQLite", () => {
      const sg = new SchemaGenerator({ dialect: "sqlite" });
      const ddls = sg.generateCompositeIndexDDL(PartialIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("WHERE active = true");
    });

    it("should skip WHERE clause for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(PartialIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).not.toContain("WHERE");
    });
  });

  describe("Expression index", () => {
    it("should generate expression index DDL for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(ExpressionIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("(LOWER(email))");
      // Should NOT contain the escaped column name as regular column
      expect(ddls[0]).not.toContain('("email")');
    });

    it("should generate expression index DDL for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(ExpressionIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("(LOWER(email))");
    });
  });

  describe("USING clause", () => {
    it("should generate USING gin for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(GinIndexArticle);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING gin");
    });

    it("should generate USING brin for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(BrinIndexLog);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING brin");
    });

    it("should generate USING gist for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(GistIndexEntry);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING gist");
    });

    it("should generate USING hash for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(HashIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING hash");
    });

    it("should skip unsupported USING methods for MySQL (gin)", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(MysqlGinAttempt);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).not.toContain("USING");
    });

    it("should support USING btree for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(MysqlBtreeUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING BTREE");
    });

    it("should support USING hash for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(HashIndexUser);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("USING HASH");
    });
  });

  describe("INCLUDE clause (covering index)", () => {
    it("should generate INCLUDE clause for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(CoveringIndexOrder);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain('INCLUDE ("createdAt", "amount")');
      expect(ddls[0]).toContain('"idx_orders_covering"');
    });

    it("should skip INCLUDE clause for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(CoveringIndexOrder);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).not.toContain("INCLUDE");
    });

    it("should skip INCLUDE clause for SQLite", () => {
      const sg = new SchemaGenerator({ dialect: "sqlite" });
      const ddls = sg.generateCompositeIndexDDL(CoveringIndexOrder);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).not.toContain("INCLUDE");
    });
  });

  describe("Combined options", () => {
    it("should generate DDL with USING + INCLUDE + WHERE for PostgreSQL", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(CombinedOptionsUser);

      expect(ddls).toHaveLength(1);
      const ddl = ddls[0];
      expect(ddl).toContain('"idx_active_users_email"');
      expect(ddl).toContain("USING btree");
      expect(ddl).toContain('INCLUDE ("name")');
      expect(ddl).toContain("WHERE deleted_at IS NULL");
    });
  });

  describe("Backward compatibility", () => {
    it("existing @Index(columns, name) still works without options", () => {
      const sg = new SchemaGenerator({ dialect: "postgres" });
      const ddls = sg.generateCompositeIndexDDL(BasicCompositeOrder);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain('"tenantId"');
      expect(ddls[0]).toContain('"status"');
      expect(ddls[0]).not.toContain("USING");
      expect(ddls[0]).not.toContain("WHERE");
      expect(ddls[0]).not.toContain("INCLUDE");
    });

    it("existing @Index(columns, name) still works for MySQL", () => {
      const sg = new SchemaGenerator({ dialect: "mysql" });
      const ddls = sg.generateCompositeIndexDDL(BasicCompositeOrder);

      expect(ddls).toHaveLength(1);
      expect(ddls[0]).toContain("`tenantId`");
      expect(ddls[0]).toContain("`status`");
      expect(ddls[0]).toContain("CREATE INDEX ");
      expect(ddls[0]).not.toContain("IF NOT EXISTS");
    });
  });

  describe("Decorator metadata", () => {
    it("should store AdvancedIndexOptions in CompositeIndexMetadata", () => {
      const metadata: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, CombinedOptionsUser) ?? [];

      expect(metadata).toHaveLength(1);
      expect(metadata[0].options).toBeDefined();
      expect(metadata[0].options!.where).toBe("deleted_at IS NULL");
      expect(metadata[0].options!.using).toBe("btree");
      expect(metadata[0].options!.include).toEqual(["name"]);
      expect(metadata[0].options!.name).toBe("idx_active_users_email");
    });

    it("should not have options for basic @Index(columns)", () => {
      const metadata: CompositeIndexMetadata[] =
        Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, BasicCompositeOrder) ?? [];

      expect(metadata).toHaveLength(1);
      expect(metadata[0].options).toBeUndefined();
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Index } from "../../src/decorators/Indexer";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { Version } from "../../src/decorators/Version";
import { DeletedAt } from "../../src/decorators/DeletedAt";

// ─────────────────────────────────────────────────
// Test entities
// ─────────────────────────────────────────────────

@Entity()
class Category {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;
}

@Entity()
class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "float" })
  price!: number;

  @Column({ type: "boolean" })
  active!: boolean;

  @Column({ type: "text", nullable: true })
  description!: string;

  @Index()
  @Column({ type: "varchar", length: 100 })
  sku!: string;

  @Version()
  version!: number;

  @DeletedAt()
  deletedAt!: Date | null;

  @ManyToOne(
    () => Category,
    (e: any) => e.category,
    { joinColumn: "category_id" },
  )
  category!: Category;
}

@Entity()
class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", nullable: true })
  bio!: string;
}

@Entity()
class UserWithProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @OneToOne(() => Profile, { joinColumn: "profile_id" })
  profile!: Profile;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("SchemaGenerator", () => {
  describe("MySQL dialect", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("CREATE TABLE DDL을 생성해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Category);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddl).toContain("ENGINE=InnoDB");
      expect(ddl).toContain("`id`");
      expect(ddl).toContain("`name`");
      expect(ddl).toContain("PRIMARY KEY");
      expect(ddl).toContain("AUTO_INCREMENT");
    });

    it("컬럼 타입을 올바르게 변환해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Product);
      expect(ddl).toContain("VARCHAR(255)");
      expect(ddl).toContain("FLOAT");
      expect(ddl).toContain("TINYINT(1)");
      expect(ddl).toContain("TEXT");
    });

    it("nullable 컬럼을 올바르게 처리해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Product);
      // description은 nullable: true
      expect(ddl).toMatch(/`description`\s+TEXT(\(\d+\))?\s+NULL/);
      // name은 nullable: false
      expect(ddl).toMatch(/`name`\s+VARCHAR\(255\)\s+NOT NULL/);
    });

    it("CREATE INDEX DDL을 생성해야 함", () => {
      const indexes = gen.generateCreateIndexDDL(Product);
      expect(indexes.length).toBeGreaterThanOrEqual(1);
      const skuIndex = indexes.find((i) => i.includes("sku"));
      expect(skuIndex).toBeDefined();
      expect(skuIndex).toContain("CREATE INDEX");
      expect(skuIndex).toContain("INDEX_product_sku");
    });

    it("FOREIGN KEY DDL을 생성해야 함", () => {
      const fks = gen.generateForeignKeyDDL(Product);
      expect(fks.length).toBeGreaterThanOrEqual(1);
      const catFk = fks.find((f) => f.includes("category_id"));
      expect(catFk).toBeDefined();
      expect(catFk).toContain("FOREIGN KEY");
      expect(catFk).toContain("REFERENCES");
      expect(catFk).toContain("ON DELETE NO ACTION");
    });

    it("DROP TABLE DDL을 생성해야 함", () => {
      const ddl = gen.generateDropTableDDL(Product);
      expect(ddl).toContain("DROP TABLE IF EXISTS");
    });

    it("@Version 데코레이터가 VERSION_TOKEN 메타데이터를 설정해야 함", () => {
      // @Version()은 VERSION_TOKEN 메타데이터만 설정하고
      // Column 호출은 반환값으로만 존재합니다 (실제 호출되지 않음).
      // 따라서 SchemaGenerator의 DDL에는 version 컬럼이 별도 Column으로 등록되지 않습니다.
      // 실제 동기화에서는 별도 처리가 필요합니다.
      const VERSION_TOKEN = Symbol.for("STG_VERSION");
      const hasVersion = Reflect.getMetadata(VERSION_TOKEN, Product.prototype);
      expect(hasVersion).toBe(true);
    });

    it("@DeletedAt 컬럼이 nullable로 포함되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Product);
      expect(ddl).toContain("`deletedAt`");
      expect(ddl).toMatch(/`deletedAt`\s+DATETIME\s+NULL/);
    });

    it("OneToOne FK DDL을 생성해야 함", () => {
      const fks = gen.generateForeignKeyDDL(UserWithProfile);
      expect(fks.length).toBeGreaterThanOrEqual(1);
      const profileFk = fks.find((f) => f.includes("profile_id"));
      expect(profileFk).toBeDefined();
      expect(profileFk).toContain("REFERENCES");
    });
  });

  describe("PostgreSQL dialect", () => {
    const gen = new SchemaGenerator({ dialect: "postgres", schema: "myschema" });

    it("CREATE TABLE DDL을 생성해야 함 (schema-qualified)", () => {
      const ddl = gen.generateCreateTableDDL(Category);
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS");
      expect(ddl).toContain('"myschema".');
      expect(ddl).not.toContain("ENGINE=InnoDB");
      expect(ddl).toContain('"id"');
      expect(ddl).toContain('"name"');
      expect(ddl).toContain("PRIMARY KEY");
    });

    it("auto increment에 SERIAL을 사용해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Category);
      expect(ddl).toContain("SERIAL");
      expect(ddl).not.toContain("AUTO_INCREMENT");
    });

    it("boolean에 BOOLEAN을 사용해야 함 (TINYINT 아님)", () => {
      const ddl = gen.generateCreateTableDDL(Product);
      expect(ddl).toContain("BOOLEAN");
      expect(ddl).not.toContain("TINYINT");
    });

    it("float에 REAL을 사용해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Product);
      expect(ddl).toContain("REAL");
    });

    it("CREATE INDEX DDL에 IF NOT EXISTS를 포함해야 함", () => {
      const indexes = gen.generateCreateIndexDDL(Product);
      const skuIndex = indexes.find((i) => i.includes("sku"));
      expect(skuIndex).toContain("IF NOT EXISTS");
    });

    it("큰따옴표로 식별자를 래핑해야 함", () => {
      const ddl = gen.generateCreateTableDDL(Category);
      expect(ddl).toContain('"id"');
      expect(ddl).toContain('"name"');
    });

    it("기본 schema는 public이어야 함", () => {
      const genDefault = new SchemaGenerator({ dialect: "postgres" });
      const ddl = genDefault.generateCreateTableDDL(Category);
      expect(ddl).toContain('"public".');
    });
  });

  describe("generateSchemaDDL()", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("CREATE TABLE → INDEX → FK 순서로 생성해야 함", () => {
      const ddls = gen.generateSchemaDDL([Category, Product]);

      // CREATE TABLE이 먼저 나와야 함
      const createTableIdxs = ddls
        .map((d, i) => (d.startsWith("CREATE TABLE") ? i : -1))
        .filter((i) => i >= 0);
      const indexIdxs = ddls
        .map((d, i) => (d.startsWith("CREATE INDEX") ? i : -1))
        .filter((i) => i >= 0);
      const fkIdxs = ddls
        .map((d, i) => (d.startsWith("ALTER TABLE") ? i : -1))
        .filter((i) => i >= 0);

      if (createTableIdxs.length > 0 && indexIdxs.length > 0) {
        expect(Math.max(...createTableIdxs)).toBeLessThan(
          Math.min(...indexIdxs),
        );
      }
      if (indexIdxs.length > 0 && fkIdxs.length > 0) {
        expect(Math.max(...indexIdxs)).toBeLessThan(Math.min(...fkIdxs));
      }
    });

    it("모든 엔티티에 대한 DDL을 생성해야 함", () => {
      const ddls = gen.generateSchemaDDL([Category, Product]);
      const createTables = ddls.filter((d) => d.startsWith("CREATE TABLE"));
      expect(createTables.length).toBe(2);
    });
  });

  describe("generateDropSchemaDDL()", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("역순으로 DROP TABLE을 생성해야 함 (FK 의존성)", () => {
      const ddls = gen.generateDropSchemaDDL([Category, Product]);
      expect(ddls.length).toBe(2);
      // Product가 먼저 drop (Category에 FK 의존)
      expect(ddls[0]).toContain("product");
      expect(ddls[1]).toContain("category");
    });

    it("DROP TABLE IF EXISTS를 사용해야 함", () => {
      const ddls = gen.generateDropSchemaDDL([Category]);
      expect(ddls[0]).toContain("DROP TABLE IF EXISTS");
    });
  });

  describe("엣지 케이스", () => {
    it("인덱스 없는 엔티티의 CREATE INDEX가 빈 배열이어야 함", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const indexes = gen.generateCreateIndexDDL(Category);
      expect(indexes).toEqual([]);
    });

    it("FK 없는 엔티티의 FOREIGN KEY DDL이 빈 배열이어야 함", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const fks = gen.generateForeignKeyDDL(Category);
      expect(fks).toEqual([]);
    });

    it("빈 entities 배열로 generateSchemaDDL이 빈 배열을 반환해야 함", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const ddls = gen.generateSchemaDDL([]);
      expect(ddls).toEqual([]);
    });
  });
});

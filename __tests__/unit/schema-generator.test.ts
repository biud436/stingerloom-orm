/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import crypto from "crypto";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
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
      // @Version()은 VERSION_TOKEN에 프로퍼티 이름(컬럼명)을 저장하고,
      // Column 데코레이터도 함께 호출하여 int 컬럼으로 등록합니다.
      const VERSION_TOKEN = Symbol.for("STG_VERSION");
      const versionColumn = Reflect.getMetadata(VERSION_TOKEN, Product);
      expect(versionColumn).toBe("version");
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

  describe("generateForeignKeyName() 해시 기반 네이밍", () => {
    it("SHA1 해시 8자를 포함한 FK 이름을 생성해야 함", () => {
      const name = SchemaGenerator.generateForeignKeyName("orders", "user_id", "users");
      // fk_{tableName}_{hash8} 형태여야 함
      expect(name).toMatch(/^fk_orders_[0-9a-f]{8}$/);
    });

    it("동일 입력에 대해 동일 결과를 반환해야 함 (결정적)", () => {
      const name1 = SchemaGenerator.generateForeignKeyName("products", "category_id", "categories");
      const name2 = SchemaGenerator.generateForeignKeyName("products", "category_id", "categories");
      expect(name1).toBe(name2);
    });

    it("다른 입력에 대해 다른 이름을 생성해야 함", () => {
      const name1 = SchemaGenerator.generateForeignKeyName("orders", "user_id", "users");
      const name2 = SchemaGenerator.generateForeignKeyName("orders", "product_id", "products");
      expect(name1).not.toBe(name2);
    });

    it("fk_ 접두사로 시작해야 함", () => {
      const name = SchemaGenerator.generateForeignKeyName("t", "c", "r");
      expect(name).toMatch(/^fk_/);
    });

    it("63자 이하여야 함 (MySQL/PG 제한)", () => {
      const longTable = "a".repeat(100);
      const longColumn = "b".repeat(100);
      const longRef = "c".repeat(100);
      const name = SchemaGenerator.generateForeignKeyName(longTable, longColumn, longRef);
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it("매우 긴 테이블 이름에서 fk_{hash} 형태로 fallback해야 함", () => {
      const longTable = "a".repeat(60);
      const name = SchemaGenerator.generateForeignKeyName(longTable, "col", "ref");
      // fk_ + 60자 + _ + 8자 hash = 72자 > 63자이므로 fallback
      expect(name).toMatch(/^fk_[0-9a-f]{8}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it("FK DDL에서 해시 기반 이름을 사용해야 함", () => {
      const gen = new SchemaGenerator({ dialect: "mysql" });
      const fks = gen.generateForeignKeyDDL(Product);
      const catFk = fks.find((f) => f.includes("category_id"));
      expect(catFk).toBeDefined();
      // 해시 기반 이름이 포함되어야 함
      const expectedName = SchemaGenerator.generateForeignKeyName("product", "category_id", "category");
      expect(catFk).toContain(expectedName);
    });

    it("같은 테이블에서 다른 FK 컬럼이면 다른 이름이 생성되어야 함", () => {
      const fk1 = SchemaGenerator.generateForeignKeyName("posts", "author_id", "users");
      const fk2 = SchemaGenerator.generateForeignKeyName("posts", "reviewer_id", "users");
      expect(fk1).not.toBe(fk2);
    });
  });
});

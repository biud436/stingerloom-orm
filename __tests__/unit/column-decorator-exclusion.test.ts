import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { COLUMN_TOKEN } from "../../src/decorators/Column";

// ─────────────────────────────────────────────────
// Test entity: every property has @Column except one
// ─────────────────────────────────────────────────

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "text", nullable: true })
  content!: string;

  @Column({ type: "boolean" })
  published!: boolean;

  @Column({ type: "int" })
  viewCount!: number;

  // This property has no @Column decorator — it should be excluded from DDL
  temporaryNote!: string;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("@Column 데코레이터가 없는 속성은 DDL에서 제외", () => {
  describe("메타데이터 레벨 검증", () => {
    it("COLUMN_TOKEN 메타데이터에 데코레이터가 있는 컬럼만 포함되어야 함", () => {
      const columns = Reflect.getMetadata(COLUMN_TOKEN, Article.prototype) ?? [];
      const columnNames = columns.map((c: any) => c.name);

      expect(columnNames).toContain("id");
      expect(columnNames).toContain("title");
      expect(columnNames).toContain("content");
      expect(columnNames).toContain("published");
      expect(columnNames).toContain("viewCount");
      expect(columnNames).not.toContain("temporaryNote");
    });

    it("메타데이터 컬럼 수가 정확히 5개여야 함", () => {
      const columns = Reflect.getMetadata(COLUMN_TOKEN, Article.prototype) ?? [];
      expect(columns.length).toBe(5);
    });
  });

  describe("MySQL DDL 검증", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("데코레이터가 있는 컬럼은 DDL에 포함되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Article);

      expect(ddl).toContain("`id`");
      expect(ddl).toContain("`title`");
      expect(ddl).toContain("`content`");
      expect(ddl).toContain("`published`");
      expect(ddl).toContain("`viewCount`");
    });

    it("데코레이터가 없는 속성은 DDL에 포함되지 않아야 함", () => {
      const ddl = gen.generateCreateTableDDL(Article);

      expect(ddl).not.toContain("temporaryNote");
    });
  });

  describe("PostgreSQL DDL 검증", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    it("데코레이터가 있는 컬럼은 DDL에 포함되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Article);

      expect(ddl).toContain('"id"');
      expect(ddl).toContain('"title"');
      expect(ddl).toContain('"content"');
      expect(ddl).toContain('"published"');
      expect(ddl).toContain('"viewCount"');
    });

    it("데코레이터가 없는 속성은 DDL에 포함되지 않아야 함", () => {
      const ddl = gen.generateCreateTableDDL(Article);

      expect(ddl).not.toContain("temporaryNote");
    });
  });
});

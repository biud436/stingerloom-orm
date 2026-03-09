import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import {
  CreateTimestamp,
  CREATE_TIMESTAMP_TOKEN,
} from "../../src/decorators/CreateTimestamp";
import {
  UpdateTimestamp,
  UPDATE_TIMESTAMP_TOKEN,
} from "../../src/decorators/UpdateTimestamp";
import { COLUMN_TOKEN } from "../../src/decorators/Column";

// ─────────────────────────────────────────────────
// Test entity
// ─────────────────────────────────────────────────

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("@CreateTimestamp / @UpdateTimestamp", () => {
  describe("메타데이터 등록", () => {
    it("@CreateTimestamp이 CREATE_TIMESTAMP_TOKEN에 컬럼 이름을 저장해야 함", () => {
      const column = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, Post);
      expect(column).toBe("createdAt");
    });

    it("@UpdateTimestamp이 UPDATE_TIMESTAMP_TOKEN에 컬럼 이름을 저장해야 함", () => {
      const column = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, Post);
      expect(column).toBe("updatedAt");
    });

    it("COLUMN_TOKEN에 datetime 컬럼으로 등록되어야 함", () => {
      const columns = Reflect.getMetadata(COLUMN_TOKEN, Post.prototype) ?? [];
      const columnNames = columns.map((c: any) => c.name);

      expect(columnNames).toContain("createdAt");
      expect(columnNames).toContain("updatedAt");

      const createdAtCol = columns.find((c: any) => c.name === "createdAt");
      expect(createdAtCol.options.type).toBe("datetime");
      expect(createdAtCol.options.nullable).toBe(false);

      const updatedAtCol = columns.find((c: any) => c.name === "updatedAt");
      expect(updatedAtCol.options.type).toBe("datetime");
      expect(updatedAtCol.options.nullable).toBe(false);
    });
  });

  describe("MySQL DDL 생성", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("createdAt 컬럼이 DATETIME NOT NULL로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Post);
      expect(ddl).toMatch(/`createdAt`\s+DATETIME\s+NOT NULL/);
    });

    it("updatedAt 컬럼이 DATETIME NOT NULL로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Post);
      expect(ddl).toMatch(/`updatedAt`\s+DATETIME\s+NOT NULL/);
    });
  });

  describe("PostgreSQL DDL 생성", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    it("createdAt 컬럼이 TIMESTAMP NOT NULL로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Post);
      expect(ddl).toMatch(/"createdAt"\s+TIMESTAMP\s+NOT NULL/);
    });

    it("updatedAt 컬럼이 TIMESTAMP NOT NULL로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Post);
      expect(ddl).toMatch(/"updatedAt"\s+TIMESTAMP\s+NOT NULL/);
    });
  });

  describe("@CreateTimestamp이 없는 엔티티", () => {
    it("CREATE_TIMESTAMP_TOKEN 메타데이터가 없어야 함", () => {
      @Entity()
      class PlainEntity {
        @PrimaryGeneratedColumn()
        id!: number;

        @Column({ type: "varchar", length: 100 })
        name!: string;
      }

      const column = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, PlainEntity);
      expect(column).toBeUndefined();

      const updateCol = Reflect.getMetadata(
        UPDATE_TIMESTAMP_TOKEN,
        PlainEntity,
      );
      expect(updateCol).toBeUndefined();
    });
  });
});

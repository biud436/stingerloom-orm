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
// Test entity: timestamptz 타입 사용
// ─────────────────────────────────────────────────

@Entity()
class Event {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  name!: string;

  @Column({ type: "timestamptz" })
  scheduledAt!: Date;

  @Column({ type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;
}

// @CreateTimestamp / @UpdateTimestamp와 timestamptz 조합
@Entity()
class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  action!: string;

  @Column({ type: "timestamptz" })
  occurredAt!: Date;
}

// ─────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────

describe("timestamptz 컬럼 타입", () => {
  describe("메타데이터 등록", () => {
    it("COLUMN_TOKEN에 timestamptz 타입으로 등록되어야 함", () => {
      const columns = Reflect.getMetadata(COLUMN_TOKEN, Event.prototype) ?? [];
      const scheduledCol = columns.find((c: any) => c.name === "scheduledAt");
      expect(scheduledCol).toBeDefined();
      expect(scheduledCol.options.type).toBe("timestamptz");
    });

    it("nullable timestamptz도 올바르게 등록되어야 함", () => {
      const columns = Reflect.getMetadata(COLUMN_TOKEN, Event.prototype) ?? [];
      const cancelledCol = columns.find((c: any) => c.name === "cancelledAt");
      expect(cancelledCol).toBeDefined();
      expect(cancelledCol.options.type).toBe("timestamptz");
      expect(cancelledCol.options.nullable).toBe(true);
    });
  });

  describe("PostgreSQL DDL", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });

    it("timestamptz 컬럼이 TIMESTAMPTZ로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Event);
      expect(ddl).toMatch(/"scheduledAt"\s+TIMESTAMPTZ\s+NOT NULL/);
    });

    it("nullable timestamptz가 TIMESTAMPTZ NULL로 생성되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Event);
      expect(ddl).toMatch(/"cancelledAt"\s+TIMESTAMPTZ\s+NULL/);
    });
  });

  describe("MySQL DDL (timestamptz → DATETIME fallback)", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });

    it("timestamptz가 MySQL에서 DATETIME으로 매핑되어야 함", () => {
      const ddl = gen.generateCreateTableDDL(Event);
      expect(ddl).toMatch(/`scheduledAt`\s+DATETIME\s+NOT NULL/);
    });
  });

  describe("SQLite castType (timestamptz → TEXT fallback)", () => {
    it("SqliteDriver.castType('timestamptz')가 TEXT를 반환해야 함", async () => {
      const { SqliteDriver } = await import("../../src/dialects/sqlite/SqliteDriver");
      // castType은 prototype에 정의된 순수 함수이므로 인스턴스 없이 호출 가능
      const castType = SqliteDriver.prototype.castType;
      expect(castType("timestamptz")).toBe("TEXT");
    });
  });
});

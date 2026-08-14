/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import {
  inferRelatedPkType,
  findPrimaryKeyType,
} from "../../src/core/generators/RelatedPkTypeResolver";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { RelationColumn } from "../../src/decorators/RelationColumn";

// ─────────────────────────────────────────────────
// SchemaGenerator(CREATE TABLE)와 SchemaDiff(마이그레이션 diff)가 각자
// 들고 있던 findPrimaryKeyType/inferRelatedPkType 축자 복제를 공용 헬퍼로
// 통합 — 한쪽만 고쳐져 DDL과 diff가 서로 다른 FK 타입을 산출하는 부류의
// 회귀(무한 diff 루프)를 계약으로 고정한다.
// ─────────────────────────────────────────────────

@Entity()
class RpkAccount {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: number;

  @Column({ type: "varchar", length: 50 })
  handle!: string;
}

@Entity()
class RpkSession {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => RpkAccount, (a: any) => a.sessions)
  @RelationColumn({ name: "account_id" })
  account!: RpkAccount;
}

@Entity()
class RpkCompositeParent {
  @PrimaryColumn({ type: "uuid" })
  regionId!: string;

  @PrimaryColumn({ type: "int" })
  seq!: number;
}

describe("RelatedPkTypeResolver — DDL과 diff의 단일 FK 타입 소스", () => {
  it("inferRelatedPkType이 대상 PK 타입(bigint)을 추론해야 함", () => {
    expect(inferRelatedPkType(RpkSession, "account")).toBe("bigint");
  });

  it("CREATE TABLE의 FK 컬럼 타입과 diff ADD COLUMN 타입이 일치해야 함", async () => {
    // CREATE TABLE path
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(RpkSession);
    expect(ddl).toContain('"account_id" BIGINT');

    // diff path: DB에 account_id가 없다고 응답 → ADD COLUMN 타입 확인
    const runner = {
      query: jest.fn(() =>
        Promise.resolve([
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
        ]),
      ),
    };
    const diff = await new SchemaDiff().diff([RpkSession], runner, "postgres");
    const fk = diff.addColumns.find((c) => c.columnName === "account_id");
    expect(fk?.columnType).toBe("BIGINT");
  });

  it("복합 PK는 첫 primary 컬럼 타입만 반환 (문서화된 한계)", () => {
    expect(findPrimaryKeyType(RpkCompositeParent)).toBe("uuid");
  });
});

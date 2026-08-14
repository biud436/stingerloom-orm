/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Index } from "../../src/decorators/Indexer";
import { UniqueIndex } from "../../src/decorators/UniqueIndex";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { RelationColumn } from "../../src/decorators/RelationColumn";

// ─────────────────────────────────────────────────
// Test entities — @RelationColumn shadow FK properties (no backing @Column)
// ─────────────────────────────────────────────────

@Entity()
class Workspace {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;
}

// The documented pattern: @RelationColumn declares the FK column, and the
// FK value is exposed through the conventional `{relationProp}Id` shadow
// property. Indexing that shadow property must resolve to the real DB
// column name, not the camelCase property name.
@Entity()
@UniqueIndex(["workspaceId", "slug"])
class Board {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  slug!: string;

  @ManyToOne(() => Workspace, (w: any) => w.boards)
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  @Index()
  workspaceId?: number;
}

@Entity()
class BoardSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => Board)
  @RelationColumn({ name: "board_id" })
  board!: Board;

  @Index()
  boardId?: number;
}

describe("SchemaGenerator — FK shadow property index resolution", () => {
  describe.each(["sqlite", "postgres", "mysql"] as const)(
    "%s dialect",
    (dialect) => {
      const gen = new SchemaGenerator({ dialect });
      const q = dialect === "mysql" ? "`" : '"';

      it("@ManyToOne 섀도우 속성 @Index()가 실제 FK 컬럼명으로 해석되어야 함", () => {
        const indexes = gen.generateCreateIndexDDL(Board);
        expect(indexes).toHaveLength(1);
        // The CREATE TABLE emits "workspace_id" — the index must target it,
        // not the camelCase shadow property name.
        expect(indexes[0]).toContain(`(${q}workspace_id${q})`);
        expect(indexes[0]).not.toContain("workspaceId");
      });

      it("@OneToOne 섀도우 속성 @Index()가 실제 FK 컬럼명으로 해석되어야 함", () => {
        const indexes = gen.generateCreateIndexDDL(BoardSettings);
        expect(indexes).toHaveLength(1);
        expect(indexes[0]).toContain(`(${q}board_id${q})`);
        expect(indexes[0]).not.toContain("boardId");
      });

      it("@UniqueIndex 컬럼 목록의 섀도우 속성도 FK 컬럼명으로 해석되어야 함", () => {
        const uniques = gen.generateUniqueIndexDDL(Board);
        expect(uniques).toHaveLength(1);
        expect(uniques[0]).toContain(`${q}workspace_id${q}`);
        expect(uniques[0]).not.toContain("workspaceId");
      });

      it("인덱스가 가리키는 컬럼이 CREATE TABLE에 실제로 존재해야 함", () => {
        const ddl = gen.generateCreateTableDDL(Board);
        expect(ddl).toContain(`${q}workspace_id${q}`);
      });
    },
  );

  it("같은 속성에 명시적 @Column이 있으면 그 컬럼명이 우선되어야 함", () => {
    @Entity()
    class LegacyOrder {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int", name: "buyer_fk" })
      buyerId!: number;

      @ManyToOne(() => Workspace, (w: any) => w.orders)
      @RelationColumn({ name: "buyer_fk" })
      buyer!: Workspace;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _touch = LegacyOrder;

    const gen = new SchemaGenerator({ dialect: "sqlite" });
    const IndexedLegacyOrder = (() => {
      @Entity()
      class IndexedLegacyOrder {
        @PrimaryGeneratedColumn()
        id!: number;

        @Index()
        @Column({ type: "int", name: "buyer_fk" })
        buyerId!: number;

        @ManyToOne(() => Workspace, (w: any) => w.orders)
        @RelationColumn({ name: "buyer_fk" })
        buyer!: Workspace;
      }
      return IndexedLegacyOrder;
    })();

    const indexes = gen.generateCreateIndexDDL(IndexedLegacyOrder);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toContain('("buyer_fk")');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: which table of an inheritance hierarchy holds a relation's
 * join column.
 *
 * A JOINED root's relation keeps its join column on the root's table, but
 * synchronize also created a copy (with its own FK) on every child table that
 * inherited the relation — a column no write ever filled. A SINGLE_TABLE
 * child's relation had no column at all: only the root's relations reached
 * the shared table, so saving the child failed with `no column named ...`.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  ManyToOne,
  OneToOne,
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "irj_owner" })
class IrjOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "irj_badge" })
class IrjBadge {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
}

// JOINED: the root declares `owner`, one child `editor`, the other nothing.
@Entity({ name: "irj_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class IrjDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @ManyToOne(() => IrjOwner, (o: any) => o.docs)
  @RelationColumn({ name: "owner_id" })
  owner!: IrjOwner | null;
}

@Entity({ name: "irj_review" })
@DiscriminatorValue("review")
class IrjReview extends IrjDoc {
  @Column() reviewer!: string;
  @ManyToOne(() => IrjOwner, (o: any) => o.reviews)
  @RelationColumn({ name: "editor_id" })
  editor!: IrjOwner | null;
}

@Entity({ name: "irj_memo" })
@DiscriminatorValue("memo")
class IrjMemo extends IrjDoc {
  @Column({ nullable: true }) note!: string;
}

// SINGLE_TABLE: each child declares a relation of its own.
@Entity({ name: "irj_pay" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype" })
class IrjPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class IrjCardPayment extends IrjPayment {
  @ManyToOne(() => IrjOwner, (o: any) => o.cards)
  @RelationColumn({ name: "holder_id", nullable: false })
  holder!: IrjOwner;
}

@Entity()
@DiscriminatorValue("gift")
class IrjGiftPayment extends IrjPayment {
  @OneToOne(() => IrjBadge, { joinColumn: "badge_id" } as any)
  badge!: IrjBadge | null;
}

describe("[Integration] SQLite: relation join columns in an inheritance hierarchy", () => {
  let em: EntityManager;

  const columns = async (table: string) =>
    ((await em.query(`PRAGMA table_info("${table}")`)) as any[]).map((c) => ({
      name: c.name,
      notnull: c.notnull,
    }));
  const foreignKeys = async (table: string) =>
    ((await em.query(`PRAGMA foreign_key_list("${table}")`)) as any[])
      .map((f) => `${f.from}->${f.table}.${f.to}`)
      .sort();

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [
          IrjOwner,
          IrjBadge,
          IrjDoc,
          IrjReview,
          IrjMemo,
          IrjPayment,
          IrjCardPayment,
          IrjGiftPayment,
        ],
        synchronize: true,
        logging: false,
      } as any,
      `irj_${Math.random().toString(36).slice(2, 10)}`,
    );
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  describe("JOINED", () => {
    it("keeps the root's join column and its FK on the root's table only", async () => {
      expect((await columns("irj_doc")).map((c) => c.name)).toContain("owner_id");
      expect(await foreignKeys("irj_doc")).toEqual(["owner_id->irj_owner.id"]);
      expect((await columns("irj_memo")).map((c) => c.name).sort()).toEqual(["id", "note"]);
      expect(await foreignKeys("irj_memo")).toEqual(["id->irj_doc.id"]);
    });

    it("puts a child's join column and its FK on the child's table", async () => {
      expect((await columns("irj_review")).map((c) => c.name).sort()).toEqual(
        ["editor_id", "id", "reviewer"],
      );
      expect(await foreignKeys("irj_review")).toEqual(
        ["editor_id->irj_owner.id", "id->irj_doc.id"],
      );
    });
  });

  describe("SINGLE_TABLE", () => {
    it("puts every child's join column and FK on the shared table, nullable", async () => {
      const cols = await columns("irj_pay");
      expect(cols.find((c) => c.name === "holder_id")).toEqual({ name: "holder_id", notnull: 0 });
      expect(cols.find((c) => c.name === "badge_id")).toEqual({ name: "badge_id", notnull: 0 });
      expect(await foreignKeys("irj_pay")).toEqual(
        ["badge_id->irj_badge.id", "holder_id->irj_owner.id"],
      );
    });
  });
});

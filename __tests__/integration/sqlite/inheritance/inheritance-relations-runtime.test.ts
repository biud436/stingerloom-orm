/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: relations of an inheritance hierarchy, written and read.
 *
 * - A subclass that declared a relation of its own lost every relation it
 *   inherited: the relation lookup filed relations under the declaring class
 *   and only fell back to the inherited ones when the subclass had none.
 * - A JOINED child's own join column was written to the root's table, so the
 *   INSERT failed, and a JOINED child read neither table's join-only column,
 *   so `${relation}Id` was missing and `relations` failed on the column.
 * - A polymorphic read of a SINGLE_TABLE or JOINED root with `relations`
 *   came back as root instances (SINGLE_TABLE) or with the relation left as
 *   raw `<relation>_<column>` keys (JOINED).
 * - A read with `relations` built a key-only object for every relation it did
 *   not load whose join column is named `<relation>_...`.
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
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "irr_owner" })
class IrrOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

// JOINED — the root declares `owner`, Review adds `editor`, Memo nothing.
@Entity({ name: "irr_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class IrrDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @ManyToOne(() => IrrOwner, (o: any) => o.docs)
  @RelationColumn({ name: "owner_id" })
  owner!: IrrOwner | null;
}

@Entity({ name: "irr_review" })
@DiscriminatorValue("review")
class IrrReview extends IrrDoc {
  @Column() reviewer!: string;
  @ManyToOne(() => IrrOwner, (o: any) => o.reviews)
  @RelationColumn({ name: "editor_id" })
  editor!: IrrOwner | null;
}

@Entity({ name: "irr_memo" })
@DiscriminatorValue("memo")
class IrrMemo extends IrrDoc {
  @Column({ nullable: true }) note!: string;
}

// SINGLE_TABLE — the root declares `payer`, Card adds `holder`.
@Entity({ name: "irr_pay" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype" })
class IrrPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
  @ManyToOne(() => IrrOwner, (o: any) => o.payments)
  @RelationColumn({ name: "payer_id" })
  payer!: IrrOwner | null;
}

@Entity()
@DiscriminatorValue("card")
class IrrCard extends IrrPayment {
  @ManyToOne(() => IrrOwner, (o: any) => o.cards)
  @RelationColumn({ name: "holder_id" })
  holder!: IrrOwner | null;
}

// TABLE_PER_CLASS — the root declares `owner`, Vehicle adds `driver`.
@Entity({ name: "irr_asset" })
@Inheritance({ strategy: "TABLE_PER_CLASS" })
class IrrAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
  @ManyToOne(() => IrrOwner, (o: any) => o.assets)
  @RelationColumn({ name: "owner_id" })
  owner!: IrrOwner | null;
}

@Entity({ name: "irr_vehicle" })
@DiscriminatorValue("vehicle")
class IrrVehicle extends IrrAsset {
  @ManyToOne(() => IrrOwner, (o: any) => o.vehicles)
  @RelationColumn({ name: "driver_id" })
  driver!: IrrOwner | null;
}

// No hierarchy: two relations whose join columns start with their names.
@Entity({ name: "irr_note" })
class IrrNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() body!: string;
  @ManyToOne(() => IrrOwner, (o: any) => o.notes)
  @RelationColumn({ name: "author_id" })
  author!: IrrOwner | null;
  @ManyToOne(() => IrrOwner, (o: any) => o.checkedNotes)
  @RelationColumn({ name: "checker_id" })
  checker!: IrrOwner | null;
}

describe("[Integration] SQLite: inheritance hierarchy relations at runtime", () => {
  let em: EntityManager;
  let alice: IrrOwner;
  let bob: IrrOwner;

  const rows = (table: string) => em.query(`SELECT * FROM "${table}" ORDER BY id`) as Promise<any[]>;
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [
          IrrOwner,
          IrrDoc,
          IrrReview,
          IrrMemo,
          IrrPayment,
          IrrCard,
          IrrAsset,
          IrrVehicle,
          IrrNote,
        ],
        synchronize: true,
        logging: false,
      } as any,
      `irr_${Math.random().toString(36).slice(2, 10)}`,
    );
    alice = await em.save(IrrOwner, { name: "alice" } as any);
    bob = await em.save(IrrOwner, { name: "bob" } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  describe("JOINED", () => {
    it("writes each join column to the table that holds it", async () => {
      const saved = await em.save(IrrReview, {
        title: "t",
        reviewer: "r",
        owner: alice,
        editor: bob,
      } as any);

      expect(await rows("irr_doc")).toEqual([
        { id: saved.id, title: "t", dtype: "review", owner_id: alice.id },
      ]);
      expect(await rows("irr_review")).toEqual([
        { id: saved.id, reviewer: "r", editor_id: bob.id },
      ]);
      expect(saved).toMatchObject({ ownerId: alice.id, editorId: bob.id });
    });

    it("moves each join column on its own table when the relations change", async () => {
      const saved = await em.save(IrrReview, {
        title: "t",
        reviewer: "r",
        owner: alice,
        editor: bob,
      } as any);
      await em.save(IrrReview, { id: saved.id, owner: bob, editor: alice } as any);

      expect((await rows("irr_doc"))[0].owner_id).toBe(bob.id);
      expect((await rows("irr_review"))[0].editor_id).toBe(alice.id);
    });

    it("reads the child's and the inherited join columns and loads both relations", async () => {
      const saved = await em.save(IrrReview, {
        title: "t",
        reviewer: "r",
        owner: alice,
        editor: bob,
      } as any);

      const [plainRead] = await em.find(IrrReview, {});
      expect(plainRead).toMatchObject({ ownerId: alice.id, editorId: bob.id });

      const loaded = await em.findOne(IrrReview, {
        where: { id: saved.id },
        relations: ["owner", "editor"],
      } as any);
      expect(plain(loaded)).toMatchObject({
        owner: { id: alice.id, name: "alice" },
        editor: { id: bob.id, name: "bob" },
      });

      const byKeys = await em.find(IrrReview, {
        where: { ownerId: alice.id, editorId: bob.id },
      } as any);
      expect(byKeys.map((r) => r.id)).toEqual([saved.id]);
    });

    it("loads an inherited relation on a child that declares none", async () => {
      await em.save(IrrMemo, { title: "m", note: "n", owner: bob } as any);

      const [memo] = await em.find(IrrMemo, { relations: ["owner"] } as any);
      expect(plain(memo)).toMatchObject({
        ownerId: bob.id,
        owner: { id: bob.id, name: "bob" },
      });
    });

  });

  describe("SINGLE_TABLE", () => {
    it("keeps the inherited relation of a child that declares its own", async () => {
      const saved = await em.save(IrrCard, { amount: 5, payer: alice, holder: bob } as any);
      expect(saved).toMatchObject({ payerId: alice.id, holderId: bob.id });

      const [card] = await em.find(IrrCard, { relations: ["payer", "holder"] } as any);
      expect(plain(card)).toMatchObject({
        payer: { id: alice.id, name: "alice" },
        holder: { id: bob.id, name: "bob" },
      });
    });

  });

  describe("TABLE_PER_CLASS", () => {
    it("keeps the inherited relation of a child that declares its own", async () => {
      await em.save(IrrVehicle, { label: "v", owner: alice, driver: bob } as any);

      const [vehicle] = await em.find(IrrVehicle, { relations: ["owner", "driver"] } as any);
      expect(plain(vehicle)).toMatchObject({
        ownerId: alice.id,
        driverId: bob.id,
        owner: { id: alice.id, name: "alice" },
        driver: { id: bob.id, name: "bob" },
      });
    });
  });

});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL / PostgreSQL: an inheritance hierarchy's tables across a
 * synchronize restart, and the relations its subclasses declare.
 *
 * Mirrors the SQLite suites inheritance-synchronize-restart,
 * inheritance-relation-join-columns and inheritance-relations-runtime. What
 * is dialect-specific here: the schema diff reads each table from
 * information_schema, and the relation foreign keys are added with
 * ALTER TABLE rather than inline.
 */
import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "../helpers/driver-config";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  ManyToOne,
  RelationColumn,
} from "../../../src";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const suffix = Date.now().toString().slice(-6);
const TABLES = {
  owner: `irs_owner_${suffix}`,
  stiRoot: `irs_pay_${suffix}`,
  tptRoot: `irs_doc_${suffix}`,
  tptReview: `irs_rev_${suffix}`,
  tptMemo: `irs_memo_${suffix}`,
};

/** Fresh classes for one boot, as a restarted process would declare them. */
function defineEntities() {
  @Entity({ name: TABLES.owner })
  class Owner {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  @Entity({ name: TABLES.stiRoot })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "ptype", type: "varchar", length: 20 })
  class Payment {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "int" }) amount!: number;
    @ManyToOne(() => Owner, (o: any) => o.payments)
    @RelationColumn({ name: "payer_id" })
    payer!: Owner | null;
  }

  @Entity()
  @DiscriminatorValue("card")
  class Card extends Payment {
    @Column({ type: "varchar", length: 20 }) last4!: string;
    @ManyToOne(() => Owner, (o: any) => o.cards)
    @RelationColumn({ name: "holder_id" })
    holder!: Owner | null;
  }

  @Entity({ name: TABLES.tptRoot })
  @Inheritance({ strategy: "JOINED" })
  @DiscriminatorColumn({ name: "dtype", type: "varchar", length: 20 })
  class Doc {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
    @ManyToOne(() => Owner, (o: any) => o.docs)
    @RelationColumn({ name: "owner_id" })
    owner!: Owner | null;
  }

  @Entity({ name: TABLES.tptReview })
  @DiscriminatorValue("review")
  class Review extends Doc {
    @Column({ type: "varchar", length: 40 }) reviewer!: string;
    @ManyToOne(() => Owner, (o: any) => o.reviews)
    @RelationColumn({ name: "editor_id" })
    editor!: Owner | null;
  }

  @Entity({ name: TABLES.tptMemo })
  @DiscriminatorValue("memo")
  class Memo extends Doc {
    @Column({ type: "varchar", length: 40, nullable: true }) note!: string;
  }

  return { Owner, Payment, Card, Doc, Review, Memo };
}

type Entities = ReturnType<typeof defineEntities>;

describe.each(drivers)(
  "[Integration][$label] inheritance relations across a synchronize restart",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult | undefined;
    let E: Entities;

    const boot = async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          E = defineEntities();
          return { entities: Object.values(E) };
        },
      );
      return conn.em as any;
    };

    const shutdown = async () => {
      await conn?.cleanup();
      conn = undefined;
    };

    const columnsOf = async (table: string): Promise<string[]> => {
      const rows = (await conn!.em.query(
        type === "postgres"
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}' AND table_schema = current_schema()`
          : `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
      )) as unknown as Array<{ name: string }>;
      return rows.map((r) => r.name).sort();
    };

    const foreignKeyColumnsOf = async (table: string): Promise<string[]> => {
      const rows = (await conn!.em.query(
        type === "postgres"
          ? `SELECT kcu.column_name AS name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '${table}' AND tc.table_schema = current_schema()`
          : `SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND REFERENCED_TABLE_NAME IS NOT NULL`,
      )) as unknown as Array<{ name: string }>;
      return rows.map((r) => r.name).sort();
    };

    const dropAll = async () => {
      const em = await boot();
      const drop = (t: string) =>
        em.query(
          type === "postgres"
            ? `DROP TABLE IF EXISTS "${t}" CASCADE`
            : `DROP TABLE IF EXISTS \`${t}\``,
        );
      for (const t of [
        TABLES.tptReview,
        TABLES.tptMemo,
        TABLES.tptRoot,
        TABLES.stiRoot,
        TABLES.owner,
      ]) {
        await drop(t);
      }
      await shutdown();
    };

    beforeAll(dropAll, 60000);
    afterAll(async () => {
      await shutdown();
      await dropAll();
    }, 60000);

    it("keeps every table's columns, foreign keys and rows through a restart", async () => {
      let em = await boot();
      const layout = {
        sti: await columnsOf(TABLES.stiRoot),
        doc: await columnsOf(TABLES.tptRoot),
        review: await columnsOf(TABLES.tptReview),
        memo: await columnsOf(TABLES.tptMemo),
        reviewFks: await foreignKeyColumnsOf(TABLES.tptReview),
        memoFks: await foreignKeyColumnsOf(TABLES.tptMemo),
      };
      expect(layout).toEqual({
        sti: ["amount", "holder_id", "id", "last4", "payer_id", "ptype"],
        doc: ["dtype", "id", "owner_id", "title"],
        review: ["editor_id", "id", "reviewer"],
        memo: ["id", "note"],
        reviewFks: ["editor_id", "id"],
        memoFks: ["id"],
      });

      const alice = await em.save(E.Owner, { name: "alice" });
      const bob = await em.save(E.Owner, { name: "bob" });
      await em.save(E.Card, { amount: 5, last4: "4242", payer: alice, holder: bob });
      await em.save(E.Review, { title: "t", reviewer: "r", owner: alice, editor: bob });
      await em.save(E.Memo, { title: "m", note: "n", owner: bob });
      await shutdown();

      em = await boot();
      expect({
        sti: await columnsOf(TABLES.stiRoot),
        doc: await columnsOf(TABLES.tptRoot),
        review: await columnsOf(TABLES.tptReview),
        memo: await columnsOf(TABLES.tptMemo),
        reviewFks: await foreignKeyColumnsOf(TABLES.tptReview),
        memoFks: await foreignKeyColumnsOf(TABLES.tptMemo),
      }).toEqual(layout);

      const [payment] = await em.find(E.Payment, { relations: ["payer"] });
      expect(payment).toBeInstanceOf(E.Card);
      expect(payment).toMatchObject({ last4: "4242" });
      expect(payment.payer).toMatchObject({ name: "alice" });
      const [card] = await em.find(E.Card, { relations: ["payer", "holder"] });
      expect(card).toMatchObject({ payerId: alice.id, holderId: bob.id });
      expect(card.holder).toMatchObject({ name: "bob" });

      const docs = await em.find(E.Doc, { relations: ["owner"], orderBy: { id: "ASC" } });
      expect(docs[0]).toBeInstanceOf(E.Review);
      expect(docs[0]).toMatchObject({ reviewer: "r", editorId: bob.id });
      expect(docs[0].owner).toMatchObject({ name: "alice" });
      expect(docs[1]).toBeInstanceOf(E.Memo);
      expect(docs[1].owner).toMatchObject({ name: "bob" });
    }, 60000);

    it("writes and reads a JOINED child's join columns on their own tables", async () => {
      const em = await boot();
      try {
        const alice = await em.save(E.Owner, { name: "alice" });
        const bob = await em.save(E.Owner, { name: "bob" });
        const saved = await em.save(E.Review, {
          title: "w",
          reviewer: "rw",
          owner: alice,
          editor: bob,
        });
        expect(saved).toMatchObject({ ownerId: alice.id, editorId: bob.id });

        await em.save(E.Review, { id: saved.id, owner: bob, editor: alice });
        const loaded = await em.findOne(E.Review, {
          where: { id: saved.id },
          relations: ["owner", "editor"],
        });
        expect(loaded).toMatchObject({ ownerId: bob.id, editorId: alice.id });
        expect(loaded.owner).toMatchObject({ name: "bob" });
        expect(loaded.editor).toMatchObject({ name: "alice" });

        const byKeys = await em.find(E.Review, {
          where: { ownerId: bob.id, editorId: alice.id },
        });
        expect(byKeys.map((r: any) => r.id)).toEqual([saved.id]);
      } finally {
        await shutdown();
      }
    }, 60000);
  },
);

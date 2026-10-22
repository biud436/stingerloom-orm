/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `em.pipe()` over inheritance hierarchies on a real PostgreSQL / MySQL
 * (MariaDB): a SINGLE_TABLE child reads its own subtype, a JOINED child its
 * inherited columns, and a TABLE_PER_CLASS root every concrete table —
 * keyset pages included, although the tables number their keys
 * independently.
 *
 * SQLite: __tests__/integration/sqlite/raw-pipeline-inheritance.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

describe.each(getTestDrivers())(
  "[Integration] $label: em.pipe() over inheritance hierarchies",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: any;
    let E: Record<string, new () => any>;
    const t = {
      animal: shortName("rpia"),
      doc: shortName("rpid"),
      review: shortName("rpir"),
      pay: shortName("rpip"),
      card: shortName("rpic"),
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.animal })
          @Inheritance({ strategy: "SINGLE_TABLE" })
          @DiscriminatorColumn({ name: "kind" })
          class Animal {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
          }
          @Entity({ name: t.animal })
          @DiscriminatorValue("dog")
          class Dog extends Animal {}
          @Entity({ name: t.animal })
          @DiscriminatorValue("cat")
          class Cat extends Animal {}

          @Entity({ name: t.doc })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "dtype" })
          class Doc {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ name: "doc_title", type: "varchar", length: 40 }) docTitle!: string;
          }
          @Entity({ name: t.review })
          @DiscriminatorValue("review")
          class Review extends Doc {
            @Column({ type: "varchar", length: 40 }) reviewer!: string;
          }

          @Entity({ name: t.pay })
          @Inheritance({ strategy: "TABLE_PER_CLASS" })
          @DiscriminatorColumn({ name: "dtype" })
          class Pay {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) amount!: number;
          }
          @Entity({ name: t.card })
          @DiscriminatorValue("card")
          class Card extends Pay {
            @Column({ name: "card_brand", type: "varchar", length: 20 }) cardBrand!: string;
          }

          E = { Animal, Dog, Cat, Doc, Review, Pay, Card };
          return { entities: Object.values(E) };
        },
      );
      const base: EntityManager = conn.em;
      em = base.extend(rawPipelinePlugin());

      await em.save(E.Dog, { name: "rex" });
      await em.save(E.Dog, { name: "ace" });
      await em.save(E.Cat, { name: "tom" });
      await em.save(E.Review, { docTitle: "spec", reviewer: "ann" });
      await em.save(E.Review, { docTitle: "plan", reviewer: "bob" });
      await em.save(E.Doc, { docTitle: "memo" });
      // Both tables number their keys from 1, so ids repeat across the UNION.
      await em.save(E.Pay, { amount: 1 });
      await em.save(E.Pay, { amount: 2 });
      await em.save(E.Card, { amount: 5, cardBrand: "visa" });
      await em.save(E.Card, { amount: 6, cardBrand: "amex" });
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.animal, t.review, t.doc, t.card, t.pay]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const amounts = (rows: any[]) => rows.map((r) => Number(r.amount)).sort((a, b) => a - b);

    it("reads and counts only a SINGLE_TABLE child's own subtype", async () => {
      const dogs = await em.pipe(E.Dog).collect();
      expect(dogs.map((r: any) => r.name).sort()).toEqual(["ace", "rex"]);
      expect(Number(await em.pipe(E.Dog).count())).toBe(2);
      expect(await drain(em.pipe(E.Cat).binary())).toHaveLength(1);
    });

    it("returns and filters by a JOINED child's inherited columns", async () => {
      const rows = await em.pipe(E.Review, { orderBy: { id: "ASC" } }).collect();
      expect(rows.map((r: any) => [r.doc_title, r.reviewer])).toEqual([
        ["spec", "ann"],
        ["plan", "bob"],
      ]);
      expect(
        (await em.pipe(E.Review, { where: { docTitle: "plan" } }).collect()).map((r: any) => r.reviewer),
      ).toEqual(["bob"]);
      const keyset = await drain(
        em.pipe(E.Review, { orderBy: { docTitle: "DESC" }, keyset: true, batchSize: 1 }).raw(),
      );
      expect(keyset.map((r: any) => r.doc_title)).toEqual(["spec", "plan"]);
    });

    it("reads every concrete table through a TABLE_PER_CLASS root", async () => {
      expect(amounts(await em.pipe(E.Pay).collect())).toEqual([1, 2, 5, 6]);
      expect(Number(await em.pipe(E.Pay).count())).toBe(4);
      expect(amounts(await em.pipe(E.Pay, { where: { cardBrand: "visa" } }).collect())).toEqual([5]);
    });

    it("keyset-pages a TABLE_PER_CLASS root although ids repeat across tables", async () => {
      for (const dir of ["ASC", "DESC"] as const) {
        const rows = await drain(
          em.pipe(E.Pay, { orderBy: { id: dir }, keyset: true, batchSize: 1 }).raw(),
        );
        expect(amounts(rows)).toEqual([1, 2, 5, 6]);
        const binary = await drain(
          em.pipe(E.Pay, { orderBy: { id: dir }, keyset: true, batchSize: 3 }).binary(),
        );
        expect(amounts(binary)).toEqual([1, 2, 5, 6]);
      }
    });
  },
);

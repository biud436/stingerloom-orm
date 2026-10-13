/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Write outcomes on a real PostgreSQL / MySQL (MariaDB):
 * - a criteria write's after-event fires only when the statement reported a
 *   row, with that count as `affected` — including MySQL's value-identical
 *   UPDATE, which the driver reports as matched;
 * - a rolled-back save puts back the key and stamps it wrote on the caller's
 *   object, whether the key came from RETURNING or from the insert id.
 *
 * SQLite: __tests__/integration/sqlite/zero-row-write-events.test.ts and
 * __tests__/integration/sqlite/rollback-restores-input.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Version,
  CreateTimestamp,
  DeletedAt,
  TransactionPropagation,
} from "../../src";

describe.each(getTestDrivers())(
  "[Integration] $label: after-events and caller objects follow the write's outcome",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Doc: new () => any;
    let Token: new () => any;
    const suffix = String(Date.now()).slice(-7);
    const docTable = `woc_docs_${suffix}`;
    const tokenTable = `woc_tokens_${suffix}`;
    let afterEvents: { event: string; affected: number | undefined }[] = [];
    const record = (event: string) => (payload: any) => {
      afterEvents.push({ event, affected: payload.affected });
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: docTable })
          class WocDoc {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @Version() version!: number;
            @CreateTimestamp() createdAt!: Date;
            @DeletedAt() deletedAt!: Date | null;
          }
          @Entity({ name: tokenTable })
          class WocToken {
            @PrimaryGeneratedColumn("uuid") id!: string;
            @Column({ type: "varchar", length: 40 }) label!: string;
          }
          Doc = WocDoc;
          Token = WocToken;
          return { entities: [WocDoc, WocToken] };
        },
      );
      em = conn.em;
      em.on("afterDelete", record("afterDelete"));
      em.on("afterUpdate", record("afterUpdate"));
      em.on("afterSoftDelete", record("afterSoftDelete"));
      em.on("afterRestore", record("afterRestore"));
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${qi(type, docTable)}`);
      await rawQuery(`DELETE FROM ${qi(type, tokenTable)}`);
      afterEvents = [];
    });

    afterAll(async () => {
      for (const table of [docTable, tokenTable]) {
        try {
          await dropTestTable(table);
        } catch {
          // ignore
        }
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const rolledBack = async (work: (tx: EntityManager) => Promise<unknown>) => {
      await expect(
        em.transaction(async (tx) => {
          await work(tx);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
    };

    it("fires no after-event for criteria writes that match no row", async () => {
      const missing = 999_999;

      await em.delete(Doc, { id: missing });
      await em.updateMany(Doc, { title: "b" }, { where: { id: missing } });
      await em.softDelete(Doc, { id: missing });
      await em.restore(Doc, { id: missing });

      expect(afterEvents).toEqual([]);
    });

    it("reports the matched rows, counting an UPDATE that changes no value", async () => {
      const doc = await em.save(Doc, { title: "same" });
      afterEvents = [];

      await expect(
        em.updateMany(Doc, { title: "same" }, { where: { id: doc.id } }),
      ).resolves.toEqual({ affected: 1 });
      await em.softDelete(Doc, { id: doc.id });
      await em.restore(Doc, { id: doc.id });
      await em.delete(Doc, { id: doc.id });

      expect(afterEvents).toEqual([
        { event: "afterUpdate", affected: 1 },
        { event: "afterSoftDelete", affected: 1 },
        { event: "afterRestore", affected: 1 },
        { event: "afterDelete", affected: 1 },
      ]);
    });

    it("removes the generated key from a rolled-back save so the object saves again", async () => {
      const input: any = { title: "draft" };

      await rolledBack((tx) => tx.save(Doc, input));

      expect(input).toEqual({ title: "draft" });
      await expect(em.save(Doc, input)).resolves.toMatchObject({ title: "draft", version: 1 });
      expect(await em.count(Doc)).toBe(1);
    });

    it("removes a uuid key and the stamps a rolled-back saveMany wrote", async () => {
      const token: any = { label: "t" };
      const batch: any[] = [{ title: "a" }, { title: "b" }];

      await rolledBack(async (tx) => {
        await tx.save(Token, token);
        await tx.saveMany(Doc, batch);
      });

      expect(token).toEqual({ label: "t" });
      expect(batch).toEqual([{ title: "a" }, { title: "b" }]);
      await em.save(Token, token);
      await em.saveMany(Doc, batch);
      expect(await em.count(Token)).toBe(1);
      expect(await em.count(Doc)).toBe(2);
    });

    it("restores only what a NESTED savepoint rolled back", async () => {
      const kept: any = { title: "kept" };
      const undone: any = { title: "undone" };

      await em.transaction(async (tx) => {
        await tx.save(Doc, kept);
        await expect(
          tx.transaction(
            async (inner) => {
              await inner.save(Doc, undone);
              throw new Error("inner abort");
            },
            { propagation: TransactionPropagation.NESTED },
          ),
        ).rejects.toThrow("inner abort");
      });

      expect(kept.id).toEqual(expect.anything());
      expect(undone).toEqual({ title: "undone" });
      expect(await em.count(Doc)).toBe(1);
    });
  },
);

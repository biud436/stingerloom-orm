/**
 * Unique and foreign key violations on a real PostgreSQL / MySQL (MariaDB)
 * fail with UniqueConstraintViolationError / ForeignKeyViolationError, the
 * driver's error kept as `cause`, and carry what the server reports about
 * the constraint. Other driver errors still arrive as the driver threw them.
 *
 * SQLite: __tests__/integration/sqlite/constraint-violation-errors.test.ts
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
  ManyToOne,
  RelationColumn,
  UniqueIndex,
  OrmError,
  OrmErrorCode,
  UniqueConstraintViolationError,
  ForeignKeyViolationError,
  Transactional,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

describe.each(getTestDrivers())(
  "[Integration] $label: constraint violation errors",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    /** MariaDB and MySQL before 8.0.19 name the key without its table. */
    let keyNamesTable = true;
    const t = { account: shortName("cva"), post: shortName("cvp") };
    const uqEmail = `uq_${t.account}_email`;
    const uqHandle = `uq_${t.account}_handle`;

    const countOf = async (table: string): Promise<number> =>
      Number(rowsOf(await rawQuery(`SELECT COUNT(*) AS n FROM ${qi(type, table)}`))[0].n);

    const account = (email: string, handle = email, org = "acme") => ({ email, org, handle });

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.account })
          @UniqueIndex(["email"], uqEmail)
          @UniqueIndex(["org", "handle"], uqHandle)
          class Account {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 80 }) email!: string;
            @Column({ type: "varchar", length: 40 }) org!: string;
            @Column({ type: "varchar", length: 40 }) handle!: string;
          }

          @Entity({ name: t.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 80 }) title!: string;
            @ManyToOne(() => Account, () => undefined)
            @RelationColumn({ name: "account_id", nullable: true })
            account!: any;
          }

          E = { Account, Post };
          return { entities: Object.values(E) };
        },
      );
      em = conn.em;
      if (type === "mysql") {
        const version = String(rowsOf(await rawQuery("SELECT VERSION() AS v"))[0].v);
        keyNamesTable = !/mariadb/i.test(version);
      }
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${qi(type, t.post)}`);
      await rawQuery(`DELETE FROM ${qi(type, t.account)}`);
    });

    afterAll(async () => {
      try {
        await dropTestTable(t.post);
        await dropTestTable(t.account);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("fails save() of a duplicate value with UniqueConstraintViolationError", async () => {
      await em.save(E.Account, account("a@x.io", "a"));

      const error = await failure(() => em.save(E.Account, account("a@x.io", "b")));

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error).toBeInstanceOf(OrmError);
      const e = error as UniqueConstraintViolationError;
      expect(e.code).toBe(OrmErrorCode.UNIQUE_VIOLATION);
      expect(e.message).toBe((e.cause as Error).message);
      expect(e.constraint).toBe(uqEmail);
      if (type === "postgres") {
        expect(e.table).toBe(t.account);
        expect(e.columns).toEqual(["email"]);
        expect((e.cause as { code?: string }).code).toBe("23505");
      } else {
        expect(e.table).toBe(keyNamesTable ? t.account : undefined);
        expect(e.columns).toBeUndefined();
        expect((e.cause as { errno?: number }).errno).toBe(1062);
      }
      // The stack reaches back to the caller, as for the ORM's other errors.
      expect(e.stack).toContain("constraint-violation-errors.test");
      expect(await countOf(t.account)).toBe(1);
    });

    it("names a composite unique index, and its columns on PostgreSQL", async () => {
      await em.save(E.Account, account("a@x.io", "same"));

      const error = await failure(() => em.save(E.Account, account("b@x.io", "same")));

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      const e = error as UniqueConstraintViolationError;
      expect(e.constraint).toBe(uqHandle);
      expect(e.columns).toEqual(type === "postgres" ? ["org", "handle"] : undefined);
    });

    it("reports a duplicate primary key", async () => {
      const first = await em.save(E.Account, account("a@x.io"));

      const error = await failure(() =>
        em.insertMany(E.Account, [{ id: first.id, ...account("b@x.io") }]),
      );

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      const e = error as UniqueConstraintViolationError;
      if (type === "postgres") {
        expect(e.columns).toEqual(["id"]);
      } else {
        expect(e.constraint).toBe("PRIMARY");
      }
    });

    it("fails insertMany, upsert and raw SQL the same way, inside a transaction too", async () => {
      await em.save(E.Account, account("a@x.io", "a"));

      const attempts: Array<() => Promise<unknown>> = [
        () => em.insertMany(E.Account, [account("a@x.io", "b")]),
        // MySQL's ON DUPLICATE KEY UPDATE takes any unique key as the
        // conflict, so there the email collision updates the row instead.
        ...(type === "postgres"
          ? [() => em.upsert(E.Account, account("a@x.io", "c"), ["org", "handle"])]
          : []),
        () =>
          em.query(
            `INSERT INTO ${qi(type, t.account)} (${qi(type, "email")}, ${qi(type, "org")}, ${qi(type, "handle")}) VALUES ('a@x.io', 'acme', 'd')`,
          ),
        () =>
          em.transaction(async (tx) => {
            await tx.save(E.Account, account("b@x.io", "e"));
            await tx.save(E.Account, account("a@x.io", "f"));
          }),
      ];
      for (const attempt of attempts) {
        expect(await failure(attempt)).toBeInstanceOf(UniqueConstraintViolationError);
      }
      expect(await countOf(t.account)).toBe(1);
    });

    it("fails a row that points at a missing parent with ForeignKeyViolationError", async () => {
      const ghost = Object.assign(new E.Account(), { id: 999999 });

      const error = await failure(() => em.save(E.Post, { title: "p", account: ghost }));

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      const e = error as ForeignKeyViolationError;
      expect(e.code).toBe(OrmErrorCode.FK_VIOLATION);
      expect(e.table).toBe(t.post);
      expect(typeof e.constraint).toBe("string");
      expect(e.constraint!.length).toBeGreaterThan(0);
      if (type === "postgres") {
        expect((e.cause as { code?: string }).code).toBe("23503");
      } else {
        expect((e.cause as { errno?: number }).errno).toBe(1452);
      }
      expect(e.stack).toContain("constraint-violation-errors.test");
      expect(await countOf(t.post)).toBe(0);
    });

    it("fails delete() of a parent row that is still referenced, naming the referencing table", async () => {
      const owner = await em.save(E.Account, account("a@x.io"));
      await em.save(E.Post, { title: "p", account: owner });

      const error = await failure(() => em.delete(E.Account, { id: owner.id }));

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect((error as ForeignKeyViolationError).table).toBe(t.post);
      if (type === "mysql") {
        expect(((error as ForeignKeyViolationError).cause as { errno?: number }).errno).toBe(1451);
      }
      expect(await countOf(t.account)).toBe(1);
    });

    it("leaves other driver errors as the driver threw them", async () => {
      const error = await failure(() =>
        em.query(
          `INSERT INTO ${qi(type, t.account)} (${qi(type, "email")}, ${qi(type, "org")}) VALUES ('a@x.io', 'acme')`,
        ),
      );

      expect(error).not.toBeInstanceOf(OrmError);
      if (type === "postgres") {
        expect((error as { code?: string }).code).toBe("23502");
      } else {
        expect((error as { errno?: number }).errno).toBe(1364);
      }
    });

    if (type === "postgres") {
      describe("a deferred unique constraint that fails at COMMIT", () => {
        const deferred = `${t.account}_deferred`;

        class Signup {
          @Transactional()
          async twoWithOneHandle(): Promise<void> {
            await em.save(E.Account, account("a@x.io", "same", "acme"));
            await em.save(E.Account, account("b@x.io", "same", "globex"));
          }
        }

        beforeAll(async () => {
          await rawQuery(
            `ALTER TABLE ${qi(type, t.account)} ADD CONSTRAINT ${qi(type, deferred)} UNIQUE (${qi(type, "handle")}) DEFERRABLE INITIALLY DEFERRED`,
          );
        });

        afterAll(async () => {
          await rawQuery(
            `ALTER TABLE ${qi(type, t.account)} DROP CONSTRAINT IF EXISTS ${qi(type, deferred)}`,
          );
        });

        it("fails em.transaction() with the COMMIT's error, not a failed rollback", async () => {
          const error = await failure(() =>
            em.transaction(async (tx) => {
              await tx.save(E.Account, account("a@x.io", "same", "acme"));
              await tx.save(E.Account, account("b@x.io", "same", "globex"));
            }),
          );

          expect(error).toBeInstanceOf(UniqueConstraintViolationError);
          expect((error as UniqueConstraintViolationError).constraint).toBe(deferred);
          expect(await countOf(t.account)).toBe(0);
        });

        it("fails a @Transactional method with the COMMIT's error", async () => {
          const error = await failure(() => new Signup().twoWithOneHandle());

          expect(error).toBeInstanceOf(UniqueConstraintViolationError);
          expect((error as UniqueConstraintViolationError).constraint).toBe(deferred);
          expect(await countOf(t.account)).toBe(0);
        });
      });
    }
  },
);

/**
 * A statement that breaks a unique key or a foreign key fails with the
 * ORM's UniqueConstraintViolationError / ForeignKeyViolationError
 * (codes ORM_UNIQUE_VIOLATION / ORM_FK_VIOLATION), the driver's error kept
 * as `cause`. Every other driver error still arrives as the driver threw it.
 *
 * Real PostgreSQL / MySQL: __tests__/integration/constraint-violation-errors.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { UniqueIndex } from "../../../src/decorators/UniqueIndex";
import { Relation } from "../../../src/types/Relation";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import { UniqueConstraintViolationError } from "../../../src/errors/UniqueConstraintViolationError";
import { ForeignKeyViolationError } from "../../../src/errors/ForeignKeyViolationError";
import { bufferPlugin } from "../../../src/core/plugin/buffer";

@Entity({ name: "cv_accounts" })
@UniqueIndex(["email"], "uq_cv_accounts_email")
@UniqueIndex(["org", "handle"], "uq_cv_accounts_org_handle")
class CvAccount {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 80 }) email!: string;
  @Column({ type: "varchar", length: 40 }) org!: string;
  @Column({ type: "varchar", length: 40 }) handle!: string;
}

@Entity({ name: "cv_posts" })
class CvPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 80 }) title!: string;
  @ManyToOne(() => CvAccount, () => undefined)
  @RelationColumn({ name: "account_id", nullable: true })
  account!: Relation<CvAccount> | null;
}

async function register(extra: Record<string, unknown> = {}) {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: [CvAccount, CvPost],
      synchronize: true,
      logging: false,
      ...extra,
    } as any,
    `cv_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const countOf = async (em: EntityManager, table: string): Promise<number> => {
  const rows = (await em.query(`SELECT COUNT(*) AS n FROM "${table}"`)) as Array<{ n: number }>;
  return Number(rows[0].n);
};

describe("[Integration] SQLite: constraint violation errors", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = await register();
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const account = (email: string, handle = email) => ({ email, org: "acme", handle });

  describe("unique key", () => {
    it("fails save() of a duplicate value with UniqueConstraintViolationError", async () => {
      await em.save(CvAccount, account("a@x.io", "a"));

      const error = await failure(() => em.save(CvAccount, account("a@x.io", "b")));

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(error).toBeInstanceOf(OrmError);
      const e = error as UniqueConstraintViolationError;
      expect(e.code).toBe(OrmErrorCode.UNIQUE_VIOLATION);
      expect(e.name).toBe("UniqueConstraintViolationError");
      expect(e.message).toBe("UNIQUE constraint failed: cv_accounts.email");
      expect(e.suggestion).toBeNull();
      expect(e.table).toBe("cv_accounts");
      expect(e.columns).toEqual(["email"]);
      expect(e.constraint).toBeUndefined();
      expect((e.cause as { code?: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE");
      // The stack reaches back to the caller, as for the ORM's other errors.
      expect(e.stack).toContain("constraint-violation-errors.test");
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });

    it("names every column of a composite unique index", async () => {
      await em.save(CvAccount, account("a@x.io", "same"));

      const error = await failure(() => em.save(CvAccount, account("b@x.io", "same")));

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect((error as UniqueConstraintViolationError).columns).toEqual(["org", "handle"]);
    });

    it("reports a duplicate primary key the same way", async () => {
      const first = await em.save(CvAccount, account("a@x.io"));

      const error = await failure(() =>
        em.insertMany(CvAccount, [{ id: first.id, ...account("b@x.io") }]),
      );

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      const e = error as UniqueConstraintViolationError;
      expect(e.columns).toEqual(["id"]);
      expect((e.cause as { code?: string }).code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });

    it("names the index of a unique index over an expression", async () => {
      await em.query(`CREATE UNIQUE INDEX "uq_cv_lower_email" ON "cv_accounts" (lower("email"))`);
      await em.save(CvAccount, account("a@x.io", "a"));

      const error = await failure(() => em.save(CvAccount, account("A@X.IO", "b")));

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      const e = error as UniqueConstraintViolationError;
      expect(e.constraint).toBe("uq_cv_lower_email");
      expect(e.columns).toBeUndefined();
    });

    it("fails every write path: insertMany, saveMany, upsert, the insert builder and raw SQL", async () => {
      await em.save(CvAccount, account("a@x.io", "a"));

      const attempts: Array<() => Promise<unknown>> = [
        () => em.insertMany(CvAccount, [account("a@x.io", "b")]),
        () => em.saveMany(CvAccount, [account("a@x.io", "c")]),
        () => em.upsert(CvAccount, account("a@x.io", "d"), ["org", "handle"]),
        () => em.createInsertBuilder(CvAccount).values([account("a@x.io", "e")]).execute(),
        () =>
          em.query(
            `INSERT INTO "cv_accounts" ("email", "org", "handle") VALUES ('a@x.io', 'acme', 'f')`,
          ),
      ];
      for (const attempt of attempts) {
        expect(await failure(attempt)).toBeInstanceOf(UniqueConstraintViolationError);
      }
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });

    it("rolls the transaction back and rethrows the error unchanged", async () => {
      await em.save(CvAccount, account("a@x.io", "a"));

      const error = await failure(() =>
        em.transaction(async (tx) => {
          await tx.save(CvAccount, account("b@x.io", "b"));
          await tx.save(CvAccount, account("a@x.io", "c"));
        }),
      );

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });

    it("fails a write buffer flush with the same error", async () => {
      await em.save(CvAccount, account("a@x.io", "a"));
      em.extend(bufferPlugin());
      const buffer = em.buffer();
      buffer.persist(Object.assign(new CvAccount(), account("a@x.io", "b")));

      const error = await failure(() => buffer.flush());

      expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });
  });

  describe("foreign key", () => {
    it("fails a row that points at a missing parent with ForeignKeyViolationError", async () => {
      const error = await failure(() =>
        em.query(`INSERT INTO "cv_posts" ("title", "account_id") VALUES ('p', 999)`),
      );

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(error).toBeInstanceOf(OrmError);
      const e = error as ForeignKeyViolationError;
      expect(e.code).toBe(OrmErrorCode.FK_VIOLATION);
      expect(e.name).toBe("ForeignKeyViolationError");
      expect(e.message).toBe("FOREIGN KEY constraint failed");
      expect(e.constraint).toBeUndefined();
      expect(e.table).toBeUndefined();
      expect((e.cause as { code?: string }).code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
    });

    it("fails save() of a relation to a parent that does not exist", async () => {
      const ghost = Object.assign(new CvAccount(), { id: 999 });

      const error = await failure(() => em.save(CvPost, { title: "p", account: ghost }));

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(await countOf(em, "cv_posts")).toBe(0);
    });

    it("fails delete() of a parent row that is still referenced", async () => {
      const owner = await em.save(CvAccount, account("a@x.io"));
      await em.save(CvPost, { title: "p", account: owner });

      const error = await failure(() => em.delete(CvAccount, { id: owner.id }));

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });

    it("reports a deferred foreign key that fails at COMMIT", async () => {
      const error = await failure(() =>
        em.transaction(async (tx) => {
          await tx.query(`PRAGMA defer_foreign_keys = ON`);
          await tx.query(`INSERT INTO "cv_posts" ("title", "account_id") VALUES ('p', 999)`);
        }),
      );

      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect(await countOf(em, "cv_posts")).toBe(0);
      // The connection is usable afterwards.
      await em.save(CvAccount, account("a@x.io"));
      expect(await countOf(em, "cv_accounts")).toBe(1);
    });
  });

  describe("other driver errors", () => {
    it("still arrive as the driver threw them", async () => {
      const notNull = await failure(() =>
        em.query(`INSERT INTO "cv_accounts" ("email", "org") VALUES ('a@x.io', 'acme')`),
      );
      expect(notNull).not.toBeInstanceOf(OrmError);
      expect((notNull as { code?: string }).code).toBe("SQLITE_CONSTRAINT_NOTNULL");

      const syntax = await failure(() => em.query(`SELEC 1`));
      expect(syntax).not.toBeInstanceOf(OrmError);
      expect((syntax as { code?: string }).code).toBe("SQLITE_ERROR");
    });
  });
});

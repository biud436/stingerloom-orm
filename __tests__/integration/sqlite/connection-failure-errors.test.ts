/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Connection failures reach the caller as OrmErrors that say what failed.
 *
 * A query before register() used to throw a codeless `Error`-named
 * `DatabaseConnectionFailedError` with the real `ORM_NOT_CONNECTED` error
 * buried in its cause, and the driver error behind a failed connection or
 * DDL statement survived only as text in the message.
 */
import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Column, Entity, PrimaryGeneratedColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseNotConnectedError } from "../../../src/errors/DatabaseNotConnectedError";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "cfe_notes" })
class CfeNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() body!: string;
}

const rejectionOf = async (work: () => Promise<unknown>): Promise<any> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
};

describe("[SQLite] connection failure errors", () => {
  const open: EntityManager[] = [];
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cfe-"));
  });

  afterEach(async () => {
    for (const em of open.splice(0)) await em.propagateShutdown();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const register = async (options: Record<string, unknown>) => {
    const em = new EntityManager();
    open.push(em);
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: [CfeNote],
      synchronize: true,
      logging: false,
      ...options,
    } as any);
    return em;
  };

  it.each([
    ["find()", (em: EntityManager) => em.find(CfeNote)],
    ["save()", (em: EntityManager) => em.save(CfeNote, { body: "a" })],
    ["query()", (em: EntityManager) => em.query("SELECT 1")],
  ])("throws ORM_NOT_CONNECTED as it is from %s before register()", async (_label, work) => {
    const error = await rejectionOf(() => work(new EntityManager()));

    expect(error).toBeInstanceOf(DatabaseNotConnectedError);
    expect(error).toMatchObject({
      name: "DatabaseNotConnectedError",
      code: OrmErrorCode.NOT_CONNECTED,
    });
    expect(error.message.match(/Suggestion:/g)).toHaveLength(1);
  });

  it("keeps the driver error when the database file cannot be opened", async () => {
    const error = await rejectionOf(() =>
      register({ database: join(dir, "no-such-dir", "app.sqlite") }),
    );

    expect(error).toBeInstanceOf(OrmError);
    expect(error.code).toBe(OrmErrorCode.CONNECTION_FAILED);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain((error.cause as Error).message);
  });

  it("keeps the DDL error when synchronize fails with continueOnError off", async () => {
    const database = join(dir, "ddl.sqlite");
    const first = await register({ database, entities: [], synchronize: false });
    // Tables and indexes share one namespace: CREATE TABLE cfe_notes fails.
    await first.query(`CREATE TABLE "cfe_other" ("id" INTEGER)`);
    await first.query(`CREATE INDEX "cfe_notes" ON "cfe_other" ("id")`);
    await first.propagateShutdown();
    open.splice(open.indexOf(first), 1);

    const error = await rejectionOf(() =>
      register({ database, synchronize: { mode: true, continueOnError: false } }),
    );

    expect(error.code).toBe(OrmErrorCode.SCHEMA_SYNC_FAILED);
    expect(error.cause).toMatchObject({ code: "SQLITE_ERROR" });
    expect(error.message).toContain((error.cause as Error).message);
  });
});

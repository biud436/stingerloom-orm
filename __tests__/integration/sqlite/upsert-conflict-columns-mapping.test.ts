/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The conflict target of `upsert()` / `insertIgnore()` / `batchUpsert()` and
 * of `createInsertBuilder().onConflict()` takes property keys, mapped through
 * the NamingStrategy as the payload's keys are, or the DB column names.
 *
 * The upsert family wrapped each `conflictColumns` entry verbatim, so the
 * property name of a column whose DB name differs (`userEmail` for
 * `user_email`) and any typo reached the database as an unknown column and
 * came back as a raw driver error. The builder mapped `@Column` properties
 * but not FK shadow properties. An unknown name now throws
 * `InvalidQueryError` before any SQL runs.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "ucc_account" })
@UniqueIndex(["userEmail"])
class UccAccount {
  @PrimaryGeneratedColumn() id!: number;
  @Column() userEmail!: string;
  @Column({ type: "int", default: 0 }) loginCount!: number;
}

@Entity({ name: "ucc_member" })
class UccMember {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

/** Join columns no `@Column` declares, unique per (member, day). */
@Entity({ name: "ucc_visit" })
@UniqueIndex(["member_id", "day"])
class UccVisit {
  @PrimaryGeneratedColumn() id!: number;
  @Column() day!: string;
  @Column({ type: "int", default: 1 }) hits!: number;

  @ManyToOne(() => UccMember, () => undefined)
  @RelationColumn({ name: "member_id" })
  member!: UccMember;
}

async function makeEm(entities: any[], opts: Record<string, any> = {}): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities,
      synchronize: true,
      logging: false,
      ...opts,
    },
    `ucc_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rawRows(em: EntityManager, sqlText: string): Promise<any[]> {
  const result: any = await em.getDriver()!.executeRaw(sqlText);
  return Array.isArray(result) ? result : (result.results ?? result.rows ?? []);
}

async function errorOf(fn: () => unknown | Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function expectUnknownConflictColumn(error: any, name: string, clause: string, suggestion: string): void {
  expect(error).toBeInstanceOf(InvalidQueryError);
  expect(error.code).toBe(OrmErrorCode.INVALID_QUERY);
  expect(error.message).toContain(`Unknown column "${name}" in "${clause}"`);
  expect(error.message).toContain(`Did you mean "${suggestion}"?`);
}

describe("[Integration] SQLite: conflict columns under SnakeNamingStrategy", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = await makeEm([UccAccount], { namingStrategy: new SnakeNamingStrategy() });
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const accounts = () =>
    rawRows(em, `SELECT user_email, login_count FROM ucc_account ORDER BY id`);

  it("upsert() maps a property name to its column", async () => {
    await em.upsert(UccAccount, { userEmail: "a@x.com", loginCount: 1 }, ["userEmail"]);
    await em.upsert(UccAccount, { userEmail: "a@x.com", loginCount: 2 }, ["userEmail"]);

    expect(await accounts()).toEqual([{ user_email: "a@x.com", login_count: 2 }]);
  });

  it("upsert() still takes the DB column name", async () => {
    await em.upsert(UccAccount, { userEmail: "a@x.com", loginCount: 1 }, ["user_email"]);
    await em.upsert(UccAccount, { userEmail: "a@x.com", loginCount: 5 }, ["user_email"]);

    expect(await accounts()).toEqual([{ user_email: "a@x.com", login_count: 5 }]);
  });

  it("batchUpsert() and insertIgnore() map a property name to its column", async () => {
    await em.batchUpsert(
      UccAccount,
      [
        { userEmail: "a@x.com", loginCount: 1 },
        { userEmail: "b@x.com", loginCount: 1 },
      ],
      ["userEmail"],
    );
    await em.batchUpsert(UccAccount, [{ userEmail: "a@x.com", loginCount: 3 }], ["userEmail"]);
    const ignored = await em.insertIgnore(UccAccount, { userEmail: "b@x.com", loginCount: 9 }, ["userEmail"]);

    expect(ignored.affected).toBe(0);
    expect(await accounts()).toEqual([
      { user_email: "a@x.com", login_count: 3 },
      { user_email: "b@x.com", login_count: 1 },
    ]);
  });

  it("rejects an unknown name before any SQL runs", async () => {
    const upsertError = await errorOf(() =>
      em.upsert(UccAccount, { userEmail: "a@x.com", loginCount: 1 }, ["userEmial"]),
    );
    expectUnknownConflictColumn(upsertError, "userEmial", "conflictColumns", "userEmail");

    const batchError = await errorOf(() =>
      em.batchUpsert(UccAccount, [{ userEmail: "a@x.com" }], ["userEmial"]),
    );
    expectUnknownConflictColumn(batchError, "userEmial", "conflictColumns", "userEmail");

    const ignoreError = await errorOf(() =>
      em.insertIgnore(UccAccount, { userEmail: "a@x.com" }, ["userEmial"]),
    );
    expectUnknownConflictColumn(ignoreError, "userEmial", "conflictColumns", "userEmail");

    const repositoryError = await errorOf(() =>
      em.getRepository(UccAccount).upsert({ userEmail: "a@x.com" }, ["userEmial"]),
    );
    expectUnknownConflictColumn(repositoryError, "userEmial", "conflictColumns", "userEmail");

    expect(await accounts()).toEqual([]);
  });

  it("createInsertBuilder().onConflict() rejects an unknown name", async () => {
    const error = await errorOf(() =>
      em
        .createInsertBuilder(UccAccount)
        .values({ userEmail: "a@x.com", loginCount: 1 })
        .onConflict(["userEmial" as any])
        .doNothing()
        .execute(),
    );
    expectUnknownConflictColumn(error, "userEmial", "onConflict", "userEmail");
    expect(await accounts()).toEqual([]);
  });
});

describe("[Integration] SQLite: conflict columns over a foreign key", () => {
  let em: EntityManager;
  let member: UccMember;

  beforeEach(async () => {
    em = await makeEm([UccMember, UccVisit]);
    member = await em.save(UccMember, { name: "m1" });
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const visits = () => rawRows(em, `SELECT member_id, day, hits FROM ucc_visit ORDER BY id`);

  it("upsert() maps an FK shadow property to its join column", async () => {
    await em.upsert(UccVisit, { member, day: "mon", hits: 1 }, ["memberId", "day"]);
    await em.upsert(UccVisit, { member, day: "mon", hits: 4 }, ["memberId", "day"]);

    expect(await visits()).toEqual([{ member_id: member.id, day: "mon", hits: 4 }]);
  });

  it("upsert() still takes the join column name", async () => {
    await em.upsert(UccVisit, { member, day: "mon", hits: 1 }, ["member_id", "day"]);
    await em.upsert(UccVisit, { member, day: "mon", hits: 2 }, ["member_id", "day"]);

    expect(await visits()).toEqual([{ member_id: member.id, day: "mon", hits: 2 }]);
  });

  it("createInsertBuilder().onConflict() maps an FK shadow property", async () => {
    const write = (hits: number) =>
      em
        .createInsertBuilder(UccVisit)
        .values({ member, day: "tue", hits } as any)
        .onConflict(["memberId" as any, "day"])
        .doUpdate((t: any, ex: any) => ({ hits: t.hits.add(ex.hits) }))
        .execute();
    await write(1);
    await write(2);

    expect(await visits()).toEqual([{ member_id: member.id, day: "tue", hits: 3 }]);
  });
});

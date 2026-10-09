/**
 * Option values outside what an option accepts stop `register()` instead
 * of booting with the setting quietly off.
 *
 * Before, `synchronize: "yes"` created missing tables but never added a
 * column to an existing one, `tenantStrategy: "tenant-column"` booted with
 * no tenant scoping at all, and a `propagation` typo ran as REQUIRED.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "ovv_notes" })
class OvvNoteV1 {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) title!: string;
}

@Entity({ name: "ovv_notes" })
class OvvNoteV2 {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) title!: string;
  @Column({ type: "varchar", length: 20, nullable: true }) body!: string | null;
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

describe("[SQLite] option values are validated at register()", () => {
  let dir: string;
  let database: string;
  const open: EntityManager[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ovv-"));
    database = path.join(dir, "app.db");
  });

  afterEach(async () => {
    while (open.length > 0) await open.pop()!.propagateShutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function register(entities: Array<new () => any>, extra: Record<string, unknown>) {
    const em = new EntityManager();
    open.push(em);
    await em.register({ type: "sqlite", database, entities, logging: false, ...extra } as any);
    return em;
  }

  it("rejects a synchronize value that is not a mode, before any table is touched", async () => {
    await register([OvvNoteV1], { synchronize: true });

    for (const synchronize of ["yes", 1, {}, { mode: "yes" }]) {
      const error = await rejectionOf(() => register([OvvNoteV2], { synchronize }));
      expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
      expect(error?.message).toContain("'synchronize");
    }

    const em = await register([OvvNoteV1], { synchronize: false });
    const columns: any[] = await em.query(`PRAGMA table_info("ovv_notes")`);
    expect(columns.map((c) => c.name)).toEqual(["id", "title"]);
  });

  it("rejects a tenantStrategy typo instead of booting without tenant scoping", async () => {
    const error = await rejectionOf(() =>
      register([OvvNoteV1], { synchronize: true, tenantStrategy: "tenant-column" }),
    );

    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain(`'tenantStrategy' must be one of`);
    expect(error?.message).toContain(`Did you mean "tenant_column"?`);
  });

  it("rejects a propagation typo instead of joining the ambient transaction", async () => {
    const em = await register([OvvNoteV1], { synchronize: true });

    const error = await rejectionOf(() =>
      em.transaction(async () => undefined, { propagation: "REQUIRES_NEWW" as any }),
    );

    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain(`Did you mean "REQUIRES_NEW"?`);
  });

  it("rejects an isolation level SQLite would otherwise ignore", async () => {
    const em = await register([OvvNoteV1], { synchronize: true });

    const error = await rejectionOf(() =>
      em.transaction(async () => undefined, { isolationLevel: "SERIALISABLE" as any }),
    );

    expect(error?.code).toBe(OrmErrorCode.INVALID_CONFIG);
    expect(error?.message).toContain(`Did you mean "SERIALIZABLE"?`);
  });
});

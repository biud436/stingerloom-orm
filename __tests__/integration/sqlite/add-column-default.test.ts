/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite (file database): `synchronize` adds a column to an existing table
 * with its declared `@Column({ default })`.
 *
 * The ADD COLUMN used a type placeholder instead — `DEFAULT ''` for text,
 * `DEFAULT 0` for numbers and booleans — so a table that existed before the
 * column was declared got `''` / `0` in every old row, and in every row saved
 * afterwards without the property, while a new table got the declared value.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { Logger } from "../../../src/utils/Logger";

@Entity({ name: "acd_user" })
class V1 {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "acd_user" })
class V2 {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column({ default: "active" }) status!: string;
  @Column({ type: "int", default: 5 }) level!: number;
  @Column({ type: "boolean", default: true }) enabled!: boolean;
  @Column({ nullable: true, default: "n/a" }) note!: string | null;
  @Column({ default: "it's" }) quoted!: string;
  @Column() plain!: string;
  @Column({ type: "datetime", nullable: true, default: "(CURRENT_TIMESTAMP)" })
  seenAt!: Date | null;
}

describe("[Integration] SQLite: ADD COLUMN keeps the declared default", () => {
  let dir: string;
  let file: string;
  let em: EntityManager | undefined;
  const logs: string[] = [];

  async function boot(entity: any): Promise<EntityManager> {
    const next = new EntityManager();
    await next.register(
      { type: "sqlite", database: file, entities: [entity], synchronize: true, logging: false } as any,
      `acd_${Math.random().toString(36).slice(2, 10)}`,
    );
    return next;
  }

  async function rows(query: string): Promise<any[]> {
    const raw: any = await em!.getDriver()!.executeRaw(query);
    return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acd-"));
    file = path.join(dir, "app.db");
    const v1 = await boot(V1);
    await v1.save(V1, { name: "old" });
    await v1.propagateShutdown();

    Logger.setOutput((msg: string) => {
      logs.push(msg);
    });
    em = await boot(V2);
    Logger.reset();
    await em.save(V2, { name: "new", plain: "p" } as any);
  });

  afterAll(async () => {
    Logger.reset();
    await em?.propagateShutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the added columns their declared defaults", async () => {
    const info = await rows(`PRAGMA table_info("acd_user")`);
    const defaults = Object.fromEntries(info.map((c: any) => [c.name, c.dflt_value]));

    expect(defaults).toMatchObject({
      status: "'active'",
      level: "5",
      enabled: "TRUE",
      note: "'n/a'",
      quoted: "'it''s'",
      plain: "''",
    });
  });

  it("fills existing rows and rows saved without the property", async () => {
    const found = await em!.find(V2, { orderBy: { id: "ASC" } } as any);

    for (const row of found) {
      expect(row).toMatchObject({ status: "active", level: 5, enabled: true, note: "n/a", quoted: "it's" });
    }
    expect(found.map((row) => row.name)).toEqual(["old", "new"]);
  });

  it("adds an expression default's column without it, and says so", async () => {
    const info = await rows(`PRAGMA table_info("acd_user")`);
    const seenAt = info.find((c: any) => c.name === "seenAt");

    expect(seenAt.dflt_value).toBeNull();
    expect(logs.some((l) => l.includes("acd_user.seenAt") && l.includes("expression default"))).toBe(true);
  });
});

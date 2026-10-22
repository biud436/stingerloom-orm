/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `em.pipe()` under `tenantStrategy: "tenant_column"`.
 *
 * Every statement the raw pipeline issues — its batches (offset, keyset,
 * binary) and `count()` — carries the tenant predicate a `find()` of the same
 * entity carries, and drops it where `find()` does.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src";
import { NonTenantEntity } from "../../../src/decorators/TenantColumn";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { Logger } from "../../../src/utils/Logger";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "rpt_note" })
class RptNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}

@NonTenantEntity()
@Entity({ name: "rpt_country" })
class RptCountry {
  @PrimaryGeneratedColumn() id!: number;
  @Column() code!: string;
}

@Entity({ name: "rpt_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class RptDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}
@Entity({ name: "rpt_review" })
@DiscriminatorValue("review")
class RptReview extends RptDoc {
  @Column() reviewer!: string;
}

const ENTITIES = [RptNote, RptCountry, RptDoc, RptReview];

async function makeEm(opts: Record<string, any> = {}) {
  const base = new EntityManager();
  await base.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      tenantStrategy: "tenant_column",
      ...opts,
    } as any,
    `rpt_${Math.random().toString(36).slice(2, 10)}`,
  );
  return { base, em: base.extend(rawPipelinePlugin()) as any };
}

const acme = <R = any>(fn: () => Promise<R>) => MetadataContext.run("acme", fn);
const beta = <R = any>(fn: () => Promise<R>) => MetadataContext.run("beta", fn);

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

describe("[Integration] SQLite: em.pipe() under tenant_column", () => {
  let base: EntityManager;
  let em: any;

  beforeEach(async () => {
    MetadataContext.reset();
    ({ base, em } = await makeEm());
    await acme(async () => {
      for (const title of ["a1", "a2", "a3"]) await em.save(RptNote, { title });
      await em.save(RptReview, { title: "ar", reviewer: "ann" });
    });
    await beta(async () => {
      for (const title of ["b1", "b2"]) await em.save(RptNote, { title });
      await em.save(RptReview, { title: "br", reviewer: "bob" });
    });
    await MetadataContext.run("public", async () => {
      await em.save(RptCountry, { code: "KR" });
      await em.save(RptCountry, { code: "US" });
    });
  });

  afterEach(async () => {
    await base.propagateShutdown();
  });

  const titles = (rows: any[]) => rows.map((r) => r.title).sort();

  it("reads only the active tenant's rows in offset batches", async () => {
    const rows = await acme(() => drain(em.pipe(RptNote, { batchSize: 2 }).raw()));
    expect(titles(rows)).toEqual(["a1", "a2", "a3"]);
  });

  it("reads only the active tenant's rows in keyset batches", async () => {
    const rows = await beta(() =>
      drain(em.pipe(RptNote, { orderBy: { id: "ASC" }, keyset: true, batchSize: 1 }).raw()),
    );
    expect(titles(rows)).toEqual(["b1", "b2"]);
  });

  it("reads only the active tenant's rows in binary and array mode", async () => {
    const rows = await acme(() => drain(em.pipe(RptNote, { batchSize: 2 }).binary()));
    expect(titles(rows)).toEqual(["a1", "a2", "a3"]);

    const arrays = await acme(() =>
      drain(em.pipe(RptNote, { select: ["title"] }).binary({ arrayMode: true })),
    );
    expect(arrays.map((r: any[]) => r[0]).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("ANDs the tenant predicate with the caller's where", async () => {
    const rows: any[] = await acme(() =>
      em.pipe(RptNote, { where: { title: { in: ["a1", "b1"] } } }).collect(),
    );
    expect(titles(rows)).toEqual(["a1"]);
  });

  it("counts only the active tenant's rows", async () => {
    expect(await acme(() => em.pipe(RptNote).count())).toBe(3);
    expect(await beta(() => em.pipe(RptNote, { where: { title: "b2" } }).count())).toBe(1);
  });

  it("scopes a JOINED child through its root's tenant column", async () => {
    const rows = await acme(() => em.pipe(RptReview).collect());
    expect(rows.map((r: any) => r.reviewer)).toEqual(["ann"]);
    expect(await beta(() => em.pipe(RptReview).count())).toBe(1);
  });

  it("reads every tenant's rows inside runUnscoped() and the public context", async () => {
    const unscoped = await acme(() =>
      MetadataContext.runUnscoped(() => em.pipe(RptNote).collect()),
    );
    expect(unscoped).toHaveLength(5);
    expect(await MetadataContext.run("public", () => em.pipe(RptNote).count())).toBe(5);
  });

  it("does not scope a @NonTenantEntity", async () => {
    expect(await acme(() => em.pipe(RptCountry).collect())).toHaveLength(2);
  });

  it("does not report its own statements as raw SQL", async () => {
    const warnSpy = jest.spyOn((base as any).logger as Logger, "warn");
    try {
      await acme(async () => {
        await em.pipe(RptNote).count();
        await em.pipe(RptNote).collect();
      });
      const raw = warnSpy.mock.calls.filter((c) =>
        /\[multi-tenancy\] em\.query\(\)/.test(String(c[0])),
      );
      expect(raw).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("applies tenantOnMissingContext when no tenant context is active", async () => {
    const strict = await makeEm({ tenantOnMissingContext: "throw" });
    try {
      await expect(strict.em.pipe(RptNote).collect()).rejects.toMatchObject({
        code: OrmErrorCode.MISSING_TENANT_CONTEXT,
      });
      await expect(strict.em.pipe(RptNote).count()).rejects.toMatchObject({
        code: OrmErrorCode.MISSING_TENANT_CONTEXT,
      });
    } finally {
      await strict.base.propagateShutdown();
    }
  });
});

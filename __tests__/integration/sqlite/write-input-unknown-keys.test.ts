/**
 * Unknown keys in write payloads (V5-T1-1).
 *
 * `save()` / `saveMany()` / `insertMany()` / `insertManyAndReturn()` /
 * `upsert()` / `insertIgnore()` / `batchUpsert()` pick their columns by
 * walking `metadata.columns`, so a key that names no column was dropped
 * without a trace — while the same typo in a read `where` or in
 * `updateMany()` failed fast with a did-you-mean. These cases pin the new
 * contract on the real SQLite write path:
 *
 * - default policy `"warn"`: the write succeeds, the key is reported once per
 *   entity + key through the EntityManager logger with the closest match;
 * - `"throw"`: the write is rejected before any SQL with the same
 *   `InvalidQueryError` the read paths raise;
 * - `"ignore"`: the previous silent behavior, opted into explicitly.
 *
 * The other half of the matrix is what must NOT be reported: relation
 * properties, FK shadow properties, DB column names, `@ComputedColumn`
 * properties, the STI discriminator, `undefined` values and function-valued
 * members — every shape an entity instance handed back to `save()` carries.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ComputedColumn } from "../../../src/decorators/ComputedColumn";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { Relation } from "../../../src/types/Relation";

@Entity({ name: "wuk_teams" })
class WukTeam {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60, name: "team_name" })
  teamName!: string;

  @OneToMany(() => WukMember, { mappedBy: "team", cascade: ["insert"] })
  members?: Relation<WukMember[]>;
}

@Entity({ name: "wuk_members" })
class WukMember {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  firstName!: string;

  @Column({ type: "int", nullable: true })
  score?: number | null;

  @Column({ type: "int", nullable: true })
  teamId?: number | null;

  @ManyToOne(() => WukTeam, (t: WukTeam) => t.members, { joinColumn: "teamId" })
  team?: Relation<WukTeam>;

  @ComputedColumn({ expression: "score * 2", type: "int" })
  doubled?: number;
}

@Entity({ name: "wuk_payments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "ptype", type: "varchar", length: 30 })
class WukPayment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;
}

@Entity()
@DiscriminatorValue("card")
class WukCardPayment extends WukPayment {
  @Column({ type: "varchar", length: 30, nullable: true })
  cardNumber!: string | null;
}

/**
 * Assigned (non-generated) PK: saveMany() cannot batch this entity and falls
 * back to one save() per item — the second saveMany path in the matrix.
 */
@Entity({ name: "wuk_tags" })
class WukTag {
  @PrimaryColumn({ type: "varchar", length: 20 })
  code!: string;

  @Column({ type: "varchar", length: 60 })
  label!: string;
}

const ENTITIES = [WukTeam, WukMember, WukPayment, WukCardPayment, WukTag];

type Policy = "warn" | "throw" | "ignore";

async function makeEm(policy?: Policy): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      ...(policy ? { unknownWriteKeys: policy } : {}),
    },
    `wuk_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function warnSpy(em: EntityManager): jest.SpyInstance {
  return jest
    .spyOn((em as unknown as { logger: { warn: (m: string) => void } }).logger, "warn")
    .mockImplementation(() => undefined);
}

function warnings(spy: jest.SpyInstance): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

/**
 * One row per write entry point. Each runs the operation with a payload that
 * carries the typo key `firstNam` next to the real `firstName`, and returns
 * the persisted row so the test can assert nothing else changed.
 */
interface EntryPoint {
  name: string;
  /** Name the warning must attribute the call to. */
  method: string;
  entity: typeof WukMember | typeof WukTag;
  realKey: string;
  typoKey: string;
  run: (em: EntityManager) => Promise<void>;
}

const member = {
  entity: WukMember,
  realKey: "firstName",
  typoKey: "firstNam",
} as const;

const ENTRY_POINTS: EntryPoint[] = [
  {
    name: "save",
    method: "save",
    ...member,
    run: async (em) => {
      await em.save(WukMember, { firstName: "kim", firstNam: "typo" } as never);
    },
  },
  {
    name: "saveMany (batch INSERT)",
    method: "saveMany",
    ...member,
    run: async (em) => {
      await em.saveMany(WukMember, [
        { firstName: "kim", firstNam: "typo" } as never,
        { firstName: "lee" } as never,
      ]);
    },
  },
  {
    name: "saveMany (sequential fallback, assigned PK)",
    method: "saveMany",
    entity: WukTag,
    realKey: "label",
    typoKey: "labl",
    run: async (em) => {
      await em.saveMany(WukTag, [
        { code: "a", label: "kim", labl: "typo" } as never,
        { code: "b", label: "lee" } as never,
      ]);
    },
  },
  {
    name: "insertMany",
    method: "insertMany",
    ...member,
    run: async (em) => {
      await em.insertMany(WukMember, [
        { firstName: "kim", firstNam: "typo" } as never,
      ]);
    },
  },
  {
    name: "insertManyAndReturn",
    method: "insertManyAndReturn",
    ...member,
    run: async (em) => {
      await em.insertManyAndReturn(WukMember, [
        { firstName: "kim", firstNam: "typo" } as never,
      ]);
    },
  },
  {
    name: "upsert",
    method: "upsert",
    ...member,
    run: async (em) => {
      await em.upsert(WukMember, { id: 1, firstName: "kim", firstNam: "typo" } as never);
    },
  },
  {
    name: "insertIgnore",
    method: "insertIgnore",
    ...member,
    run: async (em) => {
      await em.insertIgnore(WukMember, { id: 1, firstName: "kim", firstNam: "typo" } as never);
    },
  },
  {
    name: "batchUpsert",
    method: "batchUpsert",
    ...member,
    run: async (em) => {
      await em.batchUpsert(WukMember, [
        { id: 1, firstName: "kim", firstNam: "typo" } as never,
      ]);
    },
  },
];

describe("[Integration] SQLite: unknown keys in write payloads", () => {
  describe('default policy ("warn")', () => {
    let em: EntityManager;
    let spy: jest.SpyInstance;

    beforeAll(async () => {
      em = await makeEm();
    });

    beforeEach(async () => {
      await em.query("DELETE FROM wuk_members");
      await em.query("DELETE FROM wuk_tags");
      spy = warnSpy(em);
    });

    afterEach(() => {
      spy.mockRestore();
      // The dedup set is per EntityManager; each case wants a fresh slate.
      (em as unknown as { writeKeyWarned: Set<string> }).writeKeyWarned.clear();
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it.each(ENTRY_POINTS)(
      "$name: writes the row, warns once with the closest match",
      async ({ run, method, entity, realKey, typoKey }) => {
        await run(em);

        const rows = (await em.find(entity as never)) as Record<string, unknown>[];
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.some((r) => r[realKey] === "kim")).toBe(true);
        expect(rows.every((r) => r[typoKey] === undefined)).toBe(true);

        const reported = warnings(spy).filter((m) => m.includes(`"${typoKey}"`));
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain(`Unknown key "${typoKey}" in the data passed to ${method}()`);
        expect(reported[0]).toContain(`entity "${entity.name}"`);
        expect(reported[0]).toContain(`Did you mean "${realKey}"?`);
        expect(reported[0]).toContain("unknownWriteKeys");
      },
    );

    it("warns once per entity and key, not once per call", async () => {
      await em.save(WukMember, { firstName: "a", firstNam: "x" } as never);
      await em.save(WukMember, { firstName: "b", firstNam: "y" } as never);
      await em.insertMany(WukMember, [{ firstName: "c", firstNam: "z" } as never]);

      expect(warnings(spy).filter((m) => m.includes('"firstNam"'))).toHaveLength(1);
    });

    it("reports each distinct unknown key of one payload", async () => {
      await em.save(WukMember, {
        firstName: "a",
        firstNam: "x",
        scor: 3,
      } as never);

      const reported = warnings(spy);
      expect(reported.some((m) => m.includes('"firstNam"') && m.includes('"firstName"'))).toBe(true);
      expect(reported.some((m) => m.includes('"scor"') && m.includes('"score"'))).toBe(true);
    });

    it("names the calling method in the warning", async () => {
      await em.insertMany(WukMember, [{ firstName: "a", firstNam: "x" } as never]);
      expect(warnings(spy)[0]).toContain("insertMany()");
    });

    it("omits the suggestion when nothing is close", async () => {
      await em.save(WukMember, { firstName: "a", completelyUnrelated: 1 } as never);
      const [message] = warnings(spy);
      expect(message).toContain('Unknown key "completelyUnrelated"');
      expect(message).not.toContain("Did you mean");
    });
  });

  describe("accepted keys never warn (the shapes an entity instance carries)", () => {
    let em: EntityManager;
    let spy: jest.SpyInstance;

    beforeAll(async () => {
      em = await makeEm("throw");
    });

    beforeEach(async () => {
      await em.query("DELETE FROM wuk_members");
      await em.query("DELETE FROM wuk_payments");
      spy = warnSpy(em);
    });

    afterEach(() => {
      spy.mockRestore();
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it("relation property and FK shadow property", async () => {
      const team = await em.save(WukTeam, { teamName: "core" });

      await em.save(WukMember, { firstName: "rel", team } as never);
      await em.save(WukMember, { firstName: "shadow", teamId: team.id });

      const rows = await em.find(WukMember, { orderBy: { id: "ASC" } });
      expect(rows.map((r) => r.teamId)).toEqual([team.id, team.id]);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("cascade-saved children (the cascade writes the raw join column onto them)", async () => {
      const team = await em.save(WukTeam, {
        teamName: "cascade",
        members: [{ firstName: "c1" }, { firstName: "c2" }],
      } as never);

      const rows = await em.find(WukMember, { where: { teamId: team.id } });
      expect(rows).toHaveLength(2);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("a hydrated instance saved back unchanged", async () => {
      const team = await em.save(WukTeam, { teamName: "hydrated" });
      const saved = await em.save(WukMember, { firstName: "h", score: 2, teamId: team.id });
      const loaded = await em.findOne(WukMember, {
        where: { id: saved.id },
        relations: ["team"],
      });
      expect(loaded?.team).toBeDefined();

      await em.save(WukMember, loaded!);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("inverse-side collection on the parent", async () => {
      await em.save(WukTeam, { teamName: "with-members", members: [] } as never);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("@ComputedColumn property on a re-saved instance", async () => {
      const saved = await em.save(WukMember, { firstName: "calc", score: 4 });
      const loaded = await em.findOne(WukMember, { where: { id: saved.id } });
      expect(loaded?.doubled).toBe(8);

      loaded!.score = 5;
      await em.save(WukMember, loaded!);

      const again = await em.findOne(WukMember, { where: { id: saved.id } });
      expect(again?.doubled).toBe(10);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("STI discriminator and inherited columns on a child", async () => {
      const card = await em.save(WukCardPayment, { amount: 10, cardNumber: "4111" });
      const loaded = await em.findOne(WukCardPayment, { where: { id: card.id } });
      expect(loaded).toBeDefined();

      // A hydrated child instance carries the discriminator under the DB
      // column name; saving it back must not report it.
      await em.save(WukCardPayment, { ...loaded, amount: 11 } as never);
      await em.save(WukCardPayment, { amount: 12, ptype: "card" } as never);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("undefined values and function-valued members", async () => {
      await em.save(WukMember, {
        firstName: "fn",
        firstNam: undefined,
        toJSON() {
          return {};
        },
      } as never);
      expect(warnings(spy)).toHaveLength(0);
    });

    it("class instance whose constructor initialises a relation field", async () => {
      class Draft {
        firstName = "inst";
        team: WukTeam | undefined = undefined;
        score = 1;
      }
      await em.save(WukMember, new Draft() as never);
      expect(warnings(spy)).toHaveLength(0);
    });
  });

  describe('policy "throw"', () => {
    let em: EntityManager;

    beforeAll(async () => {
      em = await makeEm("throw");
    });

    beforeEach(async () => {
      await em.query("DELETE FROM wuk_members");
      await em.query("DELETE FROM wuk_tags");
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it.each(ENTRY_POINTS)(
      "$name: rejects before writing, with the read-path message",
      async ({ run, entity, realKey, typoKey }) => {
        const error = await captureError(() => run(em));

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(error.message).toContain(
          `Unknown column "${typoKey}" in "data" for entity "${entity.name}". Did you mean "${realKey}"?`,
        );
        expect((error as InvalidQueryError).suggestion).toContain("Valid columns: ");

        // Nothing reached the table.
        expect(await em.count(entity as never)).toBe(0);
      },
    );

    it("reports a DB column name typed instead of the property (the INSERT reads property keys only)", async () => {
      const error = await captureError(() =>
        em.save(WukTeam, { team_name: "by-db-name" } as never),
      );
      expect(error.message).toContain(
        'Unknown column "team_name" in "data" for entity "WukTeam". Did you mean "teamName"?',
      );
    });

    it("checks every item of a batch, not only the first", async () => {
      const error = await captureError(() =>
        em.insertMany(WukMember, [
          { firstName: "ok" } as never,
          { firstName: "ok" } as never,
          { firstName: "bad", scoer: 1 } as never,
        ]),
      );
      expect(error.message).toContain('Unknown column "scoer"');
      expect(await em.count(WukMember)).toBe(0);
    });

    it("rejects a typo on a cascade-saved child", async () => {
      const error = await captureError(() =>
        em.save(WukTeam, {
          teamName: "cascade",
          members: [{ firstName: "child", firstNam: "typo" }],
        } as never),
      );
      expect(error.message).toContain('Unknown column "firstNam"');
    });
  });

  describe('policy "ignore"', () => {
    let em: EntityManager;
    let spy: jest.SpyInstance;

    beforeAll(async () => {
      em = await makeEm("ignore");
    });

    beforeEach(async () => {
      await em.query("DELETE FROM wuk_members");
      await em.query("DELETE FROM wuk_tags");
      spy = warnSpy(em);
    });

    afterEach(() => {
      spy.mockRestore();
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it.each(ENTRY_POINTS)("$name: writes silently", async ({ run, entity }) => {
      await run(em);
      expect(await em.count(entity as never)).toBeGreaterThanOrEqual(1);
      expect(warnings(spy)).toHaveLength(0);
    });
  });

  describe("entity construction helpers keep the key on the instance", () => {
    let em: EntityManager;
    let spy: jest.SpyInstance;

    beforeAll(async () => {
      em = await makeEm();
    });

    beforeEach(async () => {
      await em.query("DELETE FROM wuk_members");
      await em.query("DELETE FROM wuk_tags");
      spy = warnSpy(em);
    });

    afterEach(() => {
      spy.mockRestore();
      (em as unknown as { writeKeyWarned: Set<string> }).writeKeyWarned.clear();
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it("create() / merge() / preload() do not report; the write that follows does", async () => {
      const created = em.create(WukMember, { firstName: "c", firstNam: "x" } as never);
      expect((created as unknown as Record<string, unknown>).firstNam).toBe("x");

      const merged = em.merge(created, { scoer: 1 } as never);
      expect((merged as unknown as Record<string, unknown>).scoer).toBe(1);
      expect(warnings(spy)).toHaveLength(0);

      const saved = await em.save(WukMember, created);
      const reported = warnings(spy);
      expect(reported.some((m) => m.includes('"firstNam"'))).toBe(true);
      expect(reported.some((m) => m.includes('"scoer"'))).toBe(true);

      spy.mockClear();
      const preloaded = await em.preload(WukMember, { id: saved.id, frstName: "p" } as never);
      expect((preloaded as unknown as Record<string, unknown>).frstName).toBe("p");
      expect(warnings(spy)).toHaveLength(0);
    });
  });

  describe("updateMany keeps its existing contract", () => {
    let em: EntityManager;

    beforeAll(async () => {
      em = await makeEm("ignore");
      await em.save(WukMember, { firstName: "kim" });
    });

    afterAll(async () => {
      await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    });

    it("throws regardless of unknownWriteKeys", async () => {
      const error = await captureError(() =>
        em.updateMany(WukMember, { firstNam: "x" } as never, { where: { firstName: "kim" } }),
      );
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Unknown column "firstNam" in "data"');
    });
  });
});

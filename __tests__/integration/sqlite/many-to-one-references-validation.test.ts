/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The column a `@ManyToOne` names with `references` /
 * `@RelationColumn({ referencedColumn })` (SQLite :memory:).
 *
 * The schema wrote the name into the constraint as given. A name that is no
 * column of the target — a typo, or a property name whose column the naming
 * strategy renamed — produced `REFERENCES "countries" ("isoCod")`; register()
 * succeeded, and every later write to either table failed with "foreign key
 * mismatch". A misspelled name is now refused at register(), and a property
 * name is resolved to its column.
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "mrv_country" })
@UniqueIndex(["isoCode"])
class Country {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 8 }) isoCode!: string;
}

@Entity({ name: "mrv_city" })
class MisspelledCity {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Country, () => undefined as any, { references: "isoCod" })
  @RelationColumn({ name: "country_iso", type: "varchar", length: 8, nullable: true } as any)
  country!: Country | null;
}

@Entity({ name: "mrv_town" })
class MisspelledTown {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Country, () => undefined as any)
  @RelationColumn({ name: "country_iso", type: "varchar", length: 8, nullable: true, referencedColumn: "isoCodes" } as any)
  country!: Country | null;
}

@Entity({ name: "mrv_village" })
class Village {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 20 }) name!: string;
  // The property name: the naming strategy stores it as iso_code.
  @ManyToOne(() => Country, () => undefined as any, { references: "isoCode" })
  @RelationColumn({ name: "country_iso", type: "varchar", length: 8, nullable: true } as any)
  country!: Country | null;
}

async function register(entities: any[], extra: Record<string, unknown> = {}): Promise<EntityManager> {
  MetadataContext.reset();
  const em = new EntityManager();
  try {
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities,
        synchronize: true,
        logging: false,
        ...extra,
      } as any,
      `mrv_${Math.random().toString(36).slice(2, 10)}`,
    );
  } catch (error) {
    await em.propagateShutdown({ closeConnections: true } as any);
    throw error;
  }
  return em;
}

describe("[Integration] SQLite: the column a @ManyToOne references", () => {
  it.each([
    ["references", MisspelledCity, "isoCod", "isoCode"],
    ["@RelationColumn referencedColumn", MisspelledTown, "isoCodes", "isoCode"],
  ] as const)("refuses a %s that names no column of the target", async (_label, Entity, name, hint) => {
    const error: any = await register([Country, Entity]).catch((e) => e);
    expect(error.code).toBe(OrmErrorCode.SCHEMA_ERROR);
    expect(error.message).toContain(`${Entity.name}.country: @ManyToOne references "${name}"`);
    expect(error.message).toContain(`Did you mean "${hint}"?`);
  });

  it("refuses it without synchronize too, since reads and writes use the column", async () => {
    const error: any = await register([Country, MisspelledCity], { synchronize: false }).catch((e) => e);
    expect(error.code).toBe(OrmErrorCode.SCHEMA_ERROR);
  });

  describe("a property name under a naming strategy", () => {
    let em: EntityManager;

    beforeAll(async () => {
      em = await register([Country, Village], { namingStrategy: new SnakeNamingStrategy() });
    });

    afterAll(async () => {
      await em.propagateShutdown({ closeConnections: true } as any);
    });

    it("references the column the property is stored in", async () => {
      const [{ sql }] = (await em.query(
        `SELECT sql FROM sqlite_master WHERE name = 'mrv_village'`,
      )) as any[];
      expect(sql).toContain(`REFERENCES "mrv_country" ("iso_code")`);
    });

    it("writes and loads the relation through that column", async () => {
      await em.save(Country, { isoCode: "XX" } as any);
      const kr = await em.save(Country, { isoCode: "KR" } as any);
      await em.save(Village, { name: "hahoe", country: kr } as any);

      const rows = (await em.query(`SELECT name, country_iso FROM mrv_village`)) as any[];
      expect(rows).toEqual([{ name: "hahoe", country_iso: "KR" }]);
      const [village] = (await em.find(Village, { relations: ["country"] } as any)) as any[];
      expect(village.country).toMatchObject({ id: kr.id, isoCode: "KR" });
      const joined = await em
        .createQueryBuilder(Village, "v")
        .leftJoinRelationAndSelect("country", "c")
        .getMany();
      expect((joined[0] as any).country).toMatchObject({ isoCode: "KR" });
    });
  });
});

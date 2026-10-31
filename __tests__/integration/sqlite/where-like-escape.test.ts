/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `contains` / `startsWith` / `endsWith` match `%`, `_`
 * and `\` literally.
 *
 * The where resolver escaped those characters with a backslash but sent no
 * ESCAPE clause. PostgreSQL and MySQL default the LIKE escape character to
 * backslash; SQLite has none, so it read `\_` as a literal backslash and a
 * term with an underscore or a percent sign matched nothing. The QueryDSL
 * `contains()` sent the clause, so the two entry points disagreed.
 */
import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn, qAlias } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "wle_file" })
class WleFile {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

const NAMES = ["discount 50% off", "my_file.txt", "myXfile.txt", "back\\slash_here", "plain"];

describe("[Integration] SQLite: LIKE helpers escape their term", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [WleFile],
        synchronize: true,
        logging: false,
      } as any,
      `wle_${Math.random().toString(36).slice(2, 10)}`,
    );
    for (const name of NAMES) await em.save(WleFile, { name });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  async function names(where: Record<string, unknown>): Promise<string[]> {
    const rows = await em.find(WleFile, { where: { name: where }, orderBy: { id: "ASC" } } as any);
    return rows.map((row) => row.name);
  }

  it("contains matches a percent sign and an underscore literally", async () => {
    expect(await names({ contains: "50%" })).toEqual(["discount 50% off"]);
    expect(await names({ contains: "my_file" })).toEqual(["my_file.txt"]);
  });

  it("startsWith and endsWith match them literally too", async () => {
    expect(await names({ startsWith: "my_" })).toEqual(["my_file.txt"]);
    expect(await names({ endsWith: "_here" })).toEqual(["back\\slash_here"]);
  });

  it("contains matches a backslash literally", async () => {
    expect(await names({ contains: "back\\slash" })).toEqual(["back\\slash_here"]);
  });

  it("the raw like operator still treats the pattern's wildcards as wildcards", async () => {
    expect(await names({ like: "%my_file%" })).toEqual(["my_file.txt", "myXfile.txt"]);
  });

  it("the query builder's where object and the QueryDSL contains() agree", async () => {
    const viaWhere = await em
      .createQueryBuilder(WleFile, "f")
      .where({ name: { contains: "my_file" } })
      .getMany();
    const f = qAlias(WleFile, "f");
    const viaDsl = await em
      .createQueryBuilder(WleFile, "f")
      .where(f.name.contains("my_file"))
      .getMany();

    expect(viaWhere.map((row) => row.name)).toEqual(["my_file.txt"]);
    expect(viaDsl.map((row) => row.name)).toEqual(["my_file.txt"]);
  });
});

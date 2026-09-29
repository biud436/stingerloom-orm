/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildTpcUnionSource,
  hierarchyRowColumns,
  pruneTpcSiblingColumns,
  type TpcSourceContext,
} from "../../src/core/TpcUnionSource";

class Asset {}
class Vehicle extends Asset {}
class Building extends Asset {}

/**
 * Asset (id, label, owner_id) → Vehicle (+ wheels, driver_id) → Building
 * (+ floors). `owner_id` and `driver_id` are relation join columns no
 * `@Column` declares.
 */
function context(typedNullPadding = false): TpcSourceContext {
  const columns = new Map<any, string[]>([
    [Asset, ["id", "label"]],
    [Vehicle, ["id", "label", "wheels"]],
    [Building, ["id", "label", "floors"]],
  ]);
  const manyToOne = new Map<any, string[]>([
    [Asset, ["owner_id"]],
    [Vehicle, ["owner_id", "driver_id"]],
    [Building, ["owner_id"]],
  ]);
  const tables = new Map<any, string>([
    [Asset, "asset"],
    [Vehicle, "vehicle"],
    [Building, "building"],
  ]);
  const discriminators = new Map<any, string | null>([
    [Asset, null],
    [Vehicle, "vehicle"],
    [Building, "building"],
  ]);
  return {
    inheritanceResolver: {
      getConcreteEntities: () => [Asset, Vehicle, Building],
      getDiscriminatorColumn: () => ({ name: "dtype" }),
      getDiscriminatorValue: (e: any) => discriminators.get(e) ?? null,
    } as any,
    resolver: {
      resolveEntityMetadata: (e: any) => ({
        name: tables.get(e),
        columns: columns.get(e)!.map((name) => ({ name })),
      }),
      resolveManyToOneMetadata: (e: any) =>
        manyToOne.get(e)!.map((joinColumn) => ({ joinColumn })),
      resolveOneToOneMetadata: () => [],
    } as any,
    wrap: (n) => `"${n}"`,
    wrapTable: (n) => `"${n}"`,
    typedNullPadding,
  };
}

const branches = (text: string) => text.split(" UNION ALL ");

describe("TpcUnionSource", () => {
  it("projects every table onto the hierarchy's columns and join columns", () => {
    expect(hierarchyRowColumns(context(), Asset)).toEqual([
      "id",
      "label",
      "owner_id",
      "wheels",
      "driver_id",
      "floors",
    ]);

    const union = buildTpcUnionSource(context(), Asset);
    expect(branches(union.sql)).toEqual([
      'SELECT "id", "label", "owner_id", NULL AS "wheels", NULL AS "driver_id", NULL AS "floors", ? AS "dtype" FROM "asset"',
      'SELECT "id", "label", "owner_id", "wheels", "driver_id", NULL AS "floors", ? AS "dtype" FROM "vehicle"',
      'SELECT "id", "label", "owner_id", NULL AS "wheels", NULL AS "driver_id", "floors", ? AS "dtype" FROM "building"',
    ]);
    expect(union.values).toEqual(["Asset", "vehicle", "building"]);
  });

  it("types the first table's NULL for a column first held third or later", () => {
    const union = buildTpcUnionSource(context(true), Asset);

    // `floors` is first held by the third table: two untyped NULLs ahead of
    // it would resolve to text on PostgreSQL. `wheels` and `driver_id` meet
    // their holder second, where one untyped NULL resolves to its type.
    expect(branches(union.sql)).toEqual([
      'SELECT "id", "label", "owner_id", NULL AS "wheels", NULL AS "driver_id", (SELECT "floors" FROM "building" WHERE FALSE) AS "floors", ? AS "dtype" FROM "asset"',
      'SELECT "id", "label", "owner_id", "wheels", "driver_id", NULL AS "floors", ? AS "dtype" FROM "vehicle"',
      'SELECT "id", "label", "owner_id", NULL AS "wheels", NULL AS "driver_id", "floors", ? AS "dtype" FROM "building"',
    ]);
  });

  describe("pruneTpcSiblingColumns", () => {
    const row = (dtype: string) => ({
      id: 1,
      label: "x",
      owner_id: 1,
      wheels: null,
      driver_id: null,
      floors: null,
      dtype,
      owner_name: "joined",
    });

    it("keeps each row's own table's columns, the discriminator and joined keys", () => {
      const [asset, vehicle, building] = pruneTpcSiblingColumns(
        context(),
        Asset,
        [row("Asset"), row("vehicle"), row("building")],
        "dtype",
      );

      expect(Object.keys(asset)).toEqual(["id", "label", "owner_id", "dtype", "owner_name"]);
      expect(Object.keys(vehicle)).toEqual([
        "id",
        "label",
        "owner_id",
        "wheels",
        "driver_id",
        "dtype",
        "owner_name",
      ]);
      expect(Object.keys(building)).toEqual([
        "id",
        "label",
        "owner_id",
        "floors",
        "dtype",
        "owner_name",
      ]);
    });

    it("leaves a row whose discriminator names no table as it is", () => {
      const unknown = row("gone");
      expect(pruneTpcSiblingColumns(context(), Asset, [unknown], "dtype")[0]).toBe(unknown);
    });
  });
});

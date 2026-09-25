/**
 * `ON DELETE` / `ON UPDATE` reach the foreign key DDL on every path.
 *
 * `PostgresDriver.addForeignKey()` and `MySqlDriver.addForeignKey()` — the
 * statements `synchronize` runs for a `@ManyToOne` / `@OneToOne` — hardcoded
 * `ON DELETE NO ACTION ON UPDATE NO ACTION`, so a declared
 * `onDelete: "CASCADE"` was dropped on PostgreSQL and MySQL while SQLite's
 * inline constraint and `migrate:generate` kept it. The action is spliced into
 * DDL, so every path now shares one whitelist that throws on anything else.
 */
import "reflect-metadata";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { referentialActionClause } from "../../src/types/ReferentialAction";

function makeConnector() {
  return { query: jest.fn(async () => ({})), getVersion: () => undefined } as any;
}

describe("foreign key referential actions in DDL", () => {
  describe("referentialActionClause", () => {
    it("renders a whitelisted action and nothing for a missing one", () => {
      expect(referentialActionClause("ON DELETE", "SET NULL")).toBe(" ON DELETE SET NULL");
      expect(referentialActionClause("ON UPDATE", undefined)).toBe("");
      expect(referentialActionClause("ON UPDATE", null)).toBe("");
    });

    it("throws for anything else instead of splicing it into DDL", () => {
      expect(() =>
        referentialActionClause("ON DELETE", "CASCADE; DROP TABLE users" as never),
      ).toThrow(/Invalid ON DELETE action "CASCADE; DROP TABLE users"/);
      expect(() => referentialActionClause("ON UPDATE", "cascade" as never)).toThrow(
        /Use one of: CASCADE, SET NULL, SET DEFAULT, RESTRICT, NO ACTION/,
      );
    });
  });

  describe.each([
    ["PostgreSQL", (c: any) => new PostgresDriver(c)],
    ["MySQL", (c: any) => new MySqlDriver(c)],
  ] as const)("%s addForeignKey", (_label, makeDriver) => {
    it("uses the actions it is given", async () => {
      const connector = makeConnector();
      await makeDriver(connector).addForeignKey(
        "child",
        "parent_id",
        "parent",
        "id",
        "fk_child_parent",
        undefined,
        { onDelete: "CASCADE", onUpdate: "SET NULL" },
      );

      const ddl = connector.query.mock.calls[0][0] as string;
      expect(ddl).toMatch(/ ON DELETE CASCADE ON UPDATE SET NULL$/);
    });

    it("defaults each missing action to NO ACTION", async () => {
      const connector = makeConnector();
      const driver = makeDriver(connector);
      await driver.addForeignKey("child", "parent_id", "parent", "id", "fk_a");
      await driver.addForeignKey("child", "parent_id", "parent", "id", "fk_b", undefined, {
        onDelete: "RESTRICT",
      });

      expect(connector.query.mock.calls[0][0]).toMatch(
        / ON DELETE NO ACTION ON UPDATE NO ACTION$/,
      );
      expect(connector.query.mock.calls[1][0]).toMatch(
        / ON DELETE RESTRICT ON UPDATE NO ACTION$/,
      );
    });

    it("sends nothing for an action outside the whitelist", async () => {
      const connector = makeConnector();

      await expect(
        (async () =>
          makeDriver(connector).addForeignKey("child", "parent_id", "parent", "id", "fk", undefined, {
            onDelete: "CASCADE; DROP TABLE parent" as never,
          }))(),
      ).rejects.toThrow(/Invalid ON DELETE action/);
      expect(connector.query).not.toHaveBeenCalled();
    });
  });
});

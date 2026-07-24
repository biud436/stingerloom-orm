import "reflect-metadata";
import { DatabaseClient } from "../../src/DatabaseClient";
import { Logger } from "../../src/utils/Logger";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const sqliteOptions = (): DatabaseClientOptions =>
  ({
    type: "sqlite",
    database: ":memory:",
    entities: [],
  }) as unknown as DatabaseClientOptions;

/**
 * A second EntityManager registered without a distinct connectionName
 * replaces the connection the first one routes through. That must not be
 * silent, and the replaced connector must be closed instead of leaking.
 */
describe("DatabaseClient reconnecting an already-registered name", () => {
  const NAME = "reconnect-warning-test";
  let logLines: string[];
  const warnings = () => logLines.filter((l) => l.includes("WARN"));

  beforeEach(() => {
    logLines = [];
    Logger.setOutput((msg) => logLines.push(msg));
  });

  afterEach(async () => {
    Logger.reset();
    await DatabaseClient.getInstance().close(NAME);
  });

  it("warns and closes the previous connector when the name is reused", async () => {
    const client = DatabaseClient.getInstance();

    const first = await client.connect(sqliteOptions(), NAME);
    const closeSpy = jest.spyOn(first, "close");
    expect(warnings()).toHaveLength(0);

    const second = await client.connect(sqliteOptions(), NAME);

    expect(second).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(`'${NAME}'`);
    expect(warnings()[0]).toContain("connectionName");

    expect(client.getConnection(NAME)).toBe(second);
  });

  it("does not warn when the name was closed before reconnecting", async () => {
    const client = DatabaseClient.getInstance();

    await client.connect(sqliteOptions(), NAME);
    await client.close(NAME);
    logLines = [];

    await client.connect(sqliteOptions(), NAME);
    expect(warnings()).toHaveLength(0);
  });
});

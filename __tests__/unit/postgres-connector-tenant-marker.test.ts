/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { Logger } from "../../src/utils/Logger";

// Regression tests for #345 — PostgresConnector.startTransaction must not crash
// when MetadataContext.run() holds a value that is not a valid PG identifier.

type ClientStub = {
  query: jest.Mock;
};

function makeClient(): ClientStub {
  return { query: jest.fn(async () => ({ rows: [] })) };
}

function makeConnector(): PostgresConnector {
  const connector = new PostgresConnector();
  // Default schema is "public" and tenantStrategy is undefined — matches the
  // production path that surfaced the bug in nestjs-linear-clone.
  return connector;
}

describe("PostgresConnector.startTransaction — tenant marker identifier check (#345)", () => {
  let logOutput: string[];

  beforeEach(() => {
    MetadataContext.reset();
    logOutput = [];
    Logger.setOutput((msg) => logOutput.push(msg));
  });

  afterEach(() => {
    MetadataContext.reset();
    Logger.reset();
  });

  it("skips SET LOCAL search_path and warns once when the tenant marker is numeric", async () => {
    const connector = makeConnector();
    const client = makeClient();

    await MetadataContext.run("12345", async () => {
      await connector.startTransaction(client as any);
    });

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(["BEGIN"]);
    expect(sqls.some((s: string) => s.startsWith("SET LOCAL search_path"))).toBe(
      false,
    );

    const warnings = logOutput.filter((m) => m.includes("WARN"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"12345"');
    expect(warnings[0]).toContain("not a valid PostgreSQL identifier");
  });

  it("warns only once per unique invalid tenant marker", async () => {
    const connector = makeConnector();

    for (let i = 0; i < 3; i++) {
      const client = makeClient();
      await MetadataContext.run("12345", async () => {
        await connector.startTransaction(client as any);
      });
    }

    const warnings = logOutput.filter((m) => m.includes("WARN"));
    expect(warnings).toHaveLength(1);
  });

  it("warns separately for each distinct invalid tenant marker", async () => {
    const connector = makeConnector();

    for (const id of ["1", "2", "3"]) {
      const client = makeClient();
      await MetadataContext.run(id, async () => {
        await connector.startTransaction(client as any);
      });
    }

    const warnings = logOutput.filter((m) => m.includes("WARN"));
    expect(warnings).toHaveLength(3);
  });

  it("still issues SET LOCAL search_path when the tenant marker is a valid identifier", async () => {
    const connector = makeConnector();
    const client = makeClient();

    await MetadataContext.run("tenant_42", async () => {
      await connector.startTransaction(client as any);
    });

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(["BEGIN", 'SET LOCAL search_path TO "tenant_42"']);

    const warnings = logOutput.filter((m) => m.includes("WARN"));
    expect(warnings).toHaveLength(0);
  });

  it("does not warn or SET LOCAL when no MetadataContext is active (default 'public')", async () => {
    const connector = makeConnector();
    const client = makeClient();

    await connector.startTransaction(client as any);

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(["BEGIN"]);
    const warnings = logOutput.filter((m) => m.includes("WARN"));
    expect(warnings).toHaveLength(0);
  });
});

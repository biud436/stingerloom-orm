/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { PostgresDataSource } from "../../src/dialects/postgres/PostgresDataSource";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { Logger } from "../../src/utils/Logger";

/**
 * A pooled client that runs statements one at a time in the order they are
 * sent, as `pg` does, and follows search_path the way PostgreSQL does:
 * `SET LOCAL` lasts until the transaction ends and `ROLLBACK TO SAVEPOINT`
 * undoes the ones issued since the savepoint.
 */
class FakeClient {
  readonly sqls: string[] = [];
  /** Each statement that is not BEGIN / SET / SAVEPOINT / COMMIT, with the schema it ran under. */
  readonly ran: Array<[string, string]> = [];
  readonly release = jest.fn();
  private local: string | null = null;
  private savepoints: Array<{ name: string; local: string | null }> = [];
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly sessionPath = "public") {}

  query(text: string | { text: string }): Promise<any> {
    const sql = typeof text === "string" ? text : text.text;
    const turn = this.busy.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      this.apply(sql);
      return { rows: [], rowCount: 0, fields: [] };
    });
    this.busy = turn.catch(() => undefined);
    return turn;
  }

  private apply(sql: string): void {
    this.sqls.push(sql);
    const set = /^SET LOCAL search_path TO "(.+)"$/.exec(sql);
    const savepoint = /^SAVEPOINT "(.+)"$/.exec(sql);
    const rollbackTo = /^ROLLBACK TO SAVEPOINT "(.+)"$/.exec(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      this.local = null;
      this.savepoints = [];
    } else if (set) {
      this.local = set[1];
    } else if (savepoint) {
      this.savepoints.push({ name: savepoint[1], local: this.local });
    } else if (rollbackTo) {
      const index = this.savepoints.map((s) => s.name).lastIndexOf(rollbackTo[1]);
      this.local = this.savepoints[index].local;
      this.savepoints.length = index + 1;
    } else {
      this.ran.push([sql, this.local ?? this.sessionPath]);
    }
  }
}

function setup(options: { tenantStrategy?: string; schema?: string } = {}) {
  const client = new FakeClient(options.schema);
  const connector = new PostgresConnector();
  Object.assign(connector as any, {
    pool: { connect: async () => client },
    tenantStrategy: options.tenantStrategy,
    schema: options.schema ?? "public",
  });
  const ds = new PostgresDataSource(connector);
  return { client, ds };
}

async function begin(ds: PostgresDataSource): Promise<void> {
  await ds.createConnection();
  await ds.startTransaction();
}

const inTenant = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
  MetadataContext.run(tenant, fn) as Promise<T>;

describe("PostgresDataSource — search_path follows the tenant inside a transaction", () => {
  beforeEach(() => {
    MetadataContext.reset();
    Logger.setOutput(() => undefined);
  });

  afterEach(() => {
    MetadataContext.reset();
    Logger.reset();
  });

  it("runs a statement issued under another tenant in that tenant's schema", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await ds.query("SELECT 'acme-1'");
      await inTenant("globex", () => ds.query("SELECT 'globex'"));
      await ds.query("SELECT 'acme-2'");
      await ds.commit();
    });

    expect(client.ran).toEqual([
      ["SELECT 'acme-1'", "acme"],
      ["SELECT 'globex'", "globex"],
      ["SELECT 'acme-2'", "acme"],
    ]);
  });

  it("sends nothing extra while the tenant stays the one the transaction began under", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await ds.query("SELECT 1");
      await inTenant("acme", () => ds.query("SELECT 2"));
      await ds.commit();
    });

    expect(client.sqls).toEqual([
      "BEGIN",
      'SET LOCAL search_path TO "acme"',
      "SELECT 1",
      "SELECT 2",
      "COMMIT",
    ]);
  });

  it("runs tenant work in the tenant's schema in a transaction begun outside any tenant", async () => {
    const { client, ds } = setup();

    await begin(ds);
    await inTenant("acme", () => ds.query("SELECT 'acme'"));
    await ds.query("SELECT 'public'");
    await ds.commit();

    expect(client.ran).toEqual([
      ["SELECT 'acme'", "acme"],
      ["SELECT 'public'", "public"],
    ]);
  });

  it("returns public work to the configured schema", async () => {
    const { client, ds } = setup({ tenantStrategy: "schema_qualified", schema: "app" });

    await inTenant("acme", async () => {
      await begin(ds);
      await inTenant("public", () => ds.query("SELECT 'public'"));
      await ds.commit();
    });

    expect(client.ran).toEqual([["SELECT 'public'", "app"]]);
  });

  it("runs concurrent statements for different tenants each in its own schema", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await Promise.all([
        ds.query("SELECT 'acme-1'"),
        inTenant("globex", () => ds.query("SELECT 'globex-1'")),
        ds.query("SELECT 'acme-2'"),
        inTenant("globex", () => ds.query("SELECT 'globex-2'")),
        inTenant("initech", () => ds.query("SELECT 'initech'")),
      ]);
      await ds.commit();
    });

    expect(client.ran).toEqual([
      ["SELECT 'acme-1'", "acme"],
      ["SELECT 'globex-1'", "globex"],
      ["SELECT 'acme-2'", "acme"],
      ["SELECT 'globex-2'", "globex"],
      ["SELECT 'initech'", "initech"],
    ]);
  });

  it("follows the search_path ROLLBACK TO SAVEPOINT brings back", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await ds.savepoint("sp_1");
      await inTenant("globex", () => ds.query("SELECT 'undone'"));
      await ds.rollbackTo("sp_1");
      await inTenant("globex", () => ds.query("SELECT 'globex'"));
      await ds.query("SELECT 'acme'");
      await ds.commit();
    });

    expect(client.ran).toEqual([
      ["SELECT 'undone'", "globex"],
      ["SELECT 'globex'", "globex"],
      ["SELECT 'acme'", "acme"],
    ]);
  });

  it("keeps a switch made before a savepoint across ROLLBACK TO it", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await inTenant("globex", async () => {
        await ds.query("SELECT 'globex-1'");
        await ds.savepoint("sp_1");
        await ds.rollbackTo("sp_1");
        await ds.query("SELECT 'globex-2'");
      });
      await ds.commit();
    });

    expect(client.ran).toEqual([
      ["SELECT 'globex-1'", "globex"],
      ["SELECT 'globex-2'", "globex"],
    ]);
    expect(client.sqls.filter((s) => s.startsWith("SET LOCAL"))).toEqual([
      'SET LOCAL search_path TO "acme"',
      'SET LOCAL search_path TO "globex"',
    ]);
  });

  it("commits only after the statements queued behind a switch", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      const late = inTenant("globex", () => ds.query("SELECT 'late'"));
      await ds.commit();
      await late;
    });

    expect(client.sqls.slice(-3)).toEqual([
      'SET LOCAL search_path TO "globex"',
      "SELECT 'late'",
      "COMMIT",
    ]);
  });

  it("rolls back only after the statements queued behind a switch", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      const late = inTenant("globex", () => ds.query("SELECT 'late'"));
      await ds.rollback();
      await late;
    });

    expect(client.sqls.slice(-2)).toEqual(["SELECT 'late'", "ROLLBACK"]);
  });

  it("stays on the configured schema for a tenant id that is not an identifier", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await inTenant("12345", () => ds.query("SELECT 'marker'"));
      await ds.commit();
    });

    expect(client.ran).toEqual([["SELECT 'marker'", "public"]]);
  });

  it("leaves search_path alone under tenant_column", async () => {
    const { client, ds } = setup({ tenantStrategy: "tenant_column" });

    await inTenant("acme", async () => {
      await begin(ds);
      await inTenant("globex", () => ds.query("SELECT 'globex'"));
      await ds.commit();
    });

    expect(client.sqls).toEqual(["BEGIN", "SELECT 'globex'", "COMMIT"]);
  });

  it("leaves search_path alone outside a transaction", async () => {
    const { client, ds } = setup();

    await ds.createConnection();
    await inTenant("acme", () => ds.query("SELECT 'acme'"));
    await ds.close();

    expect(client.sqls).toEqual(["SELECT 'acme'"]);
  });

  it("stops following the tenant once the transaction is over", async () => {
    const { client, ds } = setup();

    await inTenant("acme", async () => {
      await begin(ds);
      await ds.commit();
    });
    await ds.createConnection();
    await inTenant("globex", () => ds.query("SELECT 'after'"));

    expect(client.sqls).toEqual([
      "BEGIN",
      'SET LOCAL search_path TO "acme"',
      "COMMIT",
      "SELECT 'after'",
    ]);
  });
});

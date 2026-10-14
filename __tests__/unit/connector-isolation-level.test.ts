/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Which SET TRANSACTION each connector sends when a transaction starts.
 *
 * A requested level must always be sent. The connectors used to skip the
 * SET when the level equaled the database's out-of-the-box default (READ
 * COMMITTED on PostgreSQL, REPEATABLE READ on InnoDB), so on a server or
 * session configured with another default the transaction ran at that
 * default instead. Real-server coverage: integration/transaction-contract-real.
 */
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";
import { MetadataContext } from "../../src/metadata/MetadataContext";

function pgClient(): { query: jest.Mock } {
  return { query: jest.fn(async () => ({ rows: [] })) };
}

/** A callback-style mysql2 connection recording what it is sent. */
function mysqlConnection(): { sent: string[]; conn: any } {
  const sent: string[] = [];
  const conn = {
    query: jest.fn((sql: string, cb: (e: unknown) => void) => {
      sent.push(sql);
      cb(null);
    }),
    beginTransaction: jest.fn((cb: (e: unknown) => void) => {
      sent.push("START TRANSACTION");
      cb(null);
    }),
  };
  return { sent, conn };
}

describe("connector isolation level on transaction start", () => {
  beforeEach(() => MetadataContext.reset());

  describe("PostgresConnector", () => {
    const sent = async (level?: any): Promise<string[]> => {
      const client = pgClient();
      await new PostgresConnector().startTransaction(client as any, level);
      return client.query.mock.calls.map((c) => c[0]);
    };

    it("sends a requested READ COMMITTED even though it is PostgreSQL's default", async () => {
      expect(await sent("READ COMMITTED")).toEqual([
        "BEGIN",
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      ]);
    });

    it("sends any other requested level after BEGIN", async () => {
      expect(await sent("SERIALIZABLE")).toEqual([
        "BEGIN",
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      ]);
    });

    it("sends no SET when no level is requested", async () => {
      expect(await sent()).toEqual(["BEGIN"]);
    });
  });

  describe("MySqlConnector", () => {
    const sent = async (level?: any): Promise<string[]> => {
      const { sent, conn } = mysqlConnection();
      await new MySqlConnector().startTransaction(conn, level);
      return sent;
    };

    it("sends a requested REPEATABLE READ even though it is InnoDB's default", async () => {
      expect(await sent("REPEATABLE READ")).toEqual([
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
        "START TRANSACTION",
      ]);
    });

    it("sets READ COMMITTED before START TRANSACTION when no level is requested", async () => {
      expect(await sent()).toEqual([
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        "START TRANSACTION",
      ]);
    });
  });
});

/**
 * Read replicas on a real PostgreSQL / MySQL (MariaDB): each node gets one
 * connection pool that every read routed to it shares, propagateShutdown()
 * closes those pools, and the configured health checks take a node that
 * cannot be reached out of the rotation. The replica nodes point at the
 * test server itself.
 */

import "reflect-metadata";
import { createTestConnection, dropTestTable, type TestConnectionResult } from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import type { ReplicationNodeConfig } from "../../src/dialects/ReplicationRouter";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { MySqlConnector } from "../../src/dialects/mysql/MySqlConnector";

interface NoteRow {
  id: number;
  body: string;
}

function nodeOf(options: TestDriverConfig["options"]): ReplicationNodeConfig {
  const server = options as Record<string, any>;
  return {
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
    database: server.database,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.each(getTestDrivers())(
  "[Integration] $label: read replica node pools",
  ({ type, options }: TestDriverConfig) => {
    const table = `rnp_note_${String(Date.now()).slice(-6)}`;
    const Connector = type === "postgres" ? PostgresConnector : MySqlConnector;
    let conn: TestConnectionResult | undefined;
    let Note: new () => NoteRow;

    async function connectWithReplication(slaves: ReplicationNodeConfig[], healthCheck?: object) {
      conn = await createTestConnection(
        {
          ...options,
          synchronize: true,
          logging: false,
          replication: { master: nodeOf(options), slaves, ...(healthCheck ? { healthCheck } : {}) },
        } as any,
        () => {
          @Entity({ name: table })
          class ReplicaNote {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) body!: string;
          }
          Note = ReplicaNote;
          return { entities: [ReplicaNote] };
        },
      );
      await conn.em.save(Note, { body: "first" });
      return conn.em;
    }

    afterEach(async () => {
      jest.restoreAllMocks();
      if (!conn) return;
      await conn.em.propagateShutdown();
      await dropTestTable(table);
      await conn.cleanup();
      conn = undefined;
    }, 30000);

    it("opens one pool per node and closes it on shutdown", async () => {
      const em = await connectWithReplication([nodeOf(options), nodeOf(options)]);
      const connect = jest.spyOn(Connector.prototype, "connect");
      const close = jest.spyOn(Connector.prototype, "close");

      for (let i = 0; i < 20; i++) {
        expect((await em.find(Note)).map((row) => row.body)).toEqual(["first"]);
      }
      await em.findOne(Note, { where: { body: "first" }, useMaster: true });

      // Two slaves and the master, each opened once.
      expect(connect).toHaveBeenCalledTimes(3);
      expect(close).not.toHaveBeenCalled();

      await em.propagateShutdown();
      expect(close).toHaveBeenCalledTimes(3);
    }, 60000);

    it("takes a node that fails its health check out of the rotation", async () => {
      const unreachable = { ...nodeOf(options), host: "127.0.0.1", port: 1 };
      const em = await connectWithReplication([unreachable, nodeOf(options)], {
        enabled: true,
        intervalMs: 50,
        failureThreshold: 1,
      });
      const router = em.getReplicationRouter()!;

      await waitFor(() => router.healthySlaveCount === 1, 10000);

      for (let i = 0; i < 6; i++) {
        expect((await em.find(Note)).map((row) => row.body)).toEqual(["first"]);
      }
    }, 60000);
  },
);

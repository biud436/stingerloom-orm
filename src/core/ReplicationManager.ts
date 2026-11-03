import {
  ReplicationRouter,
  ReplicationNodeConfig,
  ReplicationConfig,
} from "../dialects/ReplicationRouter";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import {
  assertReplicationSupported,
  connectReplicationNode,
} from "../dialects/connectReplicationNode";
import type { DatabaseClientOptions } from "./DatabaseClientOptions";
import type { IConnector } from "./IConnector";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Logger } from "../utils";

/**
 * Encapsulates the replication-routing lifecycle.
 * Wraps ReplicationRouter and handles initialization, teardown, and null checks.
 *
 * It also owns one connection pool per node: the first read routed to a node
 * opens it, later reads and health checks share it, and {@link shutdown}
 * closes it.
 */
export class ReplicationManager {
  private readonly logger = new Logger(ReplicationManager.name);
  private router: ReplicationRouter | null = null;
  private connectionOptions: DatabaseClientOptions | null = null;
  /** Keyed by the node's config object, which the router hands out as is. */
  private nodePools = new Map<ReplicationNodeConfig, Promise<IConnector>>();

  initialize(config: ReplicationConfig, options: DatabaseClientOptions): void {
    assertReplicationSupported(options.type);
    // Registering again replaces the previous router and its node pools.
    void this.release();

    this.router = new ReplicationRouter(config);
    this.connectionOptions = options;
    // A no-op unless `healthCheck.enabled` is set.
    this.router.startHealthCheck((node, query) => this.ping(node, query));
  }

  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null {
    if (!this.router) return null;
    if (useMaster) return this.router.getWriteNode();
    return this.router.getReadNode();
  }

  getWriteNode(): ReplicationNodeConfig | null {
    if (!this.router) return null;
    return this.router.getWriteNode();
  }

  get isEnabled(): boolean {
    return this.router !== null;
  }

  getRouter(): ReplicationRouter | null {
    return this.router;
  }

  /**
   * Checks a connection to `node` out of the node's pool into `session`,
   * opening the pool on first use.
   */
  async connectSession(
    session: TransactionSessionManager,
    node: ReplicationNodeConfig,
  ): Promise<void> {
    const options = this.connectionOptions;
    if (!options) {
      throw new OrmError(
        OrmErrorCode.NOT_CONNECTED,
        `Replication is shut down; cannot connect to ${node.host}:${node.port}.`,
      );
    }
    await session.connectWith(await this.nodePool(node, options), options.type);
  }

  private nodePool(
    node: ReplicationNodeConfig,
    options: DatabaseClientOptions,
  ): Promise<IConnector> {
    const pools = this.nodePools;
    let pool = pools.get(node);
    if (!pool) {
      pool = connectReplicationNode(options.type, options, node);
      pools.set(node, pool);
      // A pool that failed to open is dropped so the next read retries it.
      const opening = pool;
      opening.catch(() => {
        if (pools.get(node) === opening) pools.delete(node);
      });
    }
    return pool;
  }

  private async ping(node: ReplicationNodeConfig, query: string): Promise<void> {
    const session = new TransactionSessionManager();
    await this.connectSession(session, node);
    try {
      await session.query(query);
    } finally {
      await session.close();
    }
  }

  /**
   * Stops health checks, drops the router and closes every node pool.
   */
  async shutdown(): Promise<void> {
    await this.release();
  }

  private release(): Promise<void> {
    if (this.router) {
      // Stop the health-check interval before dropping the reference, otherwise
      // the timer can never be cleared once the router is unreachable.
      this.router.stopHealthCheck();
      this.router.resetFailedSlaves();
      this.router = null;
    }
    this.connectionOptions = null;

    const pools = [...this.nodePools.values()];
    this.nodePools = new Map();
    return Promise.all(
      pools.map(async (opening) => {
        let pool: IConnector;
        try {
          pool = await opening;
        } catch {
          return; // never opened
        }
        try {
          await pool.close();
        } catch (error) {
          this.logger.warn(`failed to close a replication node pool: ${error}`);
        }
      }),
    ).then(() => undefined);
  }
}

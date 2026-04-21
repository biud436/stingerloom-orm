/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { SslOptions } from "../core/DatabaseClientOptions";

/**
 * Connection info for a single DB node.
 */
export interface ReplicationNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** SSL/TLS for this specific node. Overrides the top-level ssl setting. */
  ssl?: boolean | SslOptions;
}

/**
 * Health check configuration for read replicas.
 */
export interface HealthCheckConfig {
  /** Enable automatic health checks. Default: false */
  enabled: boolean;
  /** Interval in milliseconds between health checks. Default: 5000 */
  intervalMs?: number;
  /** SQL query used for health check. Default: "SELECT 1" */
  query?: string;
  /** Number of consecutive failures before marking slave as failed. Default: 3 */
  failureThreshold?: number;
  /** Number of consecutive successes before marking slave as recovered. Default: 2 */
  recoveryThreshold?: number;
}

/**
 * Routing strategy for read queries.
 */
export type ReplicationStrategy = "round-robin" | "random";

/**
 * Replication configuration.
 */
export interface ReplicationConfig {
  /** Write (master) node configuration */
  master: ReplicationNodeConfig;

  /** List of read (slave) nodes */
  slaves: ReplicationNodeConfig[];

  /** Health check configuration */
  healthCheck?: HealthCheckConfig;

  /** Routing strategy for read queries. Default: "round-robin" */
  strategy?: ReplicationStrategy;
}

/**
 * Function type for executing a health check query against a node.
 */
export type HealthCheckFn = (node: ReplicationNodeConfig, query: string) => Promise<void>;

/**
 * Router for read/write splitting.
 *
 * - Writes (INSERT/UPDATE/DELETE): always routed to master
 * - Reads (SELECT): round-robin over slaves, falls back to master if a slave fails
 *
 * ReplicationRouter does not manage connections itself;
 * it only decides which node configuration to use.
 */
export class ReplicationRouter {
  private readonly logger = new Logger(ReplicationRouter.name);
  private readonly master: ReplicationNodeConfig;
  private readonly slaves: ReplicationNodeConfig[];
  private slaveIndex = 0;
  private readonly failedSlaves = new Set<number>();
  private readonly strategy: ReplicationStrategy;

  // Health check state
  private readonly healthCheckConfig: HealthCheckConfig | undefined;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private healthCheckFn: HealthCheckFn | undefined;
  private readonly consecutiveFailures: Map<number, number> = new Map();
  private readonly consecutiveSuccesses: Map<number, number> = new Map();

  constructor(config: ReplicationConfig) {
    if (!config.master) {
      throw new OrmError(
        OrmErrorCode.VALIDATION_FAILED,
        "Replication master configuration is required.",
        "Provide a 'master' node in the replication config",
      );
    }
    if (!config.slaves || config.slaves.length === 0) {
      throw new OrmError(
        OrmErrorCode.VALIDATION_FAILED,
        "At least one slave is required for replication configuration.",
        "Provide at least one 'slave' node in the replication config",
      );
    }

    this.master = config.master;
    this.slaves = config.slaves;
    this.strategy = config.strategy ?? "round-robin";
    this.healthCheckConfig = config.healthCheck;
  }

  /**
   * Start automatic health checks. Requires a function to execute
   * a query against a node (provided by the driver layer).
   */
  startHealthCheck(fn: HealthCheckFn): void {
    if (!this.healthCheckConfig?.enabled) return;

    this.healthCheckFn = fn;
    const intervalMs = this.healthCheckConfig.intervalMs ?? 5000;

    this.healthCheckTimer = setInterval(() => {
      void this.runHealthChecks();
    }, intervalMs);
  }

  /**
   * Stop the automatic health check timer.
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    this.healthCheckFn = undefined;
  }

  /**
   * Run a single health check cycle against all slaves.
   */
  async runHealthChecks(): Promise<void> {
    if (!this.healthCheckFn) return;

    const query = this.healthCheckConfig?.query ?? "SELECT 1";
    const failureThreshold = this.healthCheckConfig?.failureThreshold ?? 3;
    const recoveryThreshold = this.healthCheckConfig?.recoveryThreshold ?? 2;

    await Promise.all(
      this.slaves.map(async (slave, idx) => {
        try {
          await this.healthCheckFn!(slave, query);

          // Reset failure counter, increment success counter
          this.consecutiveFailures.set(idx, 0);
          const successes = (this.consecutiveSuccesses.get(idx) ?? 0) + 1;
          this.consecutiveSuccesses.set(idx, successes);

          // Auto-recover if threshold reached
          if (this.failedSlaves.has(idx) && successes >= recoveryThreshold) {
            this.failedSlaves.delete(idx);
            this.consecutiveSuccesses.set(idx, 0);
            this.logger.info(
              `Slave ${slave.host}:${slave.port} recovered after ${recoveryThreshold} successful checks.`,
            );
          }
        } catch {
          // Reset success counter, increment failure counter
          this.consecutiveSuccesses.set(idx, 0);
          const failures = (this.consecutiveFailures.get(idx) ?? 0) + 1;
          this.consecutiveFailures.set(idx, failures);

          // Mark as failed if threshold reached
          if (!this.failedSlaves.has(idx) && failures >= failureThreshold) {
            this.failedSlaves.add(idx);
            this.logger.warn(
              `Slave ${slave.host}:${slave.port} marked as failed after ${failureThreshold} consecutive failures.`,
            );
          }
        }
      }),
    );
  }

  /**
   * Returns the master node configuration for writes.
   */
  getWriteNode(): ReplicationNodeConfig {
    return this.master;
  }

  /**
   * Returns a slave node configuration for reads.
   * Falls back to master if every slave is marked as failed.
   */
  getReadNode(): ReplicationNodeConfig {
    // Fall back to master when all slaves have failed
    if (this.failedSlaves.size >= this.slaves.length) {
      this.logger.warn(
        "All slaves are marked as failed. Falling back to master for reads.",
      );
      return this.master;
    }

    if (this.strategy === "random") {
      return this.getReadNodeRandom();
    }

    return this.getReadNodeRoundRobin();
  }

  private getReadNodeRoundRobin(): ReplicationNodeConfig {
    const startIdx = this.slaveIndex;
    for (let i = 0; i < this.slaves.length; i++) {
      const idx = (startIdx + i) % this.slaves.length;
      if (!this.failedSlaves.has(idx)) {
        this.slaveIndex = (idx + 1) % this.slaves.length;
        return this.slaves[idx];
      }
    }
    return this.master;
  }

  private getReadNodeRandom(): ReplicationNodeConfig {
    const healthyIndices: number[] = [];
    for (let i = 0; i < this.slaves.length; i++) {
      if (!this.failedSlaves.has(i)) {
        healthyIndices.push(i);
      }
    }
    if (healthyIndices.length === 0) return this.master;
    const pick = healthyIndices[Math.floor(Math.random() * healthyIndices.length)];
    return this.slaves[pick];
  }

  /**
   * Marks a slave as failed.
   */
  markSlaveFailed(node: ReplicationNodeConfig): void {
    const idx = this.slaves.indexOf(node);
    if (idx !== -1) {
      this.failedSlaves.add(idx);
      this.logger.warn(
        `Slave ${node.host}:${node.port} marked as failed. (${this.failedSlaves.size}/${this.slaves.length} failed)`,
      );
    }
  }

  /**
   * Restores a slave from the failed state.
   */
  markSlaveRecovered(node: ReplicationNodeConfig): void {
    const idx = this.slaves.indexOf(node);
    if (idx !== -1) {
      this.failedSlaves.delete(idx);
    }
  }

  /**
   * Clears the failed state for every slave.
   */
  resetFailedSlaves(): void {
    this.failedSlaves.clear();
  }

  /**
   * Checks whether the given node is the master.
   */
  isMaster(node: ReplicationNodeConfig): boolean {
    return node === this.master;
  }

  /**
   * Returns the current slave count.
   */
  get slaveCount(): number {
    return this.slaves.length;
  }

  /**
   * Returns the number of healthy (non-failed) slaves.
   */
  get healthySlaveCount(): number {
    return this.slaves.length - this.failedSlaves.size;
  }
}

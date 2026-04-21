import {
  ReplicationRouter,
  ReplicationNodeConfig,
  ReplicationConfig,
} from "../dialects/ReplicationRouter";

/**
 * Encapsulates the replication-routing lifecycle.
 * Wraps ReplicationRouter and handles initialization, teardown, and null checks.
 */
export class ReplicationManager {
  private router: ReplicationRouter | null = null;

  initialize(config: ReplicationConfig): void {
    this.router = new ReplicationRouter(config);
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

  shutdown(): void {
    if (this.router) {
      this.router.resetFailedSlaves();
      this.router = null;
    }
  }
}

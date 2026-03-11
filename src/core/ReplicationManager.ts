import {
  ReplicationRouter,
  ReplicationNodeConfig,
  ReplicationConfig,
} from "../dialects/ReplicationRouter";

/**
 * 복제 라우팅 라이프사이클 캡슐화.
 * ReplicationRouter를 감싸고 초기화/정리/null 체크를 담당합니다.
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

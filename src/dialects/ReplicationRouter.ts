/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * 단일 DB 노드의 연결 정보
 */
export interface ReplicationNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

/**
 * Replication 설정
 */
export interface ReplicationConfig {
  /** 쓰기(master) 노드 설정 */
  master: ReplicationNodeConfig;

  /** 읽기(slave) 노드 목록 */
  slaves: ReplicationNodeConfig[];
}

/**
 * 읽기/쓰기 분리를 위한 라우터.
 *
 * - 쓰기(INSERT/UPDATE/DELETE): 항상 master
 * - 읽기(SELECT): slave 라운드 로빈, slave 실패 시 master fallback
 *
 * ReplicationRouter는 연결 자체를 관리하지 않고,
 * 어떤 노드 설정을 사용할지 결정하는 역할만 수행합니다.
 */
export class ReplicationRouter {
  private readonly logger = new Logger(ReplicationRouter.name);
  private readonly master: ReplicationNodeConfig;
  private readonly slaves: ReplicationNodeConfig[];
  private slaveIndex = 0;
  private readonly failedSlaves = new Set<number>();

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
  }

  /**
   * 쓰기용 master 노드 설정을 반환합니다.
   */
  getWriteNode(): ReplicationNodeConfig {
    return this.master;
  }

  /**
   * 읽기용 slave 노드 설정을 라운드 로빈으로 반환합니다.
   * 모든 slave가 실패 상태이면 master로 fallback합니다.
   */
  getReadNode(): ReplicationNodeConfig {
    // 모든 slave가 실패한 경우 master fallback
    if (this.failedSlaves.size >= this.slaves.length) {
      this.logger.warn(
        "All slaves are marked as failed. Falling back to master for reads.",
      );
      return this.master;
    }

    // 라운드 로빈으로 건강한 slave 선택
    const startIdx = this.slaveIndex;
    for (let i = 0; i < this.slaves.length; i++) {
      const idx = (startIdx + i) % this.slaves.length;
      if (!this.failedSlaves.has(idx)) {
        this.slaveIndex = (idx + 1) % this.slaves.length;
        return this.slaves[idx];
      }
    }

    // 도달 불가 (위 guard에서 처리됨)
    return this.master;
  }

  /**
   * slave를 실패 상태로 표시합니다.
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
   * slave의 실패 상태를 복구합니다.
   */
  markSlaveRecovered(node: ReplicationNodeConfig): void {
    const idx = this.slaves.indexOf(node);
    if (idx !== -1) {
      this.failedSlaves.delete(idx);
    }
  }

  /**
   * 모든 slave의 실패 상태를 초기화합니다.
   */
  resetFailedSlaves(): void {
    this.failedSlaves.clear();
  }

  /**
   * master 노드인지 확인합니다.
   */
  isMaster(node: ReplicationNodeConfig): boolean {
    return node === this.master;
  }

  /**
   * 현재 slave 수를 반환합니다.
   */
  get slaveCount(): number {
    return this.slaves.length;
  }

  /**
   * 건강한(실패하지 않은) slave 수를 반환합니다.
   */
  get healthySlaveCount(): number {
    return this.slaves.length - this.failedSlaves.size;
  }
}

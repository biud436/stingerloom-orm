/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { ISqlDriver } from "../dialects/SqlDriver";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, WhereClause } from "../dialects/FindOption";
import { ReplicationNodeConfig } from "../dialects/ReplicationRouter";
import { DeleteResult } from "../types/DeleteResult";
import { EntityResult } from "../types/EntityResult";
import { ISelectOption } from "../dialects/ISelectOption";
import { SchemaDialect } from "./generators/SchemaGenerator";

/**
 * EntityManager의 내부 기능을 추출된 핸들러 클래스들에게 노출하는 인터페이스.
 * 순환 참조 방지를 위해 EntityManager 대신 이 인터페이스를 의존합니다.
 *
 * @internal 패키지 내부 전용 — 공개 API가 아닙니다.
 */
export interface EntityManagerInternals {
  wrap(col: string): string;
  wrapTable(tableName: string): string;
  isMySqlFamily(): boolean;
  isPostgres(): boolean;
  getDriver(): ISqlDriver | undefined;
  getSynchronize(): boolean | "safe" | "dry-run";
  getDialect(): SchemaDialect;
  getSchema(): string | undefined;
  getConnection(): { query: (sql: any) => Promise<any> } | undefined;
  executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
  ): Promise<R>;
  executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R>;
  beginTrackQuery(): void;
  trackQuery(entityName: string, sql: string, ms: number): void;
  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null;
  getEntities(): ClazzType<any>[];
  getNameStrategy<T>(clazz: ClazzType<T>): string;
  resolveSelectColumns<T>(select: ISelectOption<T>): string[];
  markDirty(entity: any): void;

  // RelationLoader 용
  findInternal<T>(
    entity: ClazzType<T>,
    opt: FindOption<T>,
    session?: TransactionSessionManager,
  ): Promise<EntityResult<T>>;
  findOneInternal<T>(
    entity: ClazzType<T>,
    opt: FindOption<T>,
    session?: TransactionSessionManager,
  ): Promise<T | null>;

  // CascadeHandler 용
  save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>>;
  saveWithSession<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    session: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>>;
  find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T[]>;
  delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;
}

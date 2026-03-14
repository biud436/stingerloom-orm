/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { FindOption, WhereClause } from "../dialects/FindOption";
import { BaseRepository } from "./BaseRepository";
import { DeleteResult } from "../types/DeleteResult";
import { DatabaseClientOptions } from "./DatabaseClientOptions";
import { Sql } from "sql-template-tag";
import {
  CursorPaginationOption,
  CursorPaginationResult,
} from "./CursorPagination";

export abstract class BaseEntityManager {
  /**
   * 이 메서드는 데이터베이스에 연결하고 엔티티를 등록합니다.
   * 엔티티 등록이라 함은 데이터베이스에 테이블을 생성하거나 업데이트하는 작업을 의미합니다.
   * 이를 동기화 작업이라고 부릅니다.
   *
   * 이 메서드는 애플리케이션이 시작될 때 한 번만 호출되어야 합니다.
   * RDBMS의 경우, 동기화를 위해 DDL 명령이 수행될 수 있으므로 주의가 필요합니다.
   */
  abstract register(
    databaseClientOptions: DatabaseClientOptions,
  ): Promise<void>;

  /**
   * 데이터베이스에 연결합니다.
   * 가용할 데이터베이스 드라이버에 연결하고 데이터소스를 만듭니다.
   */
  abstract connect(databaseClientOptions: DatabaseClientOptions): Promise<void>;

  /**
   * 소멸자로 주로 메모리 해제 작업을 수행합니다.
   * 서버가 어떠한 이유로 인해 종료될 때 호출됩니다.
   * 통합 테스트 환경에서는 이 메서드가 빈번하게 호출될 수 있습니다.
   */
  abstract propagateShutdown(options?: {
    gracefulTimeoutMs?: number;
    closeConnections?: boolean;
  }): Promise<boolean>;

  /**
   * 데이터베이스 쿼리를 수행하여 결과를 1건 반환합니다.
   * 쿼리는 where, order by, limit 절을 포함할 수 있습니다.
   * @param entity
   * @param findOption
   */
  abstract findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null>;

  /**
   * 데이터베이스 쿼리를 수행하여 결과를 여러 건 반환합니다.
   * 쿼리는 where, order by, limit 절을 포함할 수 있습니다.
   * @param entity
   * @param findOption
   */
  abstract find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T[]>;

  /**
   * 커서 기반 페이지네이션으로 엔티티를 조회합니다.
   *
   * @param entity 엔티티 클래스
   * @param option 커서 페이지네이션 옵션
   * @returns 페이지네이션 결과 (data, hasNextPage, nextCursor, count)
   */
  abstract findWithCursor<T>(
    entity: ClazzType<T>,
    option?: CursorPaginationOption<T>,
  ): Promise<CursorPaginationResult<T>>;

  /**
   * 데이터베이스에 데이터를 저장하거나 수정합니다.
   * 수정 시에는 PK 컬럼이 존재해야하고, 없을 경우 저장 작업을 수행합니다.
   *
   * 본 ORM에는 아직 영속성 컨텍스트 같은 1차 캐시 스토어가 없습니다.
   * 따라서 저장이나 변경 수행 시, dirty checking을 수행하지 않습니다.
   *
   * 따라서 본 메서드가 호출되면 데이터베이스에 즉시 반영됩니다.
   *
   * @param entity
   * @param item
   */
  abstract save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>>;

  /**
   * 주어진 조건에 맞는 엔티티를 데이터베이스에서 삭제합니다.
   *
   * @param entity 삭제할 엔티티 클래스
   * @param criteria WHERE 조건 (FindOption의 where와 동일한 형태)
   * @returns 삭제된 행 수를 포함하는 DeleteResult
   */
  abstract delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * 여러 엔티티를 PK 목록으로 일괄 삭제합니다.
   * DELETE FROM table WHERE pk IN (?, ?, ...) 단일 쿼리로 수행합니다.
   *
   * @param entity 엔티티 클래스
   * @param ids 삭제할 PK 값 배열
   * @returns 삭제된 행 수를 포함하는 DeleteResult
   */
  abstract deleteMany<T>(
    entity: ClazzType<T>,
    ids: any[],
  ): Promise<DeleteResult>;

  /**
   * 주어진 Entity에 해당하는 Repository를 반환합니다.
   * 본 ORM은 Active Record Pattern은 지원하지 않기 떄문에,
   * Repository를 통하는 Data Mapper Pattern을 이용해야 합니다.
   */
  /**
   * @DeletedAt 컬럼이 있는 엔티티에 대해 soft delete를 수행합니다.
   * deleted_at 컬럼을 현재 시각으로 UPDATE합니다.
   *
   * @param entity 엔티티 클래스
   * @param criteria WHERE 조건
   * @returns 영향받은 행 수를 포함하는 DeleteResult
   */
  abstract softDelete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * soft delete된 엔티티를 복원합니다.
   * deleted_at 컬럼을 NULL로 UPDATE합니다.
   *
   * @param entity 엔티티 클래스
   * @param criteria WHERE 조건
   * @returns 영향받은 행 수를 포함하는 DeleteResult
   */
  abstract restore<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;

  /**
   * 임의의 SQL 쿼리를 실행하고 결과를 제네릭 타입 T[]로 반환합니다.
   *
   * @param sqlQuery 실행할 SQL 문자열 또는 sql-template-tag Sql 객체
   * @param params SQL 문자열 사용 시 바인딩할 파라미터 배열
   * @returns 쿼리 결과를 T[] 타입으로 반환
   */
  abstract query<T = Record<string, unknown>>(
    sqlQuery: string | Sql,
    params?: unknown[],
  ): Promise<T[]>;

  /**
   * 엔티티 목록과 전체 개수를 동시에 반환합니다.
   * [entities, totalCount] 형태로 반환하며, count는 take/limit을 무시한 전체 수입니다.
   *
   * @param entity 엔티티 클래스
   * @param findOption 검색 옵션
   * @returns [엔티티 배열, 전체 개수] 튜플
   */
  abstract findAndCount<T>(
    entity: ClazzType<T>,
    findOption?: FindOption<T>,
  ): Promise<[T[], number]>;

  abstract getRepository<T>(entity: ClazzType<T>): BaseRepository<T>;

  /**
   * 특정 테넌트 컨텍스트 내에서 작업을 실행합니다.
   * AsyncLocalStorage를 사용하여 콜백 내부의 모든 메타데이터 조회가
   * 해당 테넌트의 레이어에서 수행됩니다.
   *
   * @param tenantId 테넌트 식별자
   * @param callback 테넌트 컨텍스트 내에서 실행할 비동기 작업
   * @returns 콜백의 반환값
   *
   * @example
   * ```ts
   * const result = await entityManager.withTenant("tenant_1", async (em) => {
   *   return em.find(User, { where: { id: 1 } });
   * });
   * ```
   */
  /**
   * Updates multiple entities matching the WHERE condition with the given data.
   * Returns the number of affected rows.
   */
  /**
   * Executes a callback within a database transaction.
   * Auto-commits on success, auto-rollbacks on error.
   */
  abstract transaction<R>(callback: (em: this) => Promise<R>): Promise<R>;

  abstract updateMany<T>(
    entity: ClazzType<T>,
    data: Partial<T>,
    options: { where: WhereClause<T> },
  ): Promise<{ affected: number }>;

  abstract withTenant<R>(
    tenantId: string,
    callback: (em: this) => Promise<R>,
  ): Promise<R>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 커서 기반 페이지네이션 옵션
 *
 * offset 방식 대신 정렬 컬럼의 마지막 값을 커서로 사용하여
 * 대량 데이터셋에서도 일정한 성능을 보장합니다.
 *
 * @template T - 엔티티 타입
 */
export type CursorPaginationOption<T> = {
  /**
   * 한 페이지에 가져올 항목 수 (기본값: 20)
   */
  take?: number;

  /**
   * 이전 페이지의 마지막 커서 (Base64 인코딩)
   * 첫 페이지 요청 시 생략합니다.
   */
  cursor?: string;

  /**
   * 정렬 기준 컬럼 (기본값: 엔티티의 PK)
   */
  orderBy?: keyof T & string;

  /**
   * 정렬 방향 (기본값: "ASC")
   */
  direction?: "ASC" | "DESC";

  /**
   * 추가 WHERE 조건
   */
  where?: {
    [K in keyof T]?: T[K];
  };
};

/**
 * 커서 기반 페이지네이션 결과
 *
 * @template T - 엔티티 타입
 */
export type CursorPaginationResult<T> = {
  /**
   * 현재 페이지의 데이터 배열
   */
  data: T[];

  /**
   * 다음 페이지가 존재하는지 여부
   */
  hasNextPage: boolean;

  /**
   * 다음 페이지 요청 시 사용할 커서 (Base64 인코딩)
   * hasNextPage가 false이면 null
   */
  nextCursor: string | null;

  /**
   * 현재 페이지의 항목 수
   */
  count: number;
};

const DEFAULT_PAGE_SIZE = 20;

/**
 * 커서 값을 Base64로 인코딩합니다.
 */
export function encodeCursor(value: unknown): string {
  const payload = JSON.stringify({ v: value });
  return Buffer.from(payload, "utf-8").toString("base64");
}

/**
 * Base64 커서를 디코딩하여 원래 값으로 복원합니다.
 * 잘못된 커서는 null을 반환합니다.
 */
export function decodeCursor(cursor: string): unknown | null {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return parsed.v;
  } catch {
    return null;
  }
}

/**
 * CursorPaginationOption의 take를 정규화합니다.
 */
export function normalizePageSize(take?: number): number {
  if (take === undefined || take === null || take <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return take;
}

/**
 * Cascade 작업 유형을 정의합니다.
 *
 * - "insert": 부모 엔티티 저장 시 자식 엔티티도 함께 저장
 * - "update": 부모 엔티티 수정 시 자식 엔티티도 함께 수정
 * - "delete": 부모 엔티티 삭제 시 자식 엔티티도 함께 삭제
 * - "remove": "delete"의 별칭 (하위 호환)
 */
export type CascadeType = "insert" | "update" | "delete" | "remove";

/**
 * Cascade 옵션: true이면 모든 cascade 적용, 배열이면 선택적 적용
 */
export type CascadeOption = boolean | CascadeType[];

/**
 * CascadeOption을 정규화하여 CascadeType 배열로 변환합니다.
 * - true → ["insert", "update", "delete"]
 * - false / undefined → []
 * - 배열 → 그대로 반환 ("remove"는 "delete"로 정규화)
 */
export function normalizeCascade(
  cascade: CascadeOption | undefined,
): CascadeType[] {
  if (cascade === undefined || cascade === false) return [];
  if (cascade === true) return ["insert", "update", "delete"];
  return cascade.map((c) => (c === "remove" ? "delete" : c));
}

/**
 * 주어진 cascade 옵션에 특정 작업이 포함되어 있는지 확인합니다.
 * "remove"와 "delete"를 동일하게 취급합니다.
 */
export function hasCascade(
  cascade: CascadeOption | undefined,
  type: CascadeType,
): boolean {
  const normalized = normalizeCascade(cascade);
  if (type === "delete" || type === "remove") {
    return normalized.includes("delete") || normalized.includes("remove");
  }
  return normalized.includes(type);
}

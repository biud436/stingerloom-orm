/**
 * Cascade 작업 유형을 정의합니다.
 *
 * - "insert": 부모 엔티티 저장 시 자식 엔티티도 함께 저장
 * - "update": 부모 엔티티 수정 시 자식 엔티티도 함께 수정
 * - "remove": 부모 엔티티 삭제 시 자식 엔티티도 함께 삭제
 */
export type CascadeType = "insert" | "update" | "remove";
